import { Injectable } from '@nestjs/common';
import { inArray, sql } from 'drizzle-orm';
import { isValidGroupAccount, isValidSomfpDomain } from '../common/account.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { durableTask } from '../database/schema.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import {
  businessAccountScopeKey,
  lockBusinessAccountsInTx,
} from '../relationship/business-scope-lock.js';
import {
  type GroupMetaSyncTaskPayload,
  readGroupMetaSyncPayload,
} from './group-meta-sync-task.js';

export interface EnsureGroupMetaSyncInput {
  groupId: number;
  groupAccount: string;
  peerDomain: string;
  namespaceId: number;
  through: bigint;
}

export type EnsureGroupMetaSyncResult =
  | { ready: true; committedThrough: bigint }
  | { ready: false; taskId: bigint };

/** Creates or compacts the durable dependency required by one Group Meta head. */
@Injectable()
export class FederationGroupMetaTaskCoordinator {
  constructor(private readonly database: DatabaseService) {}

  async ensure(
    input: EnsureGroupMetaSyncInput,
  ): Promise<EnsureGroupMetaSyncResult> {
    validateInput(input);
    return this.database.db.transaction((tx) => this.ensureInTx(tx, input));
  }

  async ensureInTx(
    tx: DatabaseTransaction,
    input: EnsureGroupMetaSyncInput,
  ): Promise<EnsureGroupMetaSyncResult> {
    validateInput(input);
    const groupAddress = {
      account: input.groupAccount,
      domain: input.peerDomain,
    };
    const scopeKey = businessAccountScopeKey(groupAddress);
    const coalescingKey = JSON.stringify([
      DurableTaskType.SYNC_GROUP_META,
      input.groupId,
    ]);
    await lockBusinessAccountsInTx(tx, [groupAddress]);
    const stateResult = await tx.execute<{
      groupId: number;
      feedEndId: string | null;
    }>(sql`
        SELECT source.id AS "groupId", feed."feedEndId"
        FROM "Group" source
        LEFT JOIN "GroupMetaFeed" feed ON feed."groupId" = source.id
        WHERE source.id = ${input.groupId}
          AND source.account = ${input.groupAccount}
          AND source.domain = ${input.peerDomain}
          AND source."namespaceId" = ${input.namespaceId}
        FOR UPDATE OF source
      `);
    const state = stateResult.rows[0];
    if (!state) throw new Error('group-meta mirror identity changed');
    const committedThrough =
      state.feedEndId === null ? 0n : BigInt(state.feedEndId);
    if (committedThrough >= input.through)
      return { ready: true, committedThrough };

    const blockers = await tx.execute<{
      id: string;
      status: 'PENDING' | 'PROCESSING' | 'ASYNC_PROCESSING' | 'FAILED';
      payload: Record<string, unknown>;
    }>(sql`
        SELECT id, status, payload
        FROM "DurableTask"
        WHERE kind = 'PROJECTION'
          AND "scopeKey" = ${scopeKey}
          AND "taskType" = ${DurableTaskType.SYNC_GROUP_META}
          AND "coalescingKey" = ${coalescingKey}
          AND status IN ('PENDING', 'PROCESSING', 'ASYNC_PROCESSING', 'FAILED')
        ORDER BY id
        FOR UPDATE
      `);
    const failed = blockers.rows.find((task) => task.status === 'FAILED');
    if (failed)
      throw new Error(
        `group-meta sync lane is blocked by failed task ${failed.id.toString()}`,
      );
    const active = blockers.rows.find(
      (task) =>
        task.status === 'PROCESSING' || task.status === 'ASYNC_PROCESSING',
    );
    let activeThrough: bigint | null = null;
    if (active) {
      const activePayload = readGroupMetaSyncPayload(active.payload);
      assertSameMirror(activePayload, input);
      activeThrough = BigInt(activePayload.through);
      if (activeThrough >= input.through)
        return { ready: false, taskId: BigInt(active.id) };
    }

    const pending = blockers.rows.filter((task) => task.status === 'PENDING');
    let desiredThrough = input.through;
    for (const task of pending) {
      const payload = readGroupMetaSyncPayload(task.payload);
      assertSameMirror(payload, input);
      const pendingThrough = BigInt(payload.through);
      if (pendingThrough > desiredThrough) desiredThrough = pendingThrough;
    }
    const payload: Record<string, unknown> = {
      groupId: input.groupId,
      groupAccount: input.groupAccount,
      peerDomain: input.peerDomain,
      namespaceId: input.namespaceId,
      through: desiredThrough.toString(),
    };
    const after = activeThrough ?? committedThrough;
    const checkpoint = {
      phase: 'PULL',
      mode:
        state.feedEndId === null && activeThrough === null ? 'full' : 'delta',
      after: after.toString(),
      through: desiredThrough.toString(),
    } as const;
    const retained = pending[0];
    if (retained) {
      await tx
        .update(durableTask)
        .set({ payload, checkpoint })
        .where(
          sql`${durableTask.id} = ${BigInt(retained.id)} AND ${durableTask.status} = 'PENDING'`,
        );
      if (pending.length > 1)
        await tx
          .update(durableTask)
          .set({
            status: 'SUPERSEDED',
            supersededByTaskId: BigInt(retained.id),
            completedAt: sql`GREATEST(clock_timestamp(), ${durableTask.createdAt})`,
          })
          .where(
            inArray(
              durableTask.id,
              pending.slice(1).map((task) => BigInt(task.id)),
            ),
          );
      return { ready: false, taskId: BigInt(retained.id) };
    }
    const [inserted] = await tx
      .insert(durableTask)
      .values({
        kind: 'PROJECTION',
        scopeType: 'GROUP',
        scopeKey,
        taskType: DurableTaskType.SYNC_GROUP_META,
        actorUserId: null,
        payload,
        checkpoint,
        coalescingKey,
        status: 'PENDING',
      })
      .returning({ taskId: durableTask.id });
    if (!inserted)
      throw new Error('group-meta sync task insert returned no row');
    return { ready: false, taskId: inserted.taskId };
  }
}

function validateInput(input: EnsureGroupMetaSyncInput): void {
  if (!Number.isSafeInteger(input.groupId) || input.groupId <= 0)
    throw new TypeError('invalid group-meta mirror groupId');
  if (!isValidGroupAccount(input.groupAccount))
    throw new TypeError('invalid group-meta mirror account');
  if (!isValidSomfpDomain(input.peerDomain))
    throw new TypeError('invalid group-meta mirror domain');
  if (!Number.isSafeInteger(input.namespaceId) || input.namespaceId <= 0)
    throw new TypeError('invalid group-meta mirror namespaceId');
  if (input.through < 0n) throw new TypeError('invalid group-meta target');
}

function assertSameMirror(
  payload: GroupMetaSyncTaskPayload,
  input: EnsureGroupMetaSyncInput,
): void {
  if (
    payload.groupId !== input.groupId ||
    payload.groupAccount !== input.groupAccount ||
    payload.peerDomain !== input.peerDomain ||
    payload.namespaceId !== input.namespaceId
  )
    throw new Error('group-meta sync task mirror identity changed');
}
