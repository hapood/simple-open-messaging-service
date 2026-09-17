import { groupStateSql } from '../group/shared/group-state.js';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { readThreadHeadSnapshotInTx } from './federation-thread-head-snapshot.js';
import { PeerStateFeedService } from './peer-state-feed.service.js';

interface ThreadContentProjection {
  account: string;
  peerAccount?: string;
  messageEndSeq: number;
  tombstoneEndSeq: number;
  /** The group's canonical Meta coordinate, carried by group-authored heads only.
   * A mirror reporting back to its origin must not publish this coordinate. */
  groupMetaFeedEndId?: number;
}

@Injectable()
export class FederationThreadContentHeadService {
  constructor(private readonly stateFeed: PeerStateFeedService) {}

  /** Project the currently authorized content coordinate into the durable peer
   * State Feed. A candidate route that cannot publish a head returns false. */
  async projectCurrentInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
    namespaceId: number,
    threadId: number,
  ): Promise<boolean> {
    const projection = await this.readProjectionInTx(
      tx,
      peerDomain,
      namespaceId,
      threadId,
    );
    if (!projection) return false;
    await this.stateFeed.writeManyInTx(tx, [
      {
        peerDomain,
        namespaceId,
        account: projection.account,
        domain: 'local',
        eventType: 'THREAD_CONTENT_HEAD',
        subjectAccount: projection.peerAccount ?? '',
        subjectDomain: projection.peerAccount ? peerDomain : 'local',
        body: {
          messageEndSeq: projection.messageEndSeq,
          tombstoneEndSeq: projection.tombstoneEndSeq,
          ...(projection.groupMetaFeedEndId === undefined
            ? {}
            : { groupMetaFeedEndId: projection.groupMetaFeedEndId }),
        },
      },
    ]);
    return true;
  }

  private async readProjectionInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
    namespaceId: number,
    threadId: number,
  ): Promise<ThreadContentProjection | null> {
    const threadResult = await tx.execute<{
      threadType: 'P2P' | 'GROUP';
      groupAccount: string | null;
      groupDomain: string | null;
      groupNamespaceId: number | null;
    }>(sql`
      SELECT thread.type AS "threadType",
             group_state.account AS "groupAccount",
             group_state.domain AS "groupDomain",
             group_state."namespaceId" AS "groupNamespaceId"
      FROM "MessageThread" thread
      LEFT JOIN ${groupStateSql} group_state ON group_state.id = thread.id
      WHERE thread.id = ${threadId}
      LIMIT 1
      FOR SHARE OF thread
    `);
    const thread = threadResult.rows[0];
    if (!thread) return null;

    const result = await tx.execute<{
      messageAccessAfterSeq: number;
      account: string | null;
      peerAccount: string | null;
    }>(sql`
      SELECT COALESCE(audience."messageAccessAfterSeq", 0) AS "messageAccessAfterSeq",
             CASE
               WHEN pair."endpointADomain" = 'local' THEN pair."endpointAAccount"
               WHEN pair."endpointBDomain" = 'local' THEN pair."endpointBAccount"
             END AS account,
             CASE
               WHEN pair."endpointADomain" = ${peerDomain} THEN pair."endpointAAccount"
               WHEN pair."endpointBDomain" = ${peerDomain} THEN pair."endpointBAccount"
             END AS "peerAccount"
      FROM "MessageThread" message_thread
      LEFT JOIN "ThreadAudience" audience
        ON audience."threadId" = message_thread.id
       AND audience."targetDomain" = ${peerDomain}
       AND audience."targetNamespaceId" = ${namespaceId}
       AND audience."localUserId" IS NULL
      LEFT JOIN "RelationshipPair" pair
        ON pair."threadId" = message_thread.id
       AND pair.kind = 'P2P'
       AND pair.active = true
      WHERE message_thread.id = ${threadId}
        AND (
          (audience."threadId" IS NOT NULL
            AND ((${thread.threadType} = 'P2P' AND pair.id IS NOT NULL)
              OR (${thread.threadType} = 'GROUP'
                AND ${thread.groupDomain} = 'local'
                AND EXISTS (
                  SELECT 1
                  FROM "RelationshipPair" member_pair
                  WHERE member_pair."threadId" = message_thread.id
                    AND member_pair.kind = 'GROUP_MEMBER'
                    AND member_pair.active = true
                    AND (
                      (member_pair."endpointAType" = 'USER'
                        AND member_pair."endpointADomain" = ${peerDomain}
                        AND member_pair."endpointANamespaceId" = ${namespaceId}
                        AND member_pair."endpointBType" = 'GROUP'
                        AND member_pair."endpointBAccount" = ${thread.groupAccount}
                        AND member_pair."endpointBDomain" = 'local'
                        AND member_pair."endpointBNamespaceId" = ${namespaceId})
                      OR (member_pair."endpointBType" = 'USER'
                        AND member_pair."endpointBDomain" = ${peerDomain}
                        AND member_pair."endpointBNamespaceId" = ${namespaceId}
                        AND member_pair."endpointAType" = 'GROUP'
                        AND member_pair."endpointAAccount" = ${thread.groupAccount}
                        AND member_pair."endpointADomain" = 'local'
                        AND member_pair."endpointANamespaceId" = ${namespaceId})
                    )
                ))))
          OR (${thread.threadType} = 'GROUP'
            AND ${thread.groupDomain} = ${peerDomain}
            AND ${thread.groupNamespaceId} = ${namespaceId}
            AND EXISTS (
              SELECT 1
              FROM "AccountThreadState" local_state
              WHERE local_state."threadId" = message_thread.id
            ))
        )
      LIMIT 1
    `);
    const route = result.rows[0];
    if (!route) return null;
    const { messageEndSeq, tombstoneEndSeq } = await readThreadHeadSnapshotInTx(
      tx,
      threadId,
      route.messageAccessAfterSeq,
    );
    if (thread.threadType === 'GROUP') {
      if (!thread.groupAccount)
        throw new Error(`group thread ${threadId} has no group address`);
      // Only an authoritative local group authors the Meta coordinate; a mirror's
      // head must not hand the origin its own applied cursor.
      const groupAuthored =
        thread.groupDomain === 'local' && thread.groupNamespaceId === 0;
      const metaCoordinate = groupAuthored
        ? (
            await tx.execute<{ metaEndId: number }>(sql`
              SELECT "metaEndId" FROM "GroupMeta"
              WHERE "threadId" = ${threadId} LIMIT 1`)
          ).rows[0]
        : undefined;
      if (groupAuthored && !metaCoordinate)
        throw new Error(
          `authoritative group ${threadId} has no Meta coordinate`,
        );
      return {
        account: thread.groupAccount,
        messageEndSeq,
        tombstoneEndSeq,
        groupMetaFeedEndId: metaCoordinate?.metaEndId,
      };
    }
    if (!route.account || !route.peerAccount)
      throw new Error(
        `P2P thread ${threadId} has no address for ${peerDomain}`,
      );
    return {
      account: route.account,
      peerAccount: route.peerAccount,
      messageEndSeq,
      tombstoneEndSeq,
    };
  }
}
