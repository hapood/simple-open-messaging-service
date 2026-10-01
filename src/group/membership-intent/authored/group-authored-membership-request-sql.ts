import { sql, type SQL } from 'drizzle-orm';
import { FEDERATION_HISTORY_ACCESS_SETTING_KEY } from '../../../federation/federation-history-access-setting.js';
import { authoredIntentWriteSql } from '../../../common/sql/authored-relationship-intent-sql.js';
import {
  clientIntentFeedWriteSql,
  peerIntentFeedWriteSql,
} from '../../../common/sql/relationship-intent-recipient-feed-sql.js';

export interface GroupAuthoredMembershipRequestInput {
  threadId: number;
  pairId: bigint;
  groupAccount: string;
  groupName: string;
  groupAvatar: string;
  groupDescription: string;
  groupProfileRev: number;
  targetAccount: string;
  targetDomain: string;
  targetNamespaceId: number;
  /** Local Account.id of the invitee, or null for a peer-hosted one. */
  localTargetId: number | null;
  note: string;
  requestedAt: Date;
  expiresAt: Date;
}

function localRecipientKey(
  groupAccount: string,
  targetAccount: string,
): string {
  // Matches ClientStateFeedService.compactionKey for the invitee's feed write.
  return JSON.stringify([
    'RELATIONSHIP_INTENT',
    0,
    groupAccount,
    'local',
    targetAccount,
    'local',
  ]);
}

/** One composed statement for the group-authored REQUESTED decision (an
 * invitation). It writes no roster fact, no system message, and no fanout task:
 * membership effects wait for the invitee's ack and the group's completion ACK.
 * The pair row already exists (the transaction owner minted it), so sibling
 * CTEs read the intent back through the same UNION ALL fallback as revocation.
 * Manager notification stays projection-only — no client-state attention head or
 * profile snapshots — matching the decision-time doctrine; the reconcile path
 * rebuilds those cosmetic rows. */
