import { systemAccountIdInTx } from '../user/system-account.js';
import { groupStateSql } from '../business/group/shared/group-state.js';
import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { RelationshipIntentService } from '../business/relationship/relationship-intent.service.js';
import { admitMirrorGroupMembersDisbandInTx } from './mirror-group-disband-admission.js';
import { DurableTaskQueueService } from '../durable-task/durable-task-queue.service.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import { UserIntentService } from '../business/user/p2p-intent/authored/user-intent.service.js';

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
    | 'GROUP_DISBAND_QUEUED'
    | 'GROUP_ALREADY_CLOSED'
    | 'STALE'
  > {
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
          return thread?.authorizationEpoch === expectedAuthorizationEpoch
            ? ('P2P_ALREADY_CLOSED' as const)
            : ('STALE' as const);
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
          FOR NO KEY UPDATE OF thread
        `);
        const lockedGroup = lockedGroups.rows[0];
        if (
          !lockedGroup ||
          lockedGroup.authorizationEpoch !== expectedAuthorizationEpoch
        ) {
          return 'STALE' as const;
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
          LIMIT 1
        `);
        if (groupMembers.rows.length === 0)
          return 'GROUP_ALREADY_CLOSED' as const;

        const mirror = groupLocation.groupDomain !== 'local';
        if (mirror) {
          // A mirror denied an authorized read has no authorized state behind
          // it: fence in-flight content rounds now and converge the whole
          // group through the disband task instead of one member's revocation.
          await tx.execute(sql`
            UPDATE "MessageThread"
            SET "authorizationEpoch" = "authorizationEpoch" + 1,
              "federationRoundsEnabled" = false,
              "updatedAt" = CURRENT_TIMESTAMP
            WHERE id = ${threadId}
          `);
          await admitMirrorGroupMembersDisbandInTx(tx, {
            groupId: threadId,
            groupAccount: groupLocation.groupAccount,
            peerDomain: groupLocation.groupDomain,
            namespaceId,
          });
          return 'GROUP_DISBAND_QUEUED' as const;
        }
        await this.tasks.enqueueTaskInTx(tx, {
          scope: {
            type: 'GROUP',
            address: {
              account: groupLocation.groupAccount,
              domain: groupLocation.groupDomain,
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
          domain: peerDomain,
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
