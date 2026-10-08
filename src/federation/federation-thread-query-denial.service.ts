import { systemAccountIdInTx } from '../user/system-account.js';
import { groupStateSql } from '../group/shared/group-state.js';
import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { RelationshipIntentService } from '../relationship/relationship-intent.service.js';
import { DurableTaskQueueService } from '../durable-task/durable-task-queue.service.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import { UserIntentService } from '../user/p2p-intent/authored/user-intent.service.js';

/** Converges locally authored relationship directions after authenticated query denial. */
@Injectable()
export class FederationThreadQueryDenialService {
  constructor(
    private readonly database: DatabaseService,
    private readonly relationshipIntents: RelationshipIntentService,
    private readonly tasks: DurableTaskQueueService,
    private readonly userIntents: UserIntentService,
  ) {}

  async handleThreadQueryForbidden(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
    expectedAuthorizationEpoch: number,
  ): Promise<
    | 'P2P_REVOKED'
    | 'P2P_ALREADY_CLOSED'
    | 'GROUP_REVOKE_QUEUED'
    | 'MIRROR_WAITING_FOR_PUSH'
    | 'GROUP_ALREADY_CLOSED'
    | 'STALE'
  > {
    const result = await this.database.db.transaction(async (tx) => {
      const endpoints = await tx.execute<{
        localUserId: number;
        remoteAccount: string;
      }>(sql`
        SELECT local_identity.id AS "localUserId",
          pair."endpointBAccount" AS "remoteAccount"
        FROM "RelationshipPair" pair
        JOIN "Account" local_identity
          ON local_identity."namespaceId" = 0
         AND pair."endpointAType" = 'USER'
         AND pair."endpointAAccount" = local_identity.account
        WHERE pair.kind = 'P2P'
          AND pair."threadId" = ${threadId}
          AND pair."endpointANamespaceId" = 0
          AND pair."endpointBNamespaceId" = ${namespaceId}
        LIMIT 1
      `);
      const endpoint = endpoints.rows[0];
      if (!endpoint) {
        const groupLocations = await tx.execute<{
          groupAccount: string;
          groupNamespaceId: number;
        }>(sql`
          SELECT group_profile.account AS "groupAccount",
            group_profile."namespaceId" AS "groupNamespaceId"
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
          return thread?.authorizationEpoch === expectedAuthorizationEpoch
            ? ('P2P_ALREADY_CLOSED' as const)
            : ('STALE' as const);
        }

        // A mirror denial is not authoritative membership state. Stop this
        // round and wait for a later state-feed push instead of converting a
        // transient or stale denial into local group dissolution.
        if (groupLocation.groupNamespaceId !== 0)
          return 'MIRROR_WAITING_FOR_PUSH' as const;

        await this.relationshipIntents.lockGroupBusinessScopeInTx(tx, {
          account: groupLocation.groupAccount,
          profileNamespaceId: groupLocation.groupNamespaceId,
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
            AND group_profile."namespaceId" = ${groupLocation.groupNamespaceId}
          FOR NO KEY UPDATE OF thread
        `);
        const lockedGroup = lockedGroups.rows[0];
        if (
          !lockedGroup ||
          lockedGroup.authorizationEpoch !== expectedAuthorizationEpoch
        ) {
          return 'STALE' as const;
        }

        const groupMembers = await tx.execute(sql`
          SELECT 1
          FROM "MessageThread" thread
          JOIN ${groupStateSql} group_profile ON group_profile.id = thread.id
          JOIN "RelationshipPair" pair
            ON pair."threadId" = thread.id
           AND pair.kind = 'GROUP_MEMBER'
           AND pair.active = true
          CROSS JOIN LATERAL (VALUES
            (pair."endpointAType", pair."endpointAAccount", pair."endpointANamespaceId"),
            (pair."endpointBType", pair."endpointBAccount", pair."endpointBNamespaceId")
          ) member(kind, account, "namespaceId")
          JOIN "IdentityNamespace" member_ns ON member_ns.id = member."namespaceId"
          LEFT JOIN "Account" member_identity
            ON member_ns.id = 0 AND member_identity.account = member.account
          WHERE member.kind = 'USER' AND thread.id = ${threadId}
            AND thread.type = 'GROUP'
            AND ((group_profile.domain = ${peerDomain}
                  AND group_profile."namespaceId" = ${namespaceId}
                  AND member_ns.id = 0
                  AND member_identity.id IS NOT NULL)
              OR (group_profile."namespaceId" = 0
                  AND member_ns.domain = ${peerDomain}))
            AND member."namespaceId" IN (0, ${namespaceId})
          ORDER BY member_ns.domain, member.account
          LIMIT 1
        `);
        if (groupMembers.rows.length === 0)
          return 'GROUP_ALREADY_CLOSED' as const;

        await this.tasks.enqueueTaskInTx(tx, {
          scope: {
            type: 'GROUP',
            address: {
              account: groupLocation.groupAccount,
              profileNamespaceId: groupLocation.groupNamespaceId,
            },
          },
          taskType: DurableTaskType.REVOKE_FORBIDDEN_GROUP,
          actorUserId: await systemAccountIdInTx(tx),
          payload: {
            threadId,
            peerDomain,
            namespaceId,
            expectedAuthorizationEpoch,
          },
        });
        return 'GROUP_REVOKE_QUEUED' as const;
      }

      return {
        kind: 'P2P_REVOKE' as const,
        localUserId: endpoint.localUserId,
        remoteAccount: endpoint.remoteAccount,
      };
    });
    if (typeof result === 'string') return result;
    const outcome = await this.userIntents.execute(
      {
        userId: result.localUserId,
        decision: 'REVOKED',
        target: {
          account: result.remoteAccount,
          namespaceId,
        },
      },
      {
        expectedAuthorization: {
          threadId,
          epoch: expectedAuthorizationEpoch,
        },
      },
    );
    if (outcome.status === 'NO_OP' && outcome.reason === 'STALE_AUTHORIZATION')
      return 'STALE';
    return outcome.status === 'APPLIED' ? 'P2P_REVOKED' : 'P2P_ALREADY_CLOSED';
  }
}
