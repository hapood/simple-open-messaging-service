import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { lockBusinessAccountsInTx } from './business-scope-lock.js';

const acquired = Symbol('thread content lock');

/** A lexical capability: reuse only in its transaction and while its acquiring savepoint remains valid. */
export interface ThreadContentLock {
  readonly [acquired]: true;
  readonly tx: DatabaseTransaction;
  readonly threadId: number;
}

export async function requireThreadContentLockInTx(
  tx: DatabaseTransaction,
  threadId: number,
  held?: ThreadContentLock,
): Promise<ThreadContentLock> {
  if (held) {
    if (held[acquired] !== true || held.tx !== tx || held.threadId !== threadId)
      throw new Error(
        'thread content lock belongs to another transaction or thread',
      );
    return held;
  }
  const lock = await acquireThreadContentLockInTx(tx, threadId);
  if (!lock) throw new Error(`thread ${threadId} does not exist`);
  return lock;
}

export async function acquireThreadContentLockInTx(
  tx: DatabaseTransaction,
  threadId: number,
): Promise<ThreadContentLock | undefined> {
  return (await lockThreadContentInTx(tx, threadId))
    ? { [acquired]: true, tx, threadId }
    : undefined;
}

/** Acquire parent locks before the thread, including parents referenced by implicit FK checks.
 * Repeated calls in one transaction are safe; callers must enter before taking content-row locks. */
export async function lockThreadContentInTx(
  tx: DatabaseTransaction,
  threadId: number,
): Promise<boolean> {
  const located = await tx.execute<{
    type: string;
    groupId: number | null;
    account: string | null;
    domain: string | null;
  }>(sql`
    SELECT thread.type, thread."groupId", parent.account, parent.domain
    FROM "MessageThread" thread
    LEFT JOIN "Group" parent ON parent.id = thread."groupId"
    WHERE thread.id = ${threadId}
  `);
  const thread = located.rows[0];
  if (!thread) return false;
  if (thread.type === 'GROUP') {
    if (
      thread.groupId === null ||
      thread.account === null ||
      thread.domain === null
    )
      throw new Error('group content parent is missing');
    await lockBusinessAccountsInTx(tx, [
      { account: thread.account, domain: thread.domain },
    ]);
    await tx.execute(
      sql`SELECT id FROM "Group" WHERE id = ${thread.groupId} FOR UPDATE`,
    );
  } else {
    const pairs = await tx.execute<{
      id: string;
      endpointAAccount: string;
      endpointADomain: string;
      endpointBAccount: string;
      endpointBDomain: string;
    }>(sql`
      SELECT id, "endpointAAccount", "endpointADomain", "endpointBAccount", "endpointBDomain"
      FROM "RelationshipPair" WHERE kind = 'P2P' AND "threadId" = ${threadId}
      ORDER BY id
    `);
    if (pairs.rows.length > 1)
      throw new Error('P2P content has multiple relationship pairs');
    const pair = pairs.rows[0];
    if (pair) {
      await lockBusinessAccountsInTx(tx, [
        { account: pair.endpointAAccount, domain: pair.endpointADomain },
        { account: pair.endpointBAccount, domain: pair.endpointBDomain },
      ]);
      await tx.execute(
        sql`SELECT id FROM "RelationshipPair" WHERE id = ${pair.id} AND "threadId" = ${threadId} FOR UPDATE`,
      );
    }
    // An unbound shell has no relationship parent yet. Authorization remains the caller's responsibility.
  }
  const locked = await tx.execute(
    sql`SELECT id FROM "MessageThread" WHERE id = ${threadId} FOR UPDATE`,
  );
  return locked.rows.length > 0;
}
