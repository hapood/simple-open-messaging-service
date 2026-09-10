import { systemAccountIdInTx } from '../user/system-account.js';
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
import { DurableTaskQueueService } from '../durable-task/durable-task-queue.service.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import {
  readForbiddenGroupTask,
  readForcedMemberRevokeTask,
} from '../group/group-disband-task.js';
import { businessAccountScopeKey } from '../relationship/business-scope-lock.js';
import { requireThreadContentLockInTx } from '../relationship/thread-content-lock.js';

/** Converges locally authored relationship directions after authenticated query denial. */
@Injectable()
export class FederationThreadQueryDenialService {
  constructor(
    private readonly database: DatabaseService,
    private readonly relationshipIntents: RelationshipIntentService,
    private readonly relationshipMutations: FederationRelationshipMutationService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly eventEmitter: EventEmitter2,
    private readonly tasks: DurableTaskQueueService,
  ) {}

  async handleThreadQueryForbidden(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
    expectedAuthorizationEpoch: number,
  ): Promise<
    | 'P2P_REVOKE_QUEUED'
    | 'P2P_ALREADY_CLOSED'
    | 'GROUP_REVOKE_QUEUED'
    | 'GROUP_ALREADY_CLOSED'
    | 'STALE'
  > {
    return this.database.db.transaction(async (tx) => {
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
          await tx.execute(sql`
            UPDATE "MessageThread"
            SET "authorizationEpoch" = "authorizationEpoch" + 1,
              "federationRoundsEnabled" = false,
              "updatedAt" = CURRENT_TIMESTAMP
            WHERE id = ${threadId}
          `);
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
            expectedAuthorizationEpoch:
              expectedAuthorizationEpoch + (mirror ? 1 : 0),
          },
        });
        return 'GROUP_REVOKE_QUEUED' as const;
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
        return 'STALE' as const;
      }
      const positive = (status: string | undefined) =>
        status === 'REQUESTED' || status === 'ACCEPTED';
      if (
        !relationship.pair.active ||
        !positive(relationship.firstIntent?.status) ||
        !positive(relationship.secondIntent?.status)
      ) {
        return 'P2P_ALREADY_CLOSED' as const;
      }
      await this.tasks.enqueueTaskInTx(tx, {
        scope: {
          type: 'USER_PAIR',
          endpoints: [relationship.pair.endpointA, relationship.pair.endpointB],
        },
        taskType: DurableTaskType.REVOKE_USER_RELATIONSHIP,
        actorUserId: await systemAccountIdInTx(tx),
        payload: {
          threadId,
          expectedAuthorizationEpoch,
          intentAuthorUserId: endpoint.localUserId,
        },
      });
      return 'P2P_REVOKE_QUEUED' as const;
    });
  }

  async revokeForbiddenMember(task: DurableTask): Promise<void> {
    const denial = readForbiddenGroupTask(task);
    const { memberUserId } = readForcedMemberRevokeTask(task);
    const updates: PendingClientStateFeedUpdate[] = [];
    const allocated = await this.database.db.transaction(async (tx) => {
      await requireThreadContentLockInTx(tx, denial.threadId);
      const state = await tx.execute<{
        authorizationEpoch: number;
        account: string;
        domain: string;
        namespaceId: number;
      }>(sql`
        SELECT thread."authorizationEpoch", group_profile.account,
          group_profile.domain, group_profile."namespaceId"
        FROM "MessageThread" thread
        JOIN ${groupStateSql} group_profile ON group_profile.id = thread.id
        WHERE thread.id = ${denial.threadId}
      `);
      const group = state.rows[0];
      if (
        !group ||
        group.authorizationEpoch !== denial.expectedAuthorizationEpoch
      )
        return new Map<string, bigint>();
      if (businessAccountScopeKey(group) !== task.scopeKey)
        throw new Error('forced revoke belongs to another group');
      if (group.domain === 'local') {
        if (
          task.payload.direction !== 'GROUP' ||
          typeof memberUserId === 'number' ||
          memberUserId.domain !== denial.peerDomain ||
          memberUserId.namespaceId !== denial.namespaceId
        )
          throw new Error('invalid denied group direction');
        return this.relationshipMutations.writeGroupRelationshipIntentInTx(
          tx,
          denial.threadId,
          memberUserId,
          '',
          'REVOKED',
          updates,
        );
      }
      if (
        group.domain !== denial.peerDomain ||
        group.namespaceId !== denial.namespaceId
      )
        return new Map<string, bigint>();
      if (
        task.payload.direction !== 'MEMBER' ||
        typeof memberUserId !== 'number'
      )
        throw new Error('invalid denied member direction');
      return this.relationshipMutations.writeMemberRelationshipIntentInTx(
        tx,
        denial.threadId,
        memberUserId,
        'REVOKED',
        updates,
      );
    });
    this.clientStateFeed.notifyFeedUpdates(updates);
    for (const peerDomain of allocated.keys())
      this.eventEmitter.emit(FEDERATION_STATE_FEED_PUSH, { peerDomain });
  }
}
