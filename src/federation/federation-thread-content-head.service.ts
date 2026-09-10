import { groupStateSql } from '../group/group-state.js';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { readThreadHeadSnapshotInTx } from './federation-thread-head-snapshot.js';
import { PeerStateFeedService } from './peer-state-feed.service.js';
import { loadFederationConfig } from './federation.config.js';
import { FederationNamespaceService } from './federation-namespace.service.js';

interface ThreadContentProjection {
  account: string;
  peerAccount?: string;
  messageEndSeq: number;
  tombstoneEndSeq: number;
}

@Injectable()
export class FederationThreadContentHeadService {
  private readonly localDomain = loadFederationConfig().domain;

  constructor(
    private readonly database: DatabaseService,
    private readonly stateFeed: PeerStateFeedService,
    private readonly namespaces: FederationNamespaceService,
  ) {}

  async fill(peerDomain: string): Promise<void> {
    const context = await this.namespaces.captureActive(peerDomain);
    const routes = await this.database.db.execute<{ threadId: number }>(sql`
      SELECT audience."threadId"
      FROM "ThreadAudience" audience
      JOIN "MessageThread" audience_thread
        ON audience_thread.id = audience."threadId"
      LEFT JOIN ${groupStateSql} audience_group
        ON audience_group.id = audience_thread.id
      WHERE audience."targetDomain" = ${peerDomain}
        AND audience."targetNamespaceId" = ${context.namespaceId}
        AND audience."localUserId" IS NULL
        AND (audience_thread.type = 'P2P' OR audience_group.domain = 'local')
      UNION
      SELECT thread.id AS "threadId"
      FROM ${groupStateSql} group_state
      JOIN "MessageThread" thread ON thread.id = group_state.id
      JOIN "AccountThreadState" local_state ON local_state."threadId" = thread.id
      WHERE thread.type = 'GROUP'
        AND group_state.domain = ${peerDomain}
        AND group_state."namespaceId" = ${context.namespaceId}
    `);
    for (const route of routes.rows)
      await this.database.db.transaction((tx) =>
        this.refreshInTx(tx, peerDomain, context.namespaceId, route.threadId),
      );
  }

  async refreshInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
    namespaceId: number,
    threadId: number,
    forceReindex = false,
  ): Promise<void> {
    const projection = await this.readProjectionInTx(
      tx,
      peerDomain,
      namespaceId,
      threadId,
    );
    if (!projection) return;
    await this.stateFeed.writeManyInTx(tx, [
      {
        peerDomain,
        namespaceId,
        account: projection.account,
        domain: this.localDomain,
        eventType: 'THREAD_CONTENT_HEAD',
        subjectAccount: projection.peerAccount ?? '',
        subjectDomain: projection.peerAccount ? peerDomain : 'local',
        forceReindex,
        body: {
          messageEndSeq: projection.messageEndSeq,
          tombstoneEndSeq: projection.tombstoneEndSeq,
        },
      },
    ]);
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
              OR (${thread.threadType} = 'GROUP' AND ${thread.groupDomain} = 'local')))
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
      return {
        account: thread.groupAccount,
        messageEndSeq,
        tombstoneEndSeq,
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