export function groupAuthoredMembershipRequestSql(
  input: GroupAuthoredMembershipRequestInput,
): SQL {
  const remote = input.targetDomain !== 'local';
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
        requestedAt: input.requestedAt,
        expiresAt: input.expiresAt,
      })}
    ), request_state AS MATERIALIZED (
      SELECT id, status, "profileRev", note, "requestedAt", "expiresAt",
        "messageEndSeq", "tombstoneEndSeq" FROM authored
      UNION ALL
      SELECT id, status, "profileRev", note, "requestedAt", "expiresAt",
        "messageEndSeq", "tombstoneEndSeq"
      FROM "RelationshipIntent"
      WHERE "authorAccount" = ${input.groupAccount} AND "authorNamespaceId" = 0
        AND "receiverAccount" = ${input.targetAccount}
        AND "receiverNamespaceId" = ${input.targetNamespaceId}
        AND NOT EXISTS (SELECT 1 FROM authored)
    ), member_rev AS MATERIALIZED (
      SELECT COALESCE((SELECT i."profileRev" FROM "RelationshipIntent" i
        WHERE i."authorAccount" = ${input.targetAccount} AND i."authorNamespaceId" = ${input.targetNamespaceId}
          AND i."receiverAccount" = ${input.groupAccount} AND i."receiverNamespaceId" = 0), 0) AS rev
    ), projection_alloc AS (
      UPDATE "GroupMeta" f
        SET "invitationEndId" = f."invitationEndId" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE f."threadId" = ${input.threadId} AND EXISTS (SELECT 1 FROM authored)
      RETURNING f."invitationEndId" AS "feedId"
    ), request_projection AS (
      INSERT INTO "GroupRequestProjection"
        ("threadId", "memberAccount", "profileNamespaceId",
          "memberProfileRev", direction, status, note, "requestedAt", "expiresAt", "feedId")
      SELECT ${input.threadId}, ${input.targetAccount},
        ${input.targetNamespaceId}, (SELECT rev FROM member_rev), 'INVITATION',
        'REQUESTED'::"RequestProjectionStatus", v.note, v."requestedAt", v."expiresAt",
        (SELECT "feedId" FROM projection_alloc)
      FROM request_state v
      WHERE EXISTS (SELECT 1 FROM projection_alloc)
      ON CONFLICT ("threadId", "memberAccount",
        "profileNamespaceId", "direction") DO UPDATE SET
        "feedId" = EXCLUDED."feedId",
        "memberProfileRev" = EXCLUDED."memberProfileRev", status = EXCLUDED.status,
        note = EXCLUDED.note, "requestedAt" = EXCLUDED."requestedAt",
        "expiresAt" = EXCLUDED."expiresAt"
      RETURNING 1
    ), ${
      remote ? peerRecipient(input) : localRecipient(input)
    }, audience_open AS (
      INSERT INTO "ThreadAudience" ("threadId", "targetNamespaceId",
        "localUserId", "groupMetaVisibleAfter", "messageAccessAfterSeq")
      SELECT ${input.threadId}, ${input.targetNamespaceId}, NULL, 0,
        CASE WHEN COALESCE((SELECT value <> 'false' FROM "SystemSetting"
          WHERE key = ${FEDERATION_HISTORY_ACCESS_SETTING_KEY}), true)
          THEN 0 ELSE (SELECT t."curSeq" FROM "MessageThread" t WHERE t.id = ${input.threadId}) END
      WHERE ${remote ? sql`true` : sql`false`} AND EXISTS (SELECT 1 FROM authored)
      ON CONFLICT ("targetNamespaceId", "threadId") WHERE "localUserId" IS NULL DO NOTHING
      RETURNING id
    )
    SELECT v.status, v.note,
      EXISTS (SELECT 1 FROM authored) AS "intentChanged",
      EXISTS (SELECT 1 FROM request_projection) AS "projectionChanged",
      EXISTS (SELECT 1 FROM audience_open) AS "audienceChanged",
      (SELECT "userId" FROM recipient_result) AS "recipientUserId",
      (SELECT "feedId" FROM recipient_result) AS "recipientFeedId"
    FROM request_state v
    CROSS JOIN (SELECT count(*) FROM request_projection) projection_barrier
  `;
}

/** Local invitee: the compacted RELATIONSHIP_INTENT feed row with body-level
 * dedupe, so a repeat with an unchanged body neither allocates a feed id nor
 * wakes anyone. `established` mirrors the pair's sticky flag, exactly like the
 * service's `hasEstablishedThreadRelationship` injection does. */
function localRecipient(input: GroupAuthoredMembershipRequestInput): SQL {
  return sql`
    recipient_body AS MATERIALIZED (
      SELECT ${localRecipientKey(input.groupAccount, input.targetAccount)}::text AS "compactionKey",
        jsonb_build_object('status', v.status, 'note', v.note,
          'requestedAt', floor(extract(epoch FROM v."requestedAt") * 1000)::bigint,
          'expiresAt', floor(extract(epoch FROM v."expiresAt") * 1000)::bigint,
          'threadId', ${input.threadId}::integer,
          'established', (SELECT p.established FROM "RelationshipPair" p WHERE p.id = ${input.pairId}),
          'group', jsonb_build_object('account', ${input.groupAccount}::text, 'domain', 'local',
            'isLocal', true, 'name', ${input.groupName}::text, 'avatar', ${input.groupAvatar}::text,
            'description', ${input.groupDescription}::text, 'profileRev', ${input.groupProfileRev}::integer)
        ) AS body
      FROM request_state v
    ), candidate_bodies AS MATERIALIZED (
      SELECT ${input.localTargetId}::integer AS "userId", 0 AS "namespaceId", 1 AS ordinal,
        b."compactionKey", ${input.groupAccount}::text AS account, 'local'::text AS domain,
        ${input.targetAccount}::text AS "subjectAccount", 0::integer AS "subjectNamespaceId", b.body
      FROM recipient_body b
    ), ${clientIntentFeedWriteSql()}
  `;
}

/** Peer invitee: one RELATIONSHIP_INTENT REQUESTED event, suppressed when the
 * peer already holds the identical body (no feed id is consumed). */
function peerRecipient(input: GroupAuthoredMembershipRequestInput): SQL {
  return sql`
    peer_write AS MATERIALIZED (
      SELECT jsonb_build_object('status', v.status, 'profileRev', v."profileRev", 'note', v.note,
          'requestedAt', floor(extract(epoch FROM v."requestedAt") * 1000)::bigint,
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
