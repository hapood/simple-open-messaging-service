import { sql } from 'drizzle-orm';
import type { RelationshipIntentStatus } from '../relationship-intent-state.js';

/** Parameterized authored-intent write shared by P2P and group membership relationships.
 * The caller owns the pair lock and validates the transition.
 * Keep the authored profile reference across acceptance/revocation and preserve revoked heads. */
export function authoredIntentWriteSql(params: {
  pair: { id: bigint; threadId: number };
  authorSide: 'A' | 'B';
  status: RelationshipIntentStatus;
  note: string;
  requestedAt: Date | null;
  expiresAt: Date | null;
}) {
  const { status, requestedAt, expiresAt } = params;
  return sql`
      INSERT INTO "RelationshipIntent" (
        "pairId", "authorSide", status, "profileRev", note, "messageEndSeq", "tombstoneEndSeq",
        "requestedAt", "expiresAt", "updatedAt"
      ) VALUES (${params.pair.id}, ${params.authorSide},
        ${status}::"RelationshipIntentStatus",
        COALESCE((
          SELECT CASE
            WHEN ${params.authorSide} = 'A' AND pair."endpointAType" = 'USER' THEN
              (SELECT profile."defaultProfileRev" FROM "Account" profile
                WHERE profile.account = pair."endpointAAccount" AND profile.domain = 'local'
                  AND profile."namespaceId" = 0 LIMIT 1)
            WHEN ${params.authorSide} = 'B' AND pair."endpointBType" = 'USER' THEN
              (SELECT profile."defaultProfileRev" FROM "Account" profile
                WHERE profile.account = pair."endpointBAccount" AND profile.domain = 'local'
                  AND profile."namespaceId" = 0 LIMIT 1)
            WHEN ${params.authorSide} = 'A' AND pair."endpointAType" = 'GROUP' THEN
              (SELECT profile."defaultProfileRev" FROM "GroupAccount" profile
                WHERE profile.account = pair."endpointAAccount" LIMIT 1)
            WHEN ${params.authorSide} = 'B' AND pair."endpointBType" = 'GROUP' THEN
              (SELECT profile."defaultProfileRev" FROM "GroupAccount" profile
                WHERE profile.account = pair."endpointBAccount" LIMIT 1)
          END
          FROM "RelationshipPair" pair WHERE pair.id = ${params.pair.id}
         ), 0), ${(params.note ?? '').slice(0, 255)},
        COALESCE((SELECT MAX(m.seq) FROM "Message" m
          WHERE m."threadId" = ${params.pair.threadId} AND m."contentType" <> 'SYSTEM'), 0),
        COALESCE((SELECT MAX(d."deletionSeq") FROM "DeletedMessage" d
          JOIN "Message" m ON m."threadId" = d."threadId" AND m.seq = d."messageSeq"
          WHERE d."threadId" = ${params.pair.threadId} AND d."sourceNamespaceId" = 0), 0),
        ${requestedAt}, ${expiresAt}, CURRENT_TIMESTAMP)
      ON CONFLICT ("pairId", "authorSide") DO UPDATE SET
        status = EXCLUDED.status, note = EXCLUDED.note,
        "messageEndSeq" = CASE WHEN EXCLUDED.status = 'REVOKED'
          THEN "RelationshipIntent"."messageEndSeq" ELSE EXCLUDED."messageEndSeq" END,
        "tombstoneEndSeq" = CASE WHEN EXCLUDED.status = 'REVOKED'
          THEN "RelationshipIntent"."tombstoneEndSeq" ELSE EXCLUDED."tombstoneEndSeq" END,
        "profileRev" = CASE
          WHEN "RelationshipIntent".status = 'REVOKED'
            AND EXCLUDED.status = 'REQUESTED' THEN EXCLUDED."profileRev"
          ELSE "RelationshipIntent"."profileRev"
        END,
        "requestedAt" = CASE
          WHEN EXCLUDED.status IN ('REQUESTED', 'ACCEPTED') THEN EXCLUDED."requestedAt"
          ELSE "RelationshipIntent"."requestedAt" END,
        "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = CURRENT_TIMESTAMP
      WHERE "RelationshipIntent".status IS DISTINCT FROM EXCLUDED.status
         OR "RelationshipIntent".note IS DISTINCT FROM EXCLUDED.note
         OR "RelationshipIntent"."expiresAt" IS DISTINCT FROM EXCLUDED."expiresAt"
      RETURNING id, status, "profileRev", note, "requestedAt", "expiresAt",
        "messageEndSeq", "tombstoneEndSeq"
  `;
}
