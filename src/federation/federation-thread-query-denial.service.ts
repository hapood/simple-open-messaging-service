import { groupStateSql } from '../group/group-state.js';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq, sql } from 'drizzle-orm';
import {
  ClientStateFeedService,
  type PendingClientStateFeedUpdate,
} from '../client-state-feed/client-state-feed.service.js';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { RelationshipIntentService } from '../relationship/relationship-intent.service.js';
import { FederationRelationshipMutationService } from './federation-relationship-mutation.service.js';
import { FEDERATION_STATE_FEED_PUSH } from './federation-state-feed.events.js';

/** Converges locally authored relationship directions after authenticated query denial. */
@Injectable()
export class FederationThreadQueryDenialService {
  constructor(
    private readonly database: DatabaseService,
    private readonly relationshipIntents: RelationshipIntentService,
    private readonly relationshipMutations: FederationRelationshipMutationService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async handleThreadQueryForbidden(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
    expectedAuthorizationEpoch: number,
  ): Promise<
    | 'P2P_REVOKED'
    | 'P2P_ALREADY_CLOSED'
    | 'GROUP_REVOKED'
    | 'GROUP_ALREADY_CLOSED'
    | 'STALE'
  > {
    const clientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    const result = await this.database.db.transaction(async (tx) => {
      const endpoints = await tx.execute<{
        localUserId: number;
        remoteAccount: string;
      }>(sql`
        SELECT local_identity.id AS "localUserId",
          CASE WHEN pair."endpointADomain" = ${peerDomain}
            THEN pair."endpointAAccount" ELSE pair."endpointBAccount" END AS "remoteAccount"
        FROM "RelationshipPair" pair
        JOIN "Account" local_identity
          ON local_identity.domain = 'local'
         AND local_identity."namespaceId" = 0
         AND ((pair."endpointAType" = 'USER'
               AND pair."endpointAAccount" = local_identity.account
               AND pair."endpointADomain" = local_identity.domain)
           OR (pair."endpointBType" = 'USER'
               AND pair."endpointBAccount" = local_identity.account
               AND pair."endpointBDomain" = local_identity.domain))
        WHERE pair.kind = 'P2P'
          AND (pair."endpointADomain" = ${peerDomain} OR pair."endpointBDomain" = ${peerDomain})
          AND pair."threadId" = ${threadId}
          AND pair."endpointANamespaceId" = ${namespaceId}
          AND pair."endpointBNamespaceId" = ${namespaceId}
        LIMIT 1
      `);
      const endpoint = endpoints.rows[0];
      if (!endpoint) {
        const groupLocations = await tx.execute<{
          groupAccount: string;
          groupDomain: string;
        }>(sql`
          SELECT group_profile.account AS "groupAccount",
            group_profile.domain AS "groupDomain"
          FROM "MessageThread" thread
          JOIN ${groupStateSql} group_profile ON group_profile.id = thread.id
          WHERE thread.id = ${threadId}
            AND thread.type = 'GROUP'
          LIMIT 1
        `);
        const groupLocation = groupLocations.rows[0];
        if (!groupLocation) {
          const thread = await tx.query.messageThread.findFirst({
            where: eq(tables.messageThread.id, threadId),
            columns: { authorizationEpoch: true },
          });
          return {
            outcome:
              thread?.authorizationEpoch === expectedAuthorizationEpoch
                ? ('P2P_ALREADY_CLOSED' as const)
                : ('STALE' as const),
            allocated: new Map<string, bigint>(),
          };
        }

        await this.relationshipIntents.lockGroupBusinessScopeInTx(tx, {
          account: groupLocation.groupAccount,
          domain: groupLocation.groupDomain,
        });
        const lockedGroups = await tx.execute<{
          authorizationEpoch: number;
        }>(sql`
          SELECT thread."authorizationEpoch"
          FROM "MessageThread" thread
          JOIN ${groupStateSql} group_profile ON group_profile.id = thread.id
          WHERE thread.id = ${threadId}
            AND thread.type = 'GROUP'
            AND group_profile.account = ${groupLocation.groupAccount}
            AND group_profile.domain = ${groupLocation.groupDomain}
          FOR UPDATE OF thread
        `);
        const lockedGroup = lockedGroups.rows[0];
        if (
          !lockedGroup ||
          lockedGroup.authorizationEpoch !== expectedAuthorizationEpoch
        ) {
          return {
            outcome: 'STALE' as const,
            allocated: new Map<string, bigint>(),
          };
        }

        const groupMembers = await tx.execute<{
          groupId: number;
          groupDomain: string;
          memberUserId: number | null;
          memberAccount: string;
          memberDomain: string;
        }>(sql`
          SELECT group_profile.id AS "groupId",
            group_profile.domain AS "groupDomain",
            member_identity.id AS "memberUserId",
            member.account AS "memberAccount", member.domain AS "memberDomain"
          FROM "MessageThread" thread
          JOIN ${groupStateSql} group_profile ON group_profile.id = thread.id
          JOIN "RelationshipPair" pair
            ON pair."threadId" = thread.id
           AND pair.kind = 'GROUP_MEMBER'
           AND pair.active = true
          CROSS JOIN LATERAL (VALUES
            (pair."endpointAType", pair."endpointAAccount", pair."endpointADomain"),
            (pair."endpointBType", pair."endpointBAccount", pair."endpointBDomain")
          ) member(kind, account, domain)
          LEFT JOIN "Account" member_identity
            ON member.domain = 'local' AND member_identity.account = member.account
          WHERE member.kind = 'USER' AND thread.id = ${threadId}
            AND thread.type = 'GROUP'
            AND ((group_profile.domain = ${peerDomain}
                  AND group_profile."namespaceId" = ${namespaceId}
                  AND member.domain = 'local'
                  AND member_identity.id IS NOT NULL)
              OR (group_profile.domain = 'local'
                  AND group_profile."namespaceId" = 0
                  AND member.domain = ${peerDomain}))
            AND pair."endpointANamespaceId" = ${namespaceId}
            AND pair."endpointBNamespaceId" = ${namespaceId}
          ORDER BY member.domain, member.account
        `);
        const members = groupMembers.rows.map((member) => ({
          ...member,
          target: member.memberUserId ?? {
            account: member.memberAccount,
            domain: member.memberDomain,
            namespaceId,
          },
        }));
        if (members.length === 0) {
          return {
            outcome: 'GROUP_ALREADY_CLOSED' as const,
            allocated: new Map<string, bigint>(),
          };
        }

        await this.relationshipMutations.lockGroupMutationInTx(
          tx,
          threadId,
          members[0]!.target,
          members.flatMap((member) =>
            member.memberUserId === null ? [] : [member.memberUserId],
          ),
        );

        const allocated = new Map<string, bigint>();
        for (const member of members) {
          const written =
            member.groupDomain === 'local'
              ? await this.relationshipMutations.writeGroupRelationshipIntentInTx(
                  tx,
                  threadId,
                  member.target,
                  '',
                  'REVOKED',
                  clientFeedUpdates,
                )
              : await this.relationshipMutations.writeMemberRelationshipIntentInTx(
                  tx,
                  threadId,
                  member.memberUserId!,
                  'REVOKED',
                  clientFeedUpdates,
                );
          for (const [domain, feedId] of written) allocated.set(domain, feedId);
        }
        return { outcome: 'GROUP_REVOKED' as const, allocated };
      }

      const relationship =
        await this.relationshipIntents.readP2PRelationshipInTx(
          tx,
          endpoint.localUserId,
          { account: endpoint.remoteAccount, domain: peerDomain, namespaceId },
        );
      const thread = await tx.query.messageThread.findFirst({
        where: eq(tables.messageThread.id, threadId),
        columns: { authorizationEpoch: true },
      });
      if (
        relationship.pair.threadId !== threadId ||
        thread?.authorizationEpoch !== expectedAuthorizationEpoch
      ) {
        return {
          outcome: 'STALE' as const,
          allocated: new Map<string, bigint>(),
        };
      }
      const positive = (status: string | undefined) =>
        status === 'REQUESTED' || status === 'ACCEPTED';
      if (
        !relationship.pair.active ||
        !positive(relationship.firstIntent?.status) ||
        !positive(relationship.secondIntent?.status)
      ) {
        return {
          outcome: 'P2P_ALREADY_CLOSED' as const,
          allocated: new Map<string, bigint>(),
        };
      }
      const allocated = await this.relationshipMutations.writeP2PIntentInTx(
        tx,
        endpoint.localUserId,
        { account: endpoint.remoteAccount, domain: peerDomain, namespaceId },
        false,
        '',
        clientFeedUpdates,
      );
      return { outcome: 'P2P_REVOKED' as const, allocated };
    });
    this.clientStateFeed.notifyFeedUpdates(clientFeedUpdates);
    for (const peerDomain of new Set(result.allocated.keys()))
      this.eventEmitter.emit(FEDERATION_STATE_FEED_PUSH, { peerDomain });
    return result.outcome;
  }

  /** Materialize expired directions authored by this server as durable revocations. The expiry
   * boundary itself remains authoritative; this sweep only makes the already-effective negative
   * state explicit so clients and peers converge without retaining stale REQUESTED snapshots. */
}
