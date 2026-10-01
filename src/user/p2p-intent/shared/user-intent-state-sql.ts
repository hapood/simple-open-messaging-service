import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../../database/database.service.js';
import type { ThreadContentLock } from '../../../common/locks/thread-content-lock.js';
import type { UserIntentAuthorizationRow } from '../authored/user-intent-authorization-sql.js';

/** One P2P endpoint identity. The domain is carried for feed keys and
 * display only — locality is always judged by namespaceId === 0. Pairs
 * persist no per-endpoint domain or namespace; the remote endpoint's
 * namespace lives once in the pair's endpointBNamespaceId. */
export interface UserIntentEndpoint {
  account: string;
  domain: string;
  /** The endpoint's own identity namespace; local endpoints are always 0. */
  namespaceId: number;
}

/** Canonical side order: a local–federated pair always puts the local
 * endpoint (namespace 0) on side A; a local–local pair orders endpoints by
 * account string. */
export function compareEndpoints(
  left: UserIntentEndpoint,
  right: UserIntentEndpoint,
): number {
  const leftLocal = left.namespaceId === 0;
  const rightLocal = right.namespaceId === 0;
  if (leftLocal !== rightLocal) return leftLocal ? -1 : 1;
  return (
    left.account.localeCompare(right.account) ||
    left.namespaceId - right.namespaceId
  );
}

/** The single peer namespace a pair persists: the remote endpoint's own
 * namespace, or 0 when both endpoints are local. */
export function pairPeerNamespaceId(
  actor: UserIntentEndpoint,
  target: UserIntentEndpoint,
): number {
  const actorLocal = actor.namespaceId === 0;
  const targetLocal = target.namespaceId === 0;
  if (actorLocal && targetLocal) return 0;
  return actorLocal ? target.namespaceId : actor.namespaceId;
}

/** ClientStateFeedService.compactionKey's exact shape, keyed by the canonical
 * pair side — never by the command actor (the mixed-writer lesson). */
export function userIntentCompactionKey(
  namespaceId: number,
  account: UserIntentEndpoint,
  subject: UserIntentEndpoint,
): string {
  return JSON.stringify([
    'RELATIONSHIP_INTENT',
    namespaceId,
    account.account,
    account.domain,
    subject.account,
    subject.domain,
  ]);
}

export function reverseRequestUnexpired(
  row: UserIntentAuthorizationRow,
): boolean {
  return (
    row.reverseExpiresAt !== null &&
    new Date(row.reverseExpiresAt).getTime() > Date.now()
  );
}

export function ownRequestUnexpired(row: UserIntentAuthorizationRow): boolean {
  return (
    row.ownExpiresAt !== null &&
    new Date(row.ownExpiresAt).getTime() > Date.now()
  );
}

/** Whether the reverse direction is currently a positive relationship fact. */
export function reverseEffective(row: UserIntentAuthorizationRow): boolean {
  return (
    row.reverseStatus === 'ACCEPTED' ||
    (row.reverseStatus === 'REQUESTED' && reverseRequestUnexpired(row))
  );
}

/** Lock the canonical P2P pair row, minting it when absent. Side A is the
 * local endpoint for a mixed pair, and the pair stores one peer namespace.
 * The conflicting DO UPDATE always takes the row lock, so no separate select
 * follows. Returns the locked pair id and its current thread binding. */
export async function lockOrMintUserPairInTx(
  tx: DatabaseTransaction,
  pairId: bigint | null,
  actor: UserIntentEndpoint,
  target: UserIntentEndpoint,
): Promise<{ pairId: bigint; threadId: number | null }> {
  if (pairId !== null) {
    const locked = await tx.execute<{ id: string; threadId: number | null }>(
      sql`SELECT id::text, "threadId" FROM "RelationshipPair" WHERE id = ${pairId} FOR NO KEY UPDATE`,
    );
    if (!locked.rows[0]) throw new Error('relationship pair lock disappeared');
    return { pairId, threadId: locked.rows[0].threadId };
  }
  const [endpointA, endpointB] =
    compareEndpoints(actor, target) < 0 ? [actor, target] : [target, actor];
  const minted = await tx.execute<{ id: string }>(sql`
    INSERT INTO "RelationshipPair"
      (kind, "endpointAType", "endpointAAccount", "endpointBType", "endpointBAccount", "endpointBNamespaceId")
    VALUES ('P2P', 'USER', ${endpointA.account}, 'USER', ${endpointB.account},
      ${pairPeerNamespaceId(actor, target)})
    ON CONFLICT ("endpointAType", "endpointAAccount", "endpointBType", "endpointBAccount", "endpointBNamespaceId")
    DO UPDATE SET "updatedAt" = CURRENT_TIMESTAMP
    RETURNING id
  `);
  return { pairId: BigInt(minted.rows[0]!.id), threadId: null };
}

