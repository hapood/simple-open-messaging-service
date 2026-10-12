import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../../database/database.service.js';
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
    account.namespaceId,
    subject.account,
    subject.domain,
  ]);
}

export function reverseRequestUnexpired(
  row: UserIntentAuthorizationRow,
  now = Date.now(),
): boolean {
  return (
    row.reverseExpiresAt !== null &&
    new Date(row.reverseExpiresAt).getTime() > now
  );
}

export function ownRequestUnexpired(
  row: UserIntentAuthorizationRow,
  now = Date.now(),
): boolean {
  return (
    row.ownExpiresAt !== null && new Date(row.ownExpiresAt).getTime() > now
  );
}

/** Whether the reverse direction is currently a positive relationship fact. */
export function reverseEffective(
  row: UserIntentAuthorizationRow,
  now = Date.now(),
): boolean {
  return (
    row.reverseStatus === 'ACCEPTED' ||
    (row.reverseStatus === 'REQUESTED' && reverseRequestUnexpired(row, now))
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

/** Apply positive participant state after intent persistence, in the owning
 * transaction. Activation uses the boundary captured before its system message.
 * This is a separate statement because the participant trigger and composed
 * feed allocation both write Account rows. Existing participants are locked
 * before the composed write; newly inserted cursors use the peer declaration. */
export async function resetUserIntentThreadStateInTx(
  tx: DatabaseTransaction,
  threadId: number,
  actor: UserIntentEndpoint,
  target: UserIntentEndpoint,
  options: { activate: boolean; boundarySeq: number },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO "AccountThreadState" ("accountId", "threadId", "threadProfileRev", "lastReadSeq")
    SELECT v."accountId", ${threadId}, COALESCE(i."profileRev", 0),
      CASE WHEN ${options.activate} THEN ${options.boundarySeq} ELSE 0 END
    FROM (
      SELECT a.id AS "accountId", a.account AS "viewerAccount",
        ${target.account}::text AS "peerAccount", ${target.namespaceId}::integer AS "peerNamespaceId"
      FROM "Account" a WHERE a."namespaceId" = 0 AND a.account = ${actor.account}
      UNION ALL
      SELECT a.id, a.account, ${actor.account}::text, 0
      FROM "Account" a WHERE a."namespaceId" = 0 AND a.account = ${target.account}
        AND ${target.namespaceId} = 0
    ) v LEFT JOIN "RelationshipIntent" i
      ON i."authorAccount" = v."peerAccount" AND i."authorNamespaceId" = v."peerNamespaceId"
      AND i."receiverAccount" = v."viewerAccount" AND i."receiverNamespaceId" = 0
    ON CONFLICT ("accountId", "threadId") DO UPDATE SET
      "messageVisibleThroughSeq" = NULL,
      "threadProfileRev" = CASE WHEN ${options.activate} THEN EXCLUDED."threadProfileRev"
        ELSE "AccountThreadState"."threadProfileRev" END,
      "lastReadSeq" = CASE WHEN ${options.activate}
        THEN GREATEST("AccountThreadState"."lastReadSeq",
          LEAST(${options.boundarySeq}, COALESCE("AccountThreadState"."messageVisibleThroughSeq", ${options.boundarySeq})))
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
    WHERE s."threadId" = ${threadId} AND a."namespaceId" = 0
      AND ((a.account = ${actor.account})
        OR (a.account = ${target.account} AND ${target.namespaceId} = 0))
    ORDER BY s."accountId" FOR NO KEY UPDATE OF s
  `);
}
