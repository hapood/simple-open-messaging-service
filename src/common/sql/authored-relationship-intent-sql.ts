import type { RequestSnapshot } from '../../../shared/request-snapshot.js';
import { sql } from 'drizzle-orm';
import type { RelationshipIntentStatus } from '../relationship-intent-state.js';

/** Parameterized authored-intent write shared by P2P and group membership relationships.
 * The caller owns the pair lock and validates the transition. The row is
 * identified by its author/receiver coordinates alone — no pair reference is
 * stored. Keep the authored profile reference across acceptance/revocation
 * unless the caller explicitly selects a revocation revision. Preserve revoked
 * heads independently of that profile selection. */
export function authoredIntentWriteSql(
  params: {
    author: { account: string; namespaceId: number };
    receiver: { account: string; namespaceId: number };
    threadId: number | null;
    note: string;
    requestedAt: Date | null;
    expiresAt: Date | null;
    requestId?: bigint | null;
    /** Explicit profile revision selected by an authorized revocation command. */
    profileRev?: number;
  } & (
    | { status: 'REQUESTED'; snapshot: RequestSnapshot }
    | { status: 'ACCEPTED' | 'REVOKED'; snapshot?: never }
  ),
) {
  const { status, requestedAt, expiresAt, profileRev } = params;
  const refreshRevocation = profileRev !== undefined;
  if (
    profileRev !== undefined &&
    (status !== 'REVOKED' ||
      !Number.isSafeInteger(profileRev) ||
      profileRev < 0 ||
      profileRev > 2_147_483_647)
  )
    throw new Error('invalid authored intent revocation profile revision');
  return sql`
      INSERT INTO "RelationshipIntent" (
        "requestId",
        "authorAccount", "authorNamespaceId", "receiverAccount", "receiverNamespaceId",
        status, "profileNamespaceId", "profileRev", note, "messageEndSeq", "tombstoneEndSeq",
        "requestedAt", "expiresAt", "updatedAt"
      ) VALUES (${params.requestId ?? null},
        ${params.author.account}, ${params.author.namespaceId},
        ${params.receiver.account}, ${params.receiver.namespaceId},
        ${status}::"RelationshipIntentStatus", 0,
        ${
          refreshRevocation
            ? sql`${profileRev}`
            : sql`COALESCE((
          SELECT CASE WHEN ${params.author.account} LIKE '!%' THEN
              (SELECT profile."defaultProfileRev" FROM "GroupAccount" profile
                WHERE profile.account = ${params.author.account} LIMIT 1)
            ELSE
              (SELECT profile."defaultProfileRev" FROM "Account" profile
                WHERE profile.account = ${params.author.account}
                  AND profile."namespaceId" = 0 LIMIT 1)
          END
        ), 0)`
        }, ${(params.note ?? '').slice(0, 255)},
        COALESCE((SELECT MAX(m.seq) FROM "Message" m
          WHERE m."threadId" = ${params.threadId} AND m."contentType" <> 'SYSTEM'), 0),
        COALESCE((SELECT MAX(d."deletionSeq") FROM "DeletedMessage" d
          JOIN "Message" m ON m."threadId" = d."threadId" AND m.seq = d."messageSeq"
          WHERE d."threadId" = ${params.threadId} AND d."publisherNamespaceId" = 0), 0),
        ${requestedAt}, ${expiresAt}, CURRENT_TIMESTAMP)
      ON CONFLICT ("authorAccount", "authorNamespaceId", "receiverAccount", "receiverNamespaceId") DO UPDATE SET
        "requestId" = CASE
          WHEN EXCLUDED.status = 'REQUESTED' THEN COALESCE(${params.requestId ?? null}, "RelationshipIntent"."requestId")
          ELSE "RelationshipIntent"."requestId"
        END,
        status = EXCLUDED.status,
        "messageEndSeq" = CASE WHEN EXCLUDED.status = 'REVOKED'
          THEN "RelationshipIntent"."messageEndSeq" ELSE EXCLUDED."messageEndSeq" END,
        "tombstoneEndSeq" = CASE WHEN EXCLUDED.status = 'REVOKED'
          THEN "RelationshipIntent"."tombstoneEndSeq" ELSE EXCLUDED."tombstoneEndSeq" END,
        "profileRev" = CASE
          WHEN EXCLUDED.status = 'REVOKED' AND ${refreshRevocation}
            THEN EXCLUDED."profileRev"
          WHEN EXCLUDED.status = 'REQUESTED' AND (
            "RelationshipIntent".status = 'REVOKED' OR
            "RelationshipIntent"."expiresAt" <= EXCLUDED."requestedAt"
          ) THEN EXCLUDED."profileRev"
          ELSE "RelationshipIntent"."profileRev"
        END,
        "note" = CASE
          WHEN "RelationshipIntent".status = 'REQUESTED' AND EXCLUDED.status = 'REQUESTED'
            AND "RelationshipIntent"."expiresAt" > EXCLUDED."requestedAt"
            THEN "RelationshipIntent".note
          ELSE EXCLUDED.note END,
        "requestedAt" = CASE
          WHEN "RelationshipIntent".status = 'REQUESTED' AND EXCLUDED.status = 'REQUESTED'
            AND "RelationshipIntent"."expiresAt" > EXCLUDED."requestedAt"
            THEN "RelationshipIntent"."requestedAt"
          WHEN EXCLUDED.status IN ('REQUESTED', 'ACCEPTED') THEN EXCLUDED."requestedAt"
          ELSE "RelationshipIntent"."requestedAt" END,
        "expiresAt" = CASE
          WHEN "RelationshipIntent".status = 'REQUESTED' AND EXCLUDED.status = 'REQUESTED'
            AND "RelationshipIntent"."expiresAt" > EXCLUDED."requestedAt"
            THEN "RelationshipIntent"."expiresAt"
          ELSE EXCLUDED."expiresAt" END,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE (EXCLUDED.status = 'REQUESTED' AND "RelationshipIntent".status = 'REQUESTED'
           AND "RelationshipIntent"."expiresAt" <= EXCLUDED."requestedAt")
         OR "RelationshipIntent".status IS DISTINCT FROM EXCLUDED.status
         OR ("RelationshipIntent".status <> 'REQUESTED' AND "RelationshipIntent".note IS DISTINCT FROM EXCLUDED.note)
         OR ("RelationshipIntent".status <> 'REQUESTED' AND "RelationshipIntent"."expiresAt" IS DISTINCT FROM EXCLUDED."expiresAt")
         OR (${refreshRevocation} AND EXCLUDED.status = 'REVOKED'
           AND "RelationshipIntent"."profileRev" IS DISTINCT FROM EXCLUDED."profileRev")
      RETURNING "authorAccount", "authorNamespaceId", status, "profileNamespaceId", "profileRev", note, "requestedAt", "expiresAt",
        "messageEndSeq", "tombstoneEndSeq"
  `;
}
