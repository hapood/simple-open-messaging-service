import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { DurableTaskQueueService } from '../durable-task/durable-task-queue.service.js';
import { saveTaskCheckpointInTx } from '../durable-task/task-checkpoint.js';
import { requireThreadContentLockInTx } from '../common/locks/thread-content-lock.js';
import { groupStateFields, readGroupState } from './shared/group-state.js';
import { businessAccountScopeKey } from '../common/locks/account-business-lock.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import { enqueueDepartureFanoutsInTx } from '../message/account-thread-fanout-task.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { readForbiddenGroupTask } from './group-disband-task.js';

@Injectable()
export class GroupRevokeFanoutService {
  constructor(
    private readonly database: DatabaseService,
    private readonly tasks: DurableTaskQueueService,
  ) {}

  /** Admit exactly one member-revocation child and advance the pair cursor atomically. */
  async insertNextMember(
    parent: DurableTask,
    threadId: number,
  ): Promise<boolean> {
    const denial =
      parent.taskType === DurableTaskType.REVOKE_FORBIDDEN_GROUP
        ? readForbiddenGroupTask(parent)
        : null;
    return this.database.db.transaction(async (tx) => {
      const threadLock = await requireThreadContentLockInTx(tx, threadId);
      const group = await readGroupState(tx, eq(groupStateFields.id, threadId));
      if (!group || businessAccountScopeKey(group) !== parent.scopeKey)
        throw new Error('revocation task belongs to another group');
      const locked = await tx.execute<{
        id: string;
        status: string;
        taskType: string;
        afterPairId: string;
      }>(sql`
        SELECT id, status, "taskType",
          COALESCE(checkpoint ->> 'afterPairId', '0') AS "afterPairId"
        FROM "DurableTask"
        WHERE id = ${parent.id}
        FOR NO KEY UPDATE
      `);
      const current = locked.rows[0];
      if (
        !current ||
        current.status !== 'PROCESSING' ||
        current.taskType !== parent.taskType ||
        (current.taskType !== DurableTaskType.DISBAND_GROUP &&
          current.taskType !== DurableTaskType.REVOKE_FORBIDDEN_GROUP)
      ) {
        throw new Error('revocation parent is not checkpointable');
      }
      const afterPairId = readCursor(current.afterPairId);
      if (denial) {
        const epoch = await tx.execute<{ authorizationEpoch: number }>(sql`
          SELECT "authorizationEpoch" FROM "MessageThread" WHERE id = ${threadId}
        `);
        if (
          epoch.rows[0]?.authorizationEpoch !==
          denial.expectedAuthorizationEpoch
        )
          return false;
        if (
          group.domain !== 'local' &&
          (group.domain !== denial.peerDomain ||
            group.namespaceId !== denial.namespaceId)
        )
          return false;
      }
      const next = await tx.execute<{
        pairId: string;
        account: string;
        domain: string;
        namespaceId: number;
        active: boolean;
      }>(sql`
        SELECT pair.id AS "pairId", pair."endpointBAccount" AS account,
          pair."endpointBDomain" AS domain,
          pair.active AS active,
          CASE WHEN pair."endpointBDomain" = 'local' THEN 0 ELSE pair."endpointBNamespaceId" END AS "namespaceId"
        FROM "RelationshipPair" pair
        WHERE pair."threadId" = ${threadId}
          AND pair.kind = 'GROUP_MEMBER'
          ${denial ? sql`AND pair.active = true` : sql``}
          AND pair.id > ${afterPairId}
          ${
            denial
              ? sql`
            AND pair."endpointBDomain" = ${group.domain === 'local' ? denial.peerDomain : 'local'}
            AND pair."endpointANamespaceId" = ${denial.namespaceId}
            AND pair."endpointBNamespaceId" = ${denial.namespaceId}
          `
              : sql``
          }
        ORDER BY pair.id
        LIMIT 1
      `);
      const member = next.rows[0];
      if (!member) return false;
      const pairId = BigInt(member.pairId);

      // The parent already wrote GROUP_DISSOLVED. Bind its seq to this active
      // local relationship and admit a directed head before the revoke child
      // can make the ordinary fanout's active-audience check skip the member.
      if (
        parent.taskType === DurableTaskType.DISBAND_GROUP &&
        member.active &&
        member.domain === 'local'
      ) {
        const boundary = await tx.execute<{
          seq: number;
          tombstoneEndSeq: number;
          accountId: number;
        }>(sql`
          SELECT message.seq, thread."tombstoneEndSeq",
            local.id AS "accountId"
          FROM "MessageThread" thread
          JOIN "Message" message ON message."threadId" = thread.id
          JOIN "Account" local ON local.account = ${member.account}
            AND local.domain = 'local' AND local."namespaceId" = 0
          WHERE thread.id = ${threadId}
            AND message."contentType" = 'SYSTEM'
            AND message.content::jsonb->>'type' = 'GROUP_DISSOLVED'
          ORDER BY message.seq DESC LIMIT 1
        `);
        const final = boundary.rows[0];
        if (!final)
          throw new Error(
            'active dissolved member has no final system message',
          );
        await tx.execute(sql`
          UPDATE "AccountThreadState" state
          SET "messageVisibleThroughSeq" = ${final.seq},
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE state."threadId" = ${threadId}
            AND state."accountId" = ${final.accountId}
            AND state."messageVisibleThroughSeq" IS DISTINCT FROM ${final.seq}
        `);
        await enqueueDepartureFanoutsInTx(
          tx,
          threadLock,
          {
            threadId,
            messageEndSeq: final.seq,
            tombstoneEndSeq: final.tombstoneEndSeq,
          },
          'GROUP',
          { account: member.account, domain: 'local', namespaceId: 0 },
        );
      }

      await this.tasks.enqueueTaskInTx(tx, {
        scope: {
          type: 'GROUP',
          address: { account: group.account, domain: group.domain },
        },
        taskType: DurableTaskType.FORCE_REVOKE_GROUP_MEMBER,
        ...(parent.actorUserId === null
          ? {}
          : { actorUserId: parent.actorUserId }),
        payload: {
          threadId,
          ...(denial
            ? {
                peerDomain: denial.peerDomain,
                namespaceId: denial.namespaceId,
                expectedAuthorizationEpoch: denial.expectedAuthorizationEpoch,
                direction: group.domain === 'local' ? 'GROUP' : 'MEMBER',
                groupAccount: group.account,
                groupDomain: group.domain,
                groupNamespaceId: group.namespaceId,
              }
            : {}),
          memberUserId: {
            account: member.account,
            domain: member.domain,
            namespaceId: member.namespaceId,
          },
        },
      });
      await saveTaskCheckpointInTx(tx, parent.id, {
        afterPairId: pairId.toString(),
      });
      return true;
    });
  }
}

function readCursor(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value))
    throw new Error('invalid disband relationship-pair checkpoint');
  return BigInt(value);
}