/** Lock the local Account rows the composed statements allocate client feed
 * ids from, in id order (the implicit client-feed allocator order). */
export async function lockUserIntentAccountsInTx(
  tx: DatabaseTransaction,
  ids: number[],
): Promise<void> {
  if (ids.length === 0) return;
  await tx.execute(
    sql`SELECT id FROM "Account" WHERE id = ANY(${sql.param(ids)}::integer[]) ORDER BY id FOR NO KEY UPDATE`,
  );
}

/** Mint the structurally complete, non-visible P2P shell when the pair has
 * none and bind it; returns the thread id either way. Mirrors
 * ensureP2PThreadShellInTx's mint step; the participant reset happens in
 * resetUserIntentThreadStateInTx. */
export async function ensureThreadShellInTx(
  tx: DatabaseTransaction,
  pairId: bigint,
  boundThreadId: number | null,
  authorityNamespaceId: number,
): Promise<number> {
  if (boundThreadId) return boundThreadId;
  const result = await tx.execute<{ threadId: number }>(sql`
    WITH fresh AS (
      INSERT INTO "MessageThread" (type, "authorityNamespaceId", "updatedAt")
      VALUES ('P2P'::"MessageThreadType", ${authorityNamespaceId}::integer, CURRENT_TIMESTAMP)
      RETURNING id
    ), bound AS (
      UPDATE "RelationshipPair" p SET "threadId" = f.id, "updatedAt" = CURRENT_TIMESTAMP
      FROM fresh f WHERE p.id = ${pairId}
      RETURNING p."threadId"
    )
    SELECT "threadId" FROM bound
  `);
  const threadId = result.rows[0]?.threadId;
  if (!threadId) throw new Error('P2P thread shell is missing');
  return threadId;
}

/** A revocation enters an existing relationship; its thread must exist. */
export function requireExistingThreadId(threadId: number | null): number {
  if (!threadId) throw new Error('P2P relationship has no retained thread');
  return threadId;
}

/** Positive directions reset the participant state; an activation additionally
 * starts read at the current boundary. This lives in its own statement because the
 * participant trigger writes the same Account rows the composed statement's
 * feed allocation writes, and one statement may not touch that row twice.
 * The reused rows double as this command's participant locks. */
export async function resetUserIntentThreadStateInTx(
  tx: DatabaseTransaction,
  threadId: number,
  actor: UserIntentEndpoint,
  target: UserIntentEndpoint,
  options: { activate: boolean },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO "AccountThreadState" ("accountId", "threadId")
    SELECT a.id, ${threadId} FROM "Account" a
    WHERE a.domain = 'local' AND a."namespaceId" = 0
      AND ((a.account = ${actor.account})
        OR (a.account = ${target.account} AND ${target.domain} = 'local'))
    ON CONFLICT ("accountId", "threadId") DO UPDATE SET
      "messageVisibleThroughSeq" = NULL,
      "lastReadSeq" = CASE WHEN ${options.activate}
        THEN GREATEST("AccountThreadState"."lastReadSeq",
          LEAST((SELECT t."curSeq" FROM "MessageThread" t WHERE t.id = ${threadId}),
            COALESCE("AccountThreadState"."messageVisibleThroughSeq",
              (SELECT t."curSeq" FROM "MessageThread" t WHERE t.id = ${threadId}))))
        ELSE "AccountThreadState"."lastReadSeq" END,
      "unreadCount" = CASE WHEN ${options.activate} THEN 0
        ELSE "AccountThreadState"."unreadCount" END,
      "previewSeqs" = CASE WHEN ${options.activate} THEN '{}'::integer[]
        ELSE "AccountThreadState"."previewSeqs" END,
      "lastMentionSeq" = CASE WHEN ${options.activate} THEN NULL
        ELSE "AccountThreadState"."lastMentionSeq" END,
      "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "accountId"
  `);
}

/** Lock the participants' thread state without touching it (the REVOKED entry). */
export async function lockUserIntentThreadStateInTx(
  tx: DatabaseTransaction,
  threadId: number,
  actor: UserIntentEndpoint,
  target: UserIntentEndpoint,
): Promise<void> {
  await tx.execute(sql`
    SELECT s."accountId" FROM "AccountThreadState" s
    JOIN "Account" a ON a.id = s."accountId"
    WHERE s."threadId" = ${threadId} AND a.domain = 'local' AND a."namespaceId" = 0
      AND ((a.account = ${actor.account})
        OR (a.account = ${target.account} AND ${target.domain} = 'local'))
    ORDER BY s."accountId" FOR NO KEY UPDATE OF s
  `);
}
