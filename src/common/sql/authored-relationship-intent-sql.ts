import { sql } from 'drizzle-orm';
import type { RelationshipIntentStatus } from '../relationship-intent-state.js';

/** Parameterized authored-intent write shared by P2P and group membership relationships.
 * The caller owns the pair lock and validates the transition. The row is
 * identified by its author/receiver coordinates alone — no pair reference is
 * stored. Keep the authored profile reference across acceptance/revocation and
 * preserve revoked heads. */
export function authoredIntentWriteSql(params: {
  author: { account: string; namespaceId: number };
  receiver: { account: string; namespaceId: number };
  threadId: number | null;
  status: RelationshipIntentStatus;
  note: string;
  requestedAt: Date | null;
  expiresAt: Date | null;
}) {
  const { status, requestedAt, expiresAt } = params;
  return sql`
      INSERT INTO "RelationshipIntent" (
        "authorAccount", "authorNamespaceId", "receiverAccount", "receiverNamespaceId",
        status, "profileNamespaceId", "profileRev", note, "messageEndSeq", "tombstoneEndSeq",
        "requestedAt", "expiresAt", "updatedAt"
      ) VALUES (${params.author.account}, ${params.author.namespaceId},
        ${params.receiver.account}, ${params.receiver.namespaceId},
        ${status}::"RelationshipIntentStatus", 0,
        COALESCE((
          SELECT CASE WHEN ${params.author.account} LIKE '!%' THEN
              (SELECT profile."defaultProfileRev" FROM "GroupAccount" profile
                WHERE profile.account = ${params.author.account} LIMIT 1)
            ELSE
              (SELECT profile."defaultProfileRev" FROM "Account" profile
                WHERE profile.account = ${params.author.account}
                  AND profile.domain = 'local'
                  AND profile."namespaceId" = 0 LIMIT 1)
          END
        ), 0), ${(params.note ?? '').slice(0, 255)},
        COALESCE((SELECT MAX(m.seq) FROM "Message" m
          WHERE m."threadId" = ${params.threadId} AND m."contentType" <> 'SYSTEM'), 0),
        COALESCE((SELECT MAX(d."deletionSeq") FROM "DeletedMessage" d
          JOIN "Message" m ON m."threadId" = d."threadId" AND m.seq = d."messageSeq"
          WHERE d."threadId" = ${params.threadId} AND d."sourceNamespaceId" = 0), 0),
        ${requestedAt}, ${expiresAt}, CURRENT_TIMESTAMP)
      ON CONFLICT ("authorAccount", "authorNamespaceId", "receiverAccount", "receiverNamespaceId") DO UPDATE SET
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
      RETURNING status, "profileRev", note, "requestedAt", "expiresAt",
        "messageEndSeq", "tombstoneEndSeq"
  `;
}
