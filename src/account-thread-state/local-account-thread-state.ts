import type { DatabaseTransaction } from '../database/database.service.js';
import { GroupRole } from '../database/enums.js';
import { accountThreadState } from '../database/schema.js';

/** Ensure the local Account conversation fact independently from the source-scoped roster. */
export async function ensureLocalAccountThreadStateInTx(
  tx: DatabaseTransaction,
  params: {
    threadId: number;
    localUserId: number;
    role: GroupRole;
  },
): Promise<number> {
  const [participant] = await tx
    .insert(accountThreadState)
    .values({
      accountId: params.localUserId,
      threadId: params.threadId,
      role: params.role,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [accountThreadState.accountId, accountThreadState.threadId],
      set: { role: params.role, updatedAt: new Date() },
    })
    .returning({ id: accountThreadState.id });
  if (!participant)
    throw new Error('local thread participant upsert disappeared');
  return participant.id;
}
