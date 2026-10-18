import { sql, type SQL } from 'drizzle-orm';

export interface ReceivedUserIntentWriteInput {
  author: { account: string; namespaceId: number };
  receiver: { account: string; namespaceId: number };
  status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED';
  profileNamespaceId: number;
  profileRev: number;
  note: string;
  requestedAt: Date | null;
  expiresAt: Date | null;
  messageEndSeq?: number;
  tombstoneEndSeq?: number;
}

/** Persist one peer-authored wire snapshot. The row is identified by its
 * author/receiver coordinates alone — no pair reference is stored. REVOKED
 * retains the last positive thread heads; profile identity advances only when
 * a revoked direction starts a new request interval, matching the established
 * remote-apply contract. The caller owns the pair/intent locks. */
export function receivedUserIntentWriteSql(
  input: ReceivedUserIntentWriteInput,
): SQL {
  const revoked = input.status === 'REVOKED';
  return sql`
    INSERT INTO "RelationshipIntent" (
      "authorAccount", "authorNamespaceId", "receiverAccount", "receiverNamespaceId",
      status, "profileNamespaceId", "profileRev", note, "messageEndSeq", "tombstoneEndSeq",
      "requestedAt", "expiresAt", "updatedAt"
    ) VALUES (${input.author.account}, ${input.author.namespaceId},
      ${input.receiver.account}, ${input.receiver.namespaceId},
      ${input.status}::"RelationshipIntentStatus", ${input.profileNamespaceId}, ${input.profileRev}, ${input.note.slice(0, 255)},
      ${revoked ? 0 : input.messageEndSeq!}, ${revoked ? 0 : input.tombstoneEndSeq!},
      ${input.requestedAt}, ${input.expiresAt}, CURRENT_TIMESTAMP)
    ON CONFLICT ("authorAccount", "authorNamespaceId", "receiverAccount", "receiverNamespaceId") DO UPDATE SET
      status = EXCLUDED.status, note = EXCLUDED.note,
      "messageEndSeq" = CASE WHEN EXCLUDED.status = 'REVOKED'
        THEN "RelationshipIntent"."messageEndSeq" ELSE EXCLUDED."messageEndSeq" END,
      "tombstoneEndSeq" = CASE WHEN EXCLUDED.status = 'REVOKED'
        THEN "RelationshipIntent"."tombstoneEndSeq" ELSE EXCLUDED."tombstoneEndSeq" END,
      "profileRev" = CASE
        WHEN "RelationshipIntent".status = 'REVOKED' AND EXCLUDED.status = 'REQUESTED'
          THEN EXCLUDED."profileRev"
        ELSE "RelationshipIntent"."profileRev"
      END,
      "requestedAt" = EXCLUDED."requestedAt", "expiresAt" = EXCLUDED."expiresAt",
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE (EXCLUDED.status <> 'REVOKED' AND (
         "RelationshipIntent"."messageEndSeq" IS DISTINCT FROM EXCLUDED."messageEndSeq"
         OR "RelationshipIntent"."tombstoneEndSeq" IS DISTINCT FROM EXCLUDED."tombstoneEndSeq"))
       OR "RelationshipIntent".status IS DISTINCT FROM EXCLUDED.status
       OR "RelationshipIntent".note IS DISTINCT FROM EXCLUDED.note
       OR "RelationshipIntent"."requestedAt" IS DISTINCT FROM EXCLUDED."requestedAt"
       OR "RelationshipIntent"."expiresAt" IS DISTINCT FROM EXCLUDED."expiresAt"
    RETURNING "authorAccount", "authorNamespaceId", status, "profileNamespaceId", "profileRev", note, "requestedAt", "expiresAt", snapshot,
      "messageEndSeq", "tombstoneEndSeq"
  `;
}
