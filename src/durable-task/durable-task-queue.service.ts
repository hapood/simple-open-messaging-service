import { relationshipTaskAuthorUserId } from '../relationship/relationship-task-author.js';
import {
  readAccountTarget,
  type AccountTarget,
} from '../user/account-address.js';
import { Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { account, durableTask } from '../database/schema.js';
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
import {
  insertPendingTaskInTx,
  updatePendingTaskInTx,
  supersedePendingTasksInTx,
} from './task-admission.js';

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
    return this.database.db.transaction((tx) =>
      this.enqueueTaskInTx(tx, input),
    );
  }

  async enqueueTaskInTx(
    tx: DatabaseTransaction,
    input: EnqueueDurableTaskInput,
  ): Promise<EnqueueDurableTaskResult> {
    const taskType = validateTaskType(input.taskType);
    const actorUserId = validateActorUserId(input.actorUserId);
    const payload = cloneJsonObject(input.payload);
    const { scopeType, scopeKey, lockAddresses } = resolveScope(input.scope);
    // Normalize local addressed members to the same identity used by actor-based requests.
    if (scopeType === 'GROUP') {
      for (const field of ['targetUserId', 'memberUserId'] as const) {
        if (payload[field] === undefined) continue;
        const member = readAccountTarget(payload[field]);
        if (typeof member !== 'number' && member.domain === 'local') {
          const local = await tx.query.account.findFirst({
            where: eq(account.account, member.account),
            columns: { id: true },
          });
          if (!local) throw new Error('local task member does not exist');
          payload[field] = local.id;
        }
      }
    }
    const coalescingKey = resolveMutationCoalescingKey({
      scopeType,
      taskType,
      actorUserId,
      payload,
    });

    // Enter before child locks, or reuse business locks already held by the caller.
    // The ordering lock remains held until the caller-owned transaction commits.
    await lockBusinessAccountsInTx(tx, lockAddresses);

    if (coalescingKey) {
      const existing = await this.findLatestPendingMutationInTx(
        tx,
        scopeKey,
        coalescingKey,
      );
      if (existing) {
        // Mandatory cleanup must survive later commands in the same direction.
        if (existing.taskType === DurableTaskType.FORCE_REVOKE_GROUP_MEMBER)
          return { taskId: existing.id };
        if (
          existing.taskType === taskType &&
          existing.actorUserId === actorUserId &&
          sameTaskBehavior(taskType, existing.payload, payload)
        )
          return { taskId: existing.id };

        const updated = await updatePendingTaskInTx(tx, existing.id, {
          taskType,
          actorUserId,
          payload,
        });
        if (updated) {
          await supersedePendingTasksInTx(
            tx,
            and(
              eq(durableTask.kind, 'MUTATION'),
              eq(durableTask.scopeKey, scopeKey),
              eq(durableTask.coalescingKey, coalescingKey),
              ne(durableTask.id, updated.taskId),
            )!,
          );
          return updated;
        }
      }
    }

    if (coalescingKey) {
      // A duplicate running operation is already represented by its durable task.
      // Opposite-direction tasks do not affect duplicate suppression.
      const [latest] = await tx
        .select()
        .from(durableTask)
        .where(
          and(
            eq(durableTask.kind, 'MUTATION'),
            eq(durableTask.scopeKey, scopeKey),
            eq(durableTask.coalescingKey, coalescingKey),
            inArray(durableTask.status, ['PROCESSING', 'ASYNC_PROCESSING']),
          ),
        )
        .orderBy(desc(durableTask.id))
        .limit(1);
      if (
        latest &&
        ['PROCESSING', 'ASYNC_PROCESSING'].includes(latest.status) &&
        latest.coalescingKey === coalescingKey &&
        latest.taskType === taskType &&
        latest.actorUserId === actorUserId &&
        sameTaskBehavior(taskType, latest.payload, payload)
      )
        return { taskId: latest.id };
    }

    return insertPendingTaskInTx(tx, {
      kind: 'MUTATION',
      scopeType,
      scopeKey,
      taskType,
      actorUserId,
      payload,
      coalescingKey,
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
      .orderBy(
        sql`CASE WHEN ${durableTask.taskType} = ${DurableTaskType.FORCE_REVOKE_GROUP_MEMBER} THEN 0 ELSE 1 END`,
        desc(durableTask.id),
      )
      .for('no key update')
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
      .for('no key update');

    for (const task of pending) {
      if (
        task.payload.threadId !== threadId ||
        Object.keys(task.payload).length !== 1
      )
        throw new Error('invalid pending Group Meta head fan-out payload');
    }
    const inserted = await insertPendingTaskInTx(tx, {
      kind: 'PROJECTION',
      scopeType: 'GROUP',
      scopeKey,
      taskType: DurableTaskType.FAN_OUT_GROUP_META_HEAD,
      actorUserId: null,
      payload: { threadId },
      checkpoint: { afterAudienceId: '0' },
      coalescingKey,
    });

    if (pending.length > 0) {
      await supersedePendingTasksInTx(
        tx,
        inArray(
          durableTask.id,
          pending.map((task) => task.id),
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
  if (input.taskType === DurableTaskType.APPLY_FEDERATED_RELATIONSHIP_INTENT) {
    const item = input.payload.item as
      | { account?: unknown; peerAccount?: unknown }
      | undefined;
    if (
      !Number.isSafeInteger(input.payload.namespaceId) ||
      Number(input.payload.namespaceId) <= 0 ||
      typeof item?.account !== 'string' ||
      typeof item.peerAccount !== 'string'
    )
      throw new TypeError('invalid remote relationship task identity');
    return JSON.stringify([
      'REMOTE_INTENT',
      input.payload.namespaceId,
      item.account,
      item.peerAccount,
    ]);
  }
  if (input.scopeType === 'USER_PAIR') {
    switch (input.taskType) {
      case DurableTaskType.SEND_LOCAL_RELATIONSHIP_REQUEST:
      case DurableTaskType.ACCEPT_RELATIONSHIP_REQUEST:
      case DurableTaskType.REJECT_RELATIONSHIP_REQUEST:
      case DurableTaskType.REVOKE_RELATIONSHIP_REQUEST:
      case DurableTaskType.SEND_FEDERATED_RELATIONSHIP_REQUEST:
      case DurableTaskType.ACCEPT_ADDRESSED_RELATIONSHIP_REQUEST:
      case DurableTaskType.REVOKE_ADDRESSED_RELATIONSHIP_REQUEST:
      case DurableTaskType.REVOKE_USER_RELATIONSHIP:
      case DurableTaskType.END_FRIENDSHIP:
        if (input.actorUserId === null)
          throw new TypeError('replaceable pair intent task requires an actor');
        return JSON.stringify([
          'P2P_INTENT',
          relationshipTaskAuthorUserId(input),
        ]);
      default:
        return null;
    }
  }
  switch (input.taskType) {
    case DurableTaskType.REVOKE_USER_RELATIONSHIP:
    case DurableTaskType.LEAVE_GROUP:
    case DurableTaskType.ACCEPT_GROUP_INVITATION:
    case DurableTaskType.REQUEST_FEDERATED_GROUP_JOIN:
    case DurableTaskType.REVOKE_FEDERATED_GROUP_JOIN:
    case DurableTaskType.ACCEPT_ADDRESSED_GROUP_INVITATION:
      if (input.actorUserId === null)
        throw new TypeError('replaceable member intent task requires an actor');
      return mutationCoalescingKey(
        'MEMBER',
        relationshipTaskAuthorUserId(input),
      );
    case DurableTaskType.REVOKE_GROUP_RELATIONSHIP:
      return mutationCoalescingKey(
        'GROUP',
        readAccountTarget(
          input.payload.memberUserId ?? input.payload.targetUserId,
        ),
      );
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
    case DurableTaskType.FORCE_REVOKE_GROUP_MEMBER:
      return mutationCoalescingKey(
        input.payload.direction === 'MEMBER' ? 'MEMBER' : 'GROUP',
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

/** Transport cursor movement does not create a new business command. */
function sameTaskBehavior(
  taskType: string,
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  if (taskType !== DurableTaskType.APPLY_FEDERATED_RELATIONSHIP_INTENT)
    return isDeepStrictEqual(left, right);
  const normalize = (value: Record<string, unknown>) => {
    const { feedId: _feedId, ...item } = value.item as Record<string, unknown>;
    void _feedId;
    return { ...value, item };
  };
  return isDeepStrictEqual(normalize(left), normalize(right));
}
