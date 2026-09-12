import { groupState as group, groupStateFields } from '../group/group-state.js';
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { MessageThreadType } from '../database/enums.js';
import { messageThread } from '../database/schema.js';
import {
  FederationMessageContextError,
  FederationThreadSourceInactiveError,
} from './federation-errors.js';
import type { FederationReverseThreadSource } from './federation-reverse-thread-source.js';
import type { ThreadContentLock } from '../business/shared/locks/thread-content-lock.js';

@Injectable()
export class FederationThreadSourceService {
  constructor(private readonly database: DatabaseService) {}

  /** Recheck authority-side access after the group business and thread locks,
   * before writing either facts or round progress. Never acquire parent locks here. */
  static async assertAudienceInTx(
    lock: ThreadContentLock,
    source: FederationReverseThreadSource,
  ): Promise<void> {
    if (lock.threadId !== source.threadId)
      throw new Error('round audience check belongs to another thread');
    if (source.kind !== 'GROUP' || !source.localGroupAuthority) return;
    const audience = await lock.tx.execute(sql`
      SELECT id FROM "ThreadAudience"
      WHERE "threadId" = ${source.threadId}
        AND "targetDomain" = ${source.peerDomain}
        AND "targetNamespaceId" = ${source.namespaceId}
        AND "localUserId" IS NULL
      FOR SHARE
    `);
    if (audience.rows.length === 0)
      throw new FederationThreadSourceInactiveError(
        `group thread ${source.threadId} no longer has an audience for ${source.peerDomain}`,
      );
  }

  async resolve(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
  ): Promise<FederationReverseThreadSource> {
    const [groupThread] = await this.database.db
      .select({
        account: groupStateFields.account,
        domain: groupStateFields.domain,
        namespaceId: groupStateFields.namespaceId,
        federationRoundsEnabled: messageThread.federationRoundsEnabled,
      })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.id))
      .where(
        and(
          eq(messageThread.id, threadId),
          eq(messageThread.type, MessageThreadType.GROUP),
        ),
      )
      .limit(1);
    if (groupThread) {
      if (!groupThread.federationRoundsEnabled)
        throw new FederationThreadSourceInactiveError(
          `group thread ${threadId} has federation rounds disabled`,
        );
      if (groupThread.domain !== 'local' && groupThread.domain !== peerDomain) {
        throw new FederationMessageContextError(
          `group thread ${threadId} is not sourced by ${peerDomain}`,
        );
      }
      if (
        groupThread.domain === peerDomain &&
        groupThread.namespaceId !== namespaceId
      ) {
        throw new FederationMessageContextError(
          `group thread ${threadId} belongs to another namespace`,
        );
      }
      const active = await this.database.db.execute(sql`
        SELECT 1
        FROM "RelationshipPair" pair
        WHERE pair.kind = 'GROUP_MEMBER'
          AND pair.active = true
          AND pair."threadId" = ${threadId}
          AND EXISTS (
            SELECT 1 FROM (VALUES
              (pair."endpointAType", pair."endpointADomain"),
              (pair."endpointBType", pair."endpointBDomain")
            ) member(kind, domain)
            WHERE member.kind = 'USER'
              AND ((${groupThread.domain} = ${peerDomain} AND member.domain = 'local')
                OR (${groupThread.domain} = 'local' AND member.domain = ${peerDomain}))
          )
          AND pair."endpointANamespaceId" = ${namespaceId}
          AND pair."endpointBNamespaceId" = ${namespaceId}
        LIMIT 1
      `);
      if (active.rows.length === 0) {
        throw new FederationThreadSourceInactiveError(
          `group thread ${threadId} has no active federation source`,
        );
      }
      return {
        kind: 'GROUP',
        localGroupAuthority: groupThread.domain === 'local',
        threadId,
        peerDomain,
        namespaceId,
        selector: { account: groupThread.account },
      };
    }

    const pair = await this.database.db.execute<{
      remoteAccount: string;
      remoteDomain: string;
      localAccount: string;
    }>(sql`
      SELECT CASE
               WHEN pair."endpointADomain" = 'local'
                 THEN pair."endpointBAccount"
               ELSE pair."endpointAAccount"
             END AS "remoteAccount",
             CASE
               WHEN pair."endpointADomain" = 'local'
                 THEN pair."endpointBDomain"
               ELSE pair."endpointADomain"
             END AS "remoteDomain",
             CASE
               WHEN pair."endpointADomain" = 'local'
                 THEN pair."endpointAAccount"
               ELSE pair."endpointBAccount"
             END AS "localAccount"
      FROM "RelationshipPair" pair
      JOIN "MessageThread" thread ON thread.id = pair."threadId"
      WHERE pair."threadId" = ${threadId}
        AND pair.kind = 'P2P'
        AND pair.active = true
        AND thread.type = 'P2P'
        AND thread."federationRoundsEnabled" = true
        AND (pair."endpointADomain" = ${peerDomain}
          OR pair."endpointBDomain" = ${peerDomain})
        AND pair."endpointANamespaceId" = ${namespaceId}
        AND pair."endpointBNamespaceId" = ${namespaceId}
        AND ((pair."endpointADomain" = 'local'
              AND pair."endpointBDomain" <> 'local')
          OR (pair."endpointBDomain" = 'local'
              AND pair."endpointADomain" <> 'local'))
      LIMIT 1
    `);
    const p2p = pair.rows[0];
    if (!p2p) {
      throw new FederationMessageContextError(
        `federated mirror thread ${threadId} has no active federation source`,
      );
    }
    return {
      kind: 'P2P',
      threadId,
      peerDomain: p2p.remoteDomain,
      namespaceId,
      selector: {
        account: p2p.remoteAccount,
        peerAccount: p2p.localAccount,
      },
    };
  }
}
