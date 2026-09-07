import {
  readAccountTarget,
  type AccountTarget,
} from '../user/account-address.js';
import { Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { durableTask } from '../database/schema.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  businessAccountScopeKey,
  lockBusinessAccountsInTx,
  type BusinessScopeAddress,
} from '../relationship/business-scope-lock.js';
import { DurableTaskType } from './durable-task.constants.js';

export type DurableTaskScope =
  | {
      type: 'USER_PAIR';
      endpoints: readonly [BusinessScopeAddress, BusinessScopeAddress];
    }
  | {
      type: 'GROUP';
      address: BusinessScopeAddress;
    };

export interface EnqueueDurableTaskInput {
  scope: DurableTaskScope;
  taskType: string;
  actorUserId?: number;
  payload: Record<string, unknown>;
}

export interface EnqueueDurableTaskResult {
  taskId: bigint;
}

export interface EnqueueGroupMetaHeadFanoutInput {
  group: BusinessScopeAddress;
  threadId: number;
}

@Injectable()
export class DurableTaskQueueService {
  constructor(private readonly database: DatabaseService) {}

  async enqueueTask(
    input: EnqueueDurableTaskInput,
  ): Promise<EnqueueDurableTaskResult> {
    const taskType = validateTaskType(input.taskType);
    const actorUserId = validateActorUserId(input.actorUserId);
    const payload = cloneJsonObject(input.payload);
    const { scopeType, scopeKey, lockAddresses } = resolveScope(input.scope);
    const coalescingKey = resolveMutationCoalescingKey({
      scopeType,
      taskType,
      actorUserId,
      payload,
    });

    return this.database.db.transaction(async (tx) => {
      // This is a short-lived ordering lock only. Task execution takes the same business-scope
      // lock separately, so enqueueing does not extend the caller's business transaction.
      await lockBusinessAccountsInTx(tx, lockAddresses);

      if (coalescingKey) {
        const existing = await this.findLatestPendingMutationInTx(
          tx,
          scopeKey,
          coalescingKey,
        );
        if (existing) {
          if (
            existing.taskType === taskType &&
            existing.actorUserId === actorUserId &&
            isDeepStrictEqual(existing.payload, payload)
          )
            return { taskId: existing.id };

          const [laterBlocking] = await tx
            .select({ id: durableTask.id })
            .from(durableTask)
            .where(
              and(
                eq(durableTask.kind, 'MUTATION'),
                eq(durableTask.scopeKey, scopeKey),
                gt(durableTask.id, existing.id),
                inArray(durableTask.status, [
                  'PENDING',
                  'PROCESSING',
                  'ASYNC_PROCESSING',
                  'FAILED',
                ]),
              ),
            )
            .orderBy(desc(durableTask.id))
            .limit(1);
          if (!laterBlocking) {
            const [updated] = await tx
              .update(durableTask)
              .set({ taskType, actorUserId, payload })
              .where(
                and(
                  eq(durableTask.id, existing.id),
                  eq(durableTask.status, 'PENDING'),
                ),
              )
              .returning({ taskId: durableTask.id });
            if (updated) return updated;
          }
        }
      }

      const [inserted] = await tx
        .insert(durableTask)
        .values({
          kind: 'MUTATION',
          scopeType,
          scopeKey,
          taskType,
          actorUserId,
          payload,
          coalescingKey,
          status: 'PENDING',
        })
        .returning({ taskId: durableTask.id });

      if (!inserted) {
        throw new Error('durable task insert returned no row');
      }
      return inserted;
    });
  }

  private async findLatestPendingMutationInTx(
    tx: DatabaseTransaction,
    scopeKey: string,
    coalescingKey: string,
  ): Promise<{
    id: bigint;
    taskType: string;
    actorUserId: number | null;
    payload: Record<string, unknown>;
  } | null> {
    const [task] = await tx
      .select({
        id: durableTask.id,
        taskType: durableTask.taskType,
        actorUserId: durableTask.actorUserId,
        payload: durableTask.payload,
      })
      .from(durableTask)
      .where(
        and(
          eq(durableTask.kind, 'MUTATION'),
          eq(durableTask.scopeKey, scopeKey),
          eq(durableTask.coalescingKey, coalescingKey),
          eq(durableTask.status, 'PENDING'),
        ),
      )
      .orderBy(desc(durableTask.id))
      .for('update')
      .limit(1);
    return task ?? null;
  }

