import type { RequestSnapshot } from '../../../../shared/request-snapshot.js';
import { sql, type SQL } from 'drizzle-orm';
import { FEDERATION_HISTORY_ACCESS_SETTING_KEY } from '../../../federation/federation-history-access-setting.js';
import { authoredIntentWriteSql } from '../../../common/sql/authored-relationship-intent-sql.js';
import { peerIntentFeedWriteSql } from '../../../common/sql/relationship-intent-recipient-feed-sql.js';

export interface GroupAuthoredMembershipRequestInput {
  threadId: number;
  pairId: bigint;
  groupAccount: string;
  groupProfileRev: number;
  targetAccount: string;
  targetNamespaceId: number;
  localTargetId: number | null;
  note: string;
  statusChangedAt: Date;
  expiresAt: Date;
  snapshot: RequestSnapshot;
}

/** Author the protocol invitation and preserve its peer audience effects.
 * Permanent request rounds, snapshots, and notification heads must be supplied
 * by the owning request capability in the same transaction. */
export function groupAuthoredMembershipRequestSql(
  input: GroupAuthoredMembershipRequestInput,
): SQL {
  const remote = input.targetNamespaceId !== 0;
  return sql`
    WITH authored AS (
      ${authoredIntentWriteSql({
        author: { account: input.groupAccount, namespaceId: 0 },
        receiver: {
          account: input.targetAccount,
          namespaceId: input.targetNamespaceId,
        },
        threadId: input.threadId,
        status: 'REQUESTED',
        note: input.note,
        statusChangedAt: input.statusChangedAt,
        expiresAt: input.expiresAt,
        snapshot: input.snapshot,
      })}
    ), request_state AS MATERIALIZED (
      SELECT status, "profileNamespaceId", "profileRev", note, "statusChangedAt", "expiresAt",
        "messageEndSeq", "tombstoneEndSeq" FROM authored
      UNION ALL
      SELECT status, "profileNamespaceId", "profileRev", note, "statusChangedAt", "expiresAt",
        "messageEndSeq", "tombstoneEndSeq"
      FROM "RelationshipIntent"
      WHERE "authorAccount" = ${input.groupAccount} AND "authorNamespaceId" = 0
        AND "receiverAccount" = ${input.targetAccount}
        AND "receiverNamespaceId" = ${input.targetNamespaceId}
        AND NOT EXISTS (SELECT 1 FROM authored)
    ), ${remote ? sql`${peerRecipient(input)},` : sql.empty()} audience_open AS (
      INSERT INTO "ThreadAudience" ("threadId", "targetNamespaceId",
        "localUserId", "groupMetaVisibleAfter", "messageAccessAfterSeq")
      SELECT ${input.threadId}, ${input.targetNamespaceId}, NULL, 0,
        CASE WHEN COALESCE((SELECT value <> 'false' FROM "SystemSetting"
          WHERE key = ${FEDERATION_HISTORY_ACCESS_SETTING_KEY}), true)
          THEN 0 ELSE (SELECT t."curSeq" FROM "MessageThread" t WHERE t.id = ${input.threadId}) END
      WHERE ${remote} AND EXISTS (SELECT 1 FROM authored)
      ON CONFLICT ("targetNamespaceId", "threadId") WHERE "localUserId" IS NULL DO NOTHING
      RETURNING id
    )
    SELECT v.status, v.note,
      EXISTS (SELECT 1 FROM authored) AS "intentChanged",
      EXISTS (SELECT 1 FROM audience_open) AS "audienceChanged"
      ${
        remote
          ? sql`, (SELECT "userId" FROM recipient_result) AS "recipientUserId",
        (SELECT "feedId" FROM recipient_result) AS "recipientFeedId"`
          : sql.empty()
      }
    FROM request_state v
  `;
}

/** Preserve peer protocol delivery independently from personal request storage. */
function peerRecipient(input: GroupAuthoredMembershipRequestInput): SQL {
  return sql`
    peer_write AS MATERIALIZED (
      SELECT jsonb_build_object('status', v.status,
          'namespaceId', v."profileNamespaceId",
          'profileRev', v."profileRev", 'note', v.note,
          'statusChangedAt', floor(extract(epoch FROM v."statusChangedAt") * 1000)::bigint,
          'expiresAt', floor(extract(epoch FROM v."expiresAt") * 1000)::bigint,
          'messageEndSeq', v."messageEndSeq", 'tombstoneEndSeq', v."tombstoneEndSeq") AS body
      FROM request_state v
    ), peer_changes AS MATERIALIZED (
      SELECT ${input.targetAccount}::text AS "subjectAccount", ${input.targetNamespaceId}::integer AS "subjectNamespaceId",
        p.body, row_number() OVER () AS position, false AS invalid
      FROM peer_write p
      LEFT JOIN "PeerStateFeed" old ON old."namespaceId" = ${input.targetNamespaceId}
        AND old.account = ${input.groupAccount}
        AND old."eventType" = 'RELATIONSHIP_INTENT'
        AND old."subjectAccount" = ${input.targetAccount} AND old."subjectNamespaceId" = ${input.targetNamespaceId}
      WHERE old.body IS DISTINCT FROM p.body
    ), ${peerIntentFeedWriteSql({
      namespaceId: input.targetNamespaceId,
      selfAccount: input.groupAccount,
    })}
  `;
}
