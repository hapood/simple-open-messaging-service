import { sql } from 'drizzle-orm';
import type { RelationshipIntentStatus } from '../../../common/relationship-intent-state.js';

/** Wire-carried intent coordinates applied verbatim on a mirror. The authored
 * fragment (`authoredIntentWriteSql`) derives the profile reference and thread
 * heads from GroupAccount and the local tail, which is wrong on a mirror: the
 * coordinates are the origin's. Change detection covers every wire field so a
 * repeated identical item neither writes nor wakes. */
export interface IntentEndpointCoordinates {
  account: string;
  namespaceId: number;
}

/** The received direction's coordinates on a mirror: the remote group is the
 * author and the local member is the receiver (side A of the old pair layout). */
export function mirrorGroupDirection(
  presentation: { groupAccount: string; groupNamespaceId: number },
  memberAccount: string,
): {
  author: IntentEndpointCoordinates;
  receiver: IntentEndpointCoordinates;
} {
  return {
    author: {
      account: presentation.groupAccount,
      namespaceId: presentation.groupNamespaceId,
    },
    receiver: { account: memberAccount, namespaceId: 0 },
  };
}

export function mirrorIntentWriteSql(params: {
  author: IntentEndpointCoordinates;
  receiver: IntentEndpointCoordinates;
  status: RelationshipIntentStatus;
  note: string;
  requestedAt: Date | null;
  expiresAt: Date | null;
  profileNamespaceId: number;
  profileRev: number;
  messageEndSeq: number;
  tombstoneEndSeq: number;
}) {
  return sql`
      INSERT INTO "RelationshipIntent" (
        "authorAccount", "authorNamespaceId", "receiverAccount", "receiverNamespaceId",
        status, "profileNamespaceId", "profileRev", note, "messageEndSeq", "tombstoneEndSeq",
        "requestedAt", "expiresAt", "updatedAt"
      ) VALUES (${params.author.account}, ${params.author.namespaceId},
        ${params.receiver.account}, ${params.receiver.namespaceId},
        ${params.status}::"RelationshipIntentStatus", ${params.profileNamespaceId}, ${params.profileRev}, ${params.note.slice(0, 255)},
        ${params.status === 'REVOKED' ? 0 : params.messageEndSeq},
        ${params.status === 'REVOKED' ? 0 : params.tombstoneEndSeq},
        ${params.requestedAt}, ${params.expiresAt}, CURRENT_TIMESTAMP)
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
        "requestedAt" = EXCLUDED."requestedAt", "expiresAt" = EXCLUDED."expiresAt",
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "RelationshipIntent"."messageEndSeq" IS DISTINCT FROM EXCLUDED."messageEndSeq"
         OR "RelationshipIntent"."tombstoneEndSeq" IS DISTINCT FROM EXCLUDED."tombstoneEndSeq"
         OR "RelationshipIntent".status IS DISTINCT FROM EXCLUDED.status
         OR "RelationshipIntent".note IS DISTINCT FROM EXCLUDED.note
         OR "RelationshipIntent"."requestedAt" IS DISTINCT FROM EXCLUDED."requestedAt"
         OR "RelationshipIntent"."expiresAt" IS DISTINCT FROM EXCLUDED."expiresAt"
      RETURNING status, "profileNamespaceId", "profileRev", note, "requestedAt", "expiresAt",
        "messageEndSeq", "tombstoneEndSeq"
  `;
}

export interface MirrorGroupPresentationInput {
  groupAccount: string;
  groupNamespaceId: number;
}