  async enqueueGroupMetaHeadFanoutInTx(
    tx: DatabaseTransaction,
    input: EnqueueGroupMetaHeadFanoutInput,
  ): Promise<EnqueueDurableTaskResult> {
    const threadId = validatePositiveInteger(input.threadId, 'thread ID');
    validateAddress(input.group);
    const scopeKey = businessAccountScopeKey(input.group);
    if (scopeKey.length > 512) {
      throw new TypeError('durable task scope key exceeds 512 characters');
    }
    const coalescingKey = JSON.stringify([
      DurableTaskType.FAN_OUT_GROUP_META_HEAD,
      threadId,
    ]);
    await lockBusinessAccountsInTx(tx, [input.group]);

    const pending = await tx
      .select({ id: durableTask.id, payload: durableTask.payload })
      .from(durableTask)
      .where(
        and(
          eq(durableTask.kind, 'PROJECTION'),
          eq(durableTask.scopeType, 'GROUP'),
          eq(durableTask.scopeKey, scopeKey),
          eq(durableTask.taskType, DurableTaskType.FAN_OUT_GROUP_META_HEAD),
          eq(durableTask.coalescingKey, coalescingKey),
          eq(durableTask.status, 'PENDING'),
        ),
      )
      .orderBy(asc(durableTask.id))
      .for('update');

    for (const task of pending) {
      if (
        task.payload.threadId !== threadId ||
        Object.keys(task.payload).length !== 1
      )
        throw new Error('invalid pending Group Meta head fan-out payload');
    }
    const [inserted] = await tx
      .insert(durableTask)
      .values({
        kind: 'PROJECTION',
        scopeType: 'GROUP',
        scopeKey,
        taskType: DurableTaskType.FAN_OUT_GROUP_META_HEAD,
        actorUserId: null,
        payload: { threadId },
        checkpoint: { afterAudienceId: '0' },
        coalescingKey,
        status: 'PENDING',
      })
      .returning({ taskId: durableTask.id });
    if (!inserted) {
      throw new Error('durable projection task insert returned no row');
    }

    if (pending.length > 0) {
      await tx
        .update(durableTask)
        .set({
          status: 'SUPERSEDED',
          supersededByTaskId: inserted.taskId,
          // CURRENT_TIMESTAMP is fixed at transaction start. This transaction may have waited on
          // the group advisory lock while the pending row was created by a later-committing
          // transaction, so use the wall clock and retain the timestamp-order invariant.
          completedAt: sql`GREATEST(clock_timestamp(), ${durableTask.createdAt})`,
        })
        .where(
          and(
            inArray(
              durableTask.id,
              pending.map((task) => task.id),
            ),
            eq(durableTask.status, 'PENDING'),
          ),
        );
    }

    return inserted;
  }
}

function resolveScope(scope: DurableTaskScope): {
  scopeType: 'USER_PAIR' | 'GROUP';
  scopeKey: string;
  lockAddresses: readonly BusinessScopeAddress[];
} {
  let scopeKey: string;
  let lockAddresses: readonly BusinessScopeAddress[];
  if (scope.type === 'USER_PAIR') {
    validateAddress(scope.endpoints[0]);
    validateAddress(scope.endpoints[1]);
    const ordered = [...scope.endpoints].sort(compareAddresses);
    scopeKey = JSON.stringify([
      'task-scope',
      'USER_PAIR',
      ...ordered.map((address) => [
        address.domain.toLowerCase(),
        address.account,
      ]),
    ]);
    lockAddresses = ordered;
  } else {
    validateAddress(scope.address);
    scopeKey = businessAccountScopeKey(scope.address);
    lockAddresses = [scope.address];
  }

  if (scopeKey.length > 512) {
    throw new TypeError('durable task scope key exceeds 512 characters');
  }
  return { scopeType: scope.type, scopeKey, lockAddresses };
}

