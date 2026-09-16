import { sql } from 'drizzle-orm';

export interface MirrorMembershipStateRow extends Record<string, unknown> {
  threadId: number;
  curSeq: string;
  dissolvedAt: string | null;
  pairId: string | null;
  pairActive: boolean;
  established: boolean;
  groupIntentStatus: 'REQUESTED' | 'ACCEPTED' | 'REVOKED' | null;
  groupIntentExpiresAt: string | null;
  memberIntentStatus: 'REQUESTED' | 'ACCEPTED' | 'REVOKED' | null;
  memberIntentExpiresAt: string | null;
  memberNote: string | null;
  memberProfileRev: number | null;
  localMemberId: number | null;
}

/** One pre-lock locator + one post-lock state read in a single statement. The
 * thread is the mirror group anchor (`ensureMirrorGroupShellInTx` guarantees it
 * exists before the post-lock read re-runs). A mirror owns no GroupAccount,
 * GroupMeta, manager set, or capacity: the read covers exactly the pair, both
 * intents, the thread tail, dissolution, and the local member account. */
export function mirrorMembershipStateSql(input: {
  threadId: number;
  groupAccount: string;
  groupDomain: string;
  groupNamespaceId: number;
  memberAccount: string;
}) {
  return sql`
    WITH pair AS MATERIALIZED (
      SELECT p.id, p.active, p.established FROM "RelationshipPair" p
      WHERE p."threadId" = ${input.threadId} AND p.kind = 'GROUP_MEMBER'
        AND p."endpointAType" = 'GROUP' AND p."endpointAAccount" = ${input.groupAccount}
        AND p."endpointADomain" = ${input.groupDomain}
        AND p."endpointANamespaceId" = ${input.groupNamespaceId}
        AND p."endpointBType" = 'USER' AND p."endpointBAccount" = ${input.memberAccount}
        AND p."endpointBDomain" = 'local'
        AND p."endpointBNamespaceId" = ${input.groupNamespaceId}
      LIMIT 1
    ), intents AS MATERIALIZED (
      SELECT i."authorSide", i.status, i."expiresAt", i.note, i."profileRev"
      FROM "RelationshipIntent" i
      WHERE EXISTS (SELECT 1 FROM pair) AND i."pairId" = (SELECT id FROM pair)
    )
    SELECT t.id AS "threadId", t."curSeq"::text AS "curSeq",
      t."groupDissolvedAt"::text AS "dissolvedAt",
      (SELECT id::text FROM pair) AS "pairId",
      COALESCE((SELECT active FROM pair), false) AS "pairActive",
      COALESCE((SELECT established FROM pair), false) AS established,
      (SELECT status FROM intents WHERE "authorSide" = 'A') AS "groupIntentStatus",
      (SELECT "expiresAt"::text FROM intents WHERE "authorSide" = 'A') AS "groupIntentExpiresAt",
      (SELECT status FROM intents WHERE "authorSide" = 'B') AS "memberIntentStatus",
      (SELECT "expiresAt"::text FROM intents WHERE "authorSide" = 'B') AS "memberIntentExpiresAt",
      (SELECT note FROM intents WHERE "authorSide" = 'B') AS "memberNote",
      (SELECT "profileRev" FROM intents WHERE "authorSide" = 'B') AS "memberProfileRev",
      (SELECT id FROM "Account"
        WHERE account = ${input.memberAccount} AND domain = 'local' AND "namespaceId" = 0
        LIMIT 1) AS "localMemberId"
    FROM "MessageThread" t
    WHERE t.id = ${input.threadId}
  `;
}
