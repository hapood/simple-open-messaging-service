import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { DurableTaskQueueService } from '../durable-task/durable-task-queue.service.js';
import { saveTaskCheckpointInTx } from '../durable-task/task-checkpoint.js';
import { requireThreadContentLockInTx } from '../relationship/thread-content-lock.js';
import { groupStateFields, readGroupState } from './group-state.js';
import { businessAccountScopeKey } from '../relationship/business-scope-lock.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
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
      await requireThreadContentLockInTx(tx, threadId);
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
      }>(sql`
        SELECT pair.id AS "pairId", pair."endpointBAccount" AS account,
          pair."endpointBDomain" AS domain,
          CASE WHEN pair."endpointBDomain" = 'local' THEN 0 ELSE pair."endpointBNamespaceId" END AS "namespaceId"
        FROM "RelationshipPair" pair
        WHERE pair."threadId" = ${threadId}
          AND pair.kind = 'GROUP_MEMBER'
          AND pair.active = true
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
                ...denial,
                direction: group.domain === 'local' ? 'GROUP' : 'MEMBER',
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
