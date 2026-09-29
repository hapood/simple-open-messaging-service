import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service.js';
import { lockBusinessAccountsInTx } from './account-business-lock.js';

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

/** The caller holds the P2P business scopes and pair row for the whole transaction.
 * Lock only the child thread; do not reacquire its already-held parents. */
export async function requireP2PThreadContentLockUnderPairInTx(
  tx: DatabaseTransaction,
  pairId: bigint,
  threadId: number,
): Promise<ThreadContentLock> {
  const locked = await tx.execute(sql`
    SELECT thread.id FROM "MessageThread" thread
    JOIN "RelationshipPair" pair ON pair."threadId" = thread.id
    WHERE thread.id = ${threadId} AND thread.type = 'P2P'
      AND pair.id = ${pairId} AND pair.kind = 'P2P'
    FOR NO KEY UPDATE OF thread
  `);
  if (locked.rows.length !== 1)
    throw new Error('P2P content thread does not belong to the locked pair');
  return { [acquired]: true, tx, threadId };
}

/** Acquire the child row after the caller has locked the group business scope. */
export async function requireGroupThreadContentLockUnderGroupInTx(
  tx: DatabaseTransaction,
  groupId: number,
  threadId: number,
): Promise<ThreadContentLock> {
  const locked = await tx.execute(sql`
    SELECT id FROM "MessageThread"
    WHERE id = ${threadId} AND id = ${groupId} AND type = 'GROUP'
    FOR NO KEY UPDATE
  `);
  if (locked.rows.length !== 1)
    throw new Error('group relationship thread does not exist');
  return { [acquired]: true, tx, threadId };
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
    SELECT thread.type, thread.id AS "groupId", thread."groupAccount" AS account, thread."groupDomain" AS domain
    FROM "MessageThread" thread
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
  } else {
    const pairs = await tx.execute<{
      id: string;
      endpointAAccount: string;
      endpointADomain: string;
      endpointBAccount: string;
      endpointBDomain: string;
    }>(sql`
      SELECT pair.id::text AS id, pair."endpointAAccount", a_ns.domain AS "endpointADomain",
        pair."endpointBAccount", b_ns.domain AS "endpointBDomain"
      FROM "RelationshipPair" pair
      JOIN "IdentityNamespace" a_ns ON a_ns.id = pair."endpointANamespaceId"
      JOIN "IdentityNamespace" b_ns ON b_ns.id = pair."endpointBNamespaceId"
      WHERE pair.kind = 'P2P' AND pair."threadId" = ${threadId}
      ORDER BY pair.id
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
        sql`SELECT id FROM "RelationshipPair" WHERE id = ${pair.id} AND "threadId" = ${threadId} FOR NO KEY UPDATE`,
      );
    }
    // An unbound shell has no relationship parent yet. Authorization remains the caller's responsibility.
  }
  const locked = await tx.execute(
    sql`SELECT id FROM "MessageThread" WHERE id = ${threadId} FOR NO KEY UPDATE`,
  );
  return locked.rows.length > 0;
}
