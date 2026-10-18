import type { RequestSnapshot } from '../../../shared/request-snapshot.js';
import {
  authoredRequestSnapshotSql,
  retainedRequestSnapshotSql,
} from '../../relationship/shared/request-snapshot-sql.js';
import { sql } from 'drizzle-orm';
import type { RelationshipIntentStatus } from '../relationship-intent-state.js';

/** Parameterized authored-intent write shared by P2P and group membership relationships.
 * The caller owns the pair lock and validates the transition. The row is
 * identified by its author/receiver coordinates alone — no pair reference is
 * stored. Keep the authored profile reference across acceptance/revocation
 * unless the caller explicitly selects a revocation revision. Preserve revoked
 * heads independently of that profile selection. */
export function authoredIntentWriteSql(params: {
  author: { account: string; namespaceId: number };
  receiver: { account: string; namespaceId: number };
  threadId: number | null;
  note: string;
  requestedAt: Date | null;
  expiresAt: Date | null;
  /** Explicit profile revision selected by an authorized revocation command. */
  profileRev?: number;
} & (
  | { status: 'REQUESTED'; snapshot: RequestSnapshot }
  | { status: 'ACCEPTED' | 'REVOKED'; snapshot?: never }
)) {
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
        "authorAccount", "authorNamespaceId", "receiverAccount", "receiverNamespaceId",
        status, "profileNamespaceId", "profileRev", note, "messageEndSeq", "tombstoneEndSeq",
        "requestedAt", "expiresAt", "updatedAt", snapshot
      ) VALUES (${params.author.account}, ${params.author.namespaceId},
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
        ${requestedAt}, ${expiresAt}, CURRENT_TIMESTAMP,
        ${authoredRequestSnapshotSql({ authorNamespaceId: params.author.namespaceId, status, snapshot: params.status === 'REQUESTED' ? params.snapshot : null })})
      ON CONFLICT ("authorAccount", "authorNamespaceId", "receiverAccount", "receiverNamespaceId") DO UPDATE SET
        status = EXCLUDED.status, note = EXCLUDED.note,
        snapshot = ${retainedRequestSnapshotSql()},
        "messageEndSeq" = CASE WHEN EXCLUDED.status = 'REVOKED'
          THEN "RelationshipIntent"."messageEndSeq" ELSE EXCLUDED."messageEndSeq" END,
        "tombstoneEndSeq" = CASE WHEN EXCLUDED.status = 'REVOKED'
          THEN "RelationshipIntent"."tombstoneEndSeq" ELSE EXCLUDED."tombstoneEndSeq" END,
        "profileRev" = CASE
          WHEN EXCLUDED.status = 'REVOKED' AND ${refreshRevocation}
            THEN EXCLUDED."profileRev"
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
         OR (${refreshRevocation} AND EXCLUDED.status = 'REVOKED'
           AND "RelationshipIntent"."profileRev" IS DISTINCT FROM EXCLUDED."profileRev")
      RETURNING "authorAccount", "authorNamespaceId", status, "profileNamespaceId", "profileRev", note, "requestedAt", "expiresAt",
        "messageEndSeq", "tombstoneEndSeq", snapshot
  `;
}
