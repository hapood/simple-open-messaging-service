import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { MessageThreadType } from '../database/enums.js';
import { group, messageThread } from '../database/schema.js';
import { FederationMessageContextError } from './federation-errors.js';
import type { FederationReverseThreadSource } from './federation-reverse-thread-source.js';

@Injectable()
export class FederationThreadSourceService {
  constructor(private readonly database: DatabaseService) {}

  async resolve(
    threadId: number,
    peerDomain: string,
  ): Promise<FederationReverseThreadSource> {
    const [groupThread] = await this.database.db
      .select({ account: group.account, domain: group.domain })
      .from(messageThread)
      .innerJoin(group, eq(group.id, messageThread.groupId))
      .where(
        and(
          eq(messageThread.id, threadId),
          eq(messageThread.type, MessageThreadType.GROUP),
          eq(messageThread.federationTruncated, false),
        ),
      )
      .limit(1);
    if (groupThread) {
      if (groupThread.domain !== 'local' && groupThread.domain !== peerDomain) {
        throw new FederationMessageContextError(
          `group thread ${threadId} is not sourced by ${peerDomain}`,
        );
      }
      const active = await this.database.db.execute(sql`
        SELECT 1
        FROM "RelationshipPair" pair
        JOIN "User" member_identity
          ON ((pair."endpointAType" = 'USER'
               AND pair."endpointAAccount" = member_identity.account
               AND pair."endpointADomain" = member_identity.domain)
           OR (pair."endpointBType" = 'USER'
               AND pair."endpointBAccount" = member_identity.account
               AND pair."endpointBDomain" = member_identity.domain))
        WHERE pair.kind = 'GROUP_MEMBER'
          AND pair.active = true
          AND pair."threadId" = ${threadId}
          AND ((${groupThread.domain} = ${peerDomain}
                AND member_identity.domain = 'local')
            OR (${groupThread.domain} = 'local'
                AND member_identity.domain = ${peerDomain}))
        LIMIT 1
      `);
      if (active.rows.length === 0) {
        throw new FederationMessageContextError(
          `group thread ${threadId} has no active federation source`,
        );
      }
      return {
        kind: 'GROUP',
        threadId,
        peerDomain,
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
        AND thread."federationTruncated" = false
        AND (pair."endpointADomain" = ${peerDomain}
          OR pair."endpointBDomain" = ${peerDomain})
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
      selector: {
        account: p2p.remoteAccount,
        peerAccount: p2p.localAccount,
      },
    };
  }
}