function compareAddresses(
  left: BusinessScopeAddress,
  right: BusinessScopeAddress,
): number {
  return (
    left.domain.toLowerCase().localeCompare(right.domain.toLowerCase()) ||
    left.account.localeCompare(right.account)
  );
}

function validateAddress(address: BusinessScopeAddress): void {
  if (
    !address.domain ||
    !address.account ||
    address.domain !== address.domain.trim() ||
    address.account !== address.account.trim()
  ) {
    throw new TypeError(
      'durable task scope address must be non-empty and normalized',
    );
  }
}

function validateTaskType(taskType: string): string {
  if (taskType.length > 64 || !/^[A-Z][A-Z0-9_]*$/.test(taskType)) {
    throw new TypeError('invalid durable task type');
  }
  return taskType;
}

function validateActorUserId(actorUserId: number | undefined): number | null {
  if (actorUserId === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) {
    throw new TypeError(
      'durable task actor user ID must be a positive integer',
    );
  }
  return actorUserId;
}

function validatePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(
      `durable projection ${label} must be a positive integer`,
    );
  }
  return value;
}

function resolveMutationCoalescingKey(input: {
  scopeType: 'USER_PAIR' | 'GROUP';
  taskType: string;
  actorUserId: number | null;
  payload: Record<string, unknown>;
}): string | null {
  if (input.scopeType !== 'GROUP') return null;
  switch (input.taskType) {
    case DurableTaskType.LEAVE_GROUP:
    case DurableTaskType.ACCEPT_GROUP_INVITATION:
    case DurableTaskType.REQUEST_FEDERATED_GROUP_JOIN:
    case DurableTaskType.REVOKE_FEDERATED_GROUP_JOIN:
    case DurableTaskType.ACCEPT_ADDRESSED_GROUP_INVITATION:
      if (input.actorUserId === null)
        throw new TypeError('replaceable member intent task requires an actor');
      return mutationCoalescingKey('MEMBER', input.actorUserId);
    case DurableTaskType.INVITE_GROUP_MEMBER:
    case DurableTaskType.KICK_GROUP_MEMBER:
      return mutationCoalescingKey(
        'GROUP',
        readAccountTarget(input.payload.targetUserId),
      );
    case DurableTaskType.ACCEPT_GROUP_JOIN_REQUEST:
    case DurableTaskType.REJECT_GROUP_JOIN_REQUEST:
    case DurableTaskType.REVOKE_GROUP_INVITATION:
      return mutationCoalescingKey(
        'GROUP',
        readAccountTarget(input.payload.memberUserId),
      );
    default:
      return null;
  }
}

function mutationCoalescingKey(
  authorSide: 'GROUP' | 'MEMBER',
  memberUserId: AccountTarget,
): string {
  return JSON.stringify([
    'GROUP_MEMBER_INTENT',
    authorSide,
    typeof memberUserId === 'number'
      ? memberUserId
      : [memberUserId.namespaceId, memberUserId.domain, memberUserId.account],
  ]);
}

function cloneJsonObject(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!isPlainObject(payload)) {
    throw new TypeError('durable task payload must be a plain object');
  }
  validateJsonValue(payload, new Set<object>());
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

function validateJsonValue(value: unknown, ancestors: Set<object>): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('durable task payload numbers must be finite');
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError('durable task payload must contain only JSON values');
  }
  if (ancestors.has(value)) {
    throw new TypeError('durable task payload must not contain cycles');
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      validateJsonValue(item, ancestors);
    }
  } else {
    if (!isPlainObject(value)) {
      throw new TypeError(
        'durable task payload must contain only plain objects',
      );
    }
    for (const item of Object.values(value)) {
      validateJsonValue(item, ancestors);
    }
  }
  ancestors.delete(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
