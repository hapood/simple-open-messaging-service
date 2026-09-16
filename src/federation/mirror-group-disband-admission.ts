import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import { insertPendingTaskInTx } from '../durable-task/task-admission.js';
import {
  businessAccountScopeKey,
  lockBusinessAccountsInTx,
} from '../common/locks/account-business-lock.js';
import { groupStateSql } from '../group/shared/group-state.js';
import { systemAccountIdInTx } from '../user/system-account.js';

export interface AdmitMirrorGroupMembersDisbandInput {
  groupId: number;
  groupAccount: string;
  peerDomain: string;
  namespaceId: number;
}

export type AdmitMirrorGroupMembersDisbandResult =
  | { admitted: true; taskId: bigint }
  | { admitted: false; alreadyDissolved: true }
  | { admitted: false; taskId: bigint };

/** Admits — or finds the already-admitted — DISBAND_MIRROR_GROUP_MEMBERS parent for a
 * mirror whose origin denied an authorized read. Both denial triggers converge
 * here, so repeated denials collapse onto one parent instead of sweeping
 * concurrently. The captured authorization epoch fences the recoverable
 * tombstone write; the mirror identity is re-verified under its business scope. */
export async function admitMirrorGroupMembersDisbandInTx(
  tx: DatabaseTransaction,
  input: AdmitMirrorGroupMembersDisbandInput,
): Promise<AdmitMirrorGroupMembersDisbandResult> {
  const groupAddress = {
    account: input.groupAccount,
    domain: input.peerDomain,
  };
  await lockBusinessAccountsInTx(tx, [groupAddress]);
  const state = (
    await tx.execute<{
      dissolvedAt: string | null;
      authorizationEpoch: number;
    }>(sql`
      SELECT g."dissolvedAt" AS "dissolvedAt",
        thread."authorizationEpoch" AS "authorizationEpoch"
      FROM ${groupStateSql} g
      JOIN "MessageThread" thread ON thread.id = g.id
      WHERE g.id = ${input.groupId}
        AND g.account = ${input.groupAccount}
        AND g.domain = ${input.peerDomain}
        AND g."namespaceId" = ${input.namespaceId}
      LIMIT 1
    `)
  ).rows[0];
  if (!state) throw new Error('mirror disband group identity changed');
  if (state.dissolvedAt !== null)
    return { admitted: false, alreadyDissolved: true };
  const scopeKey = businessAccountScopeKey(groupAddress);
  const coalescingKey = JSON.stringify([
    DurableTaskType.DISBAND_MIRROR_GROUP_MEMBERS,
    input.groupId,
  ]);
  const blockers = await tx.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM "DurableTask"
    WHERE kind = 'MUTATION' AND "scopeKey" = ${scopeKey}
      AND "taskType" = ${DurableTaskType.DISBAND_MIRROR_GROUP_MEMBERS}
      AND "coalescingKey" = ${coalescingKey}
      AND status IN ('PENDING', 'PROCESSING')
    ORDER BY id
    FOR NO KEY UPDATE
  `);
  const existing = blockers.rows[0];
  if (existing) return { admitted: false, taskId: BigInt(existing.id) };
  const inserted = await insertPendingTaskInTx(tx, {
    kind: 'MUTATION',
    scopeType: 'GROUP',
    scopeKey,
    taskType: DurableTaskType.DISBAND_MIRROR_GROUP_MEMBERS,
    actorUserId: await systemAccountIdInTx(tx),
    payload: {
      threadId: input.groupId,
      groupAccount: input.groupAccount,
      peerDomain: input.peerDomain,
      namespaceId: input.namespaceId,
      expectedAuthorizationEpoch: state.authorizationEpoch,
    },
    coalescingKey,
  });
  return { admitted: true, taskId: inserted.taskId };
}
