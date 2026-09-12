import { sql, type SQL } from 'drizzle-orm';
import { authoredIntentWriteSql } from '../../shared/sql/authored-relationship-intent-sql.js';
import { threadFanoutAdmissionSql } from '../../shared/sql/thread-content-fanout-admission-sql.js';
import { managerProjectionFlipSql } from '../shared/group-membership-projection-sql.js';
import {
  clientIntentFeedWriteSql,
  peerIntentFeedWriteSql,
} from '../../shared/sql/relationship-intent-recipient-feed-sql.js';

export interface GroupMembershipRevocationInput {
  threadId: number;
  pairId: bigint;
  groupAccount: string;
  groupName: string;
  groupAvatar: string;
  groupDescription: string;
  groupProfileRev: number;
  localDomain: string;
  memberAccount: string;
  memberDomain: string;
  memberNamespaceId: number;
  /** Local Account.id of the member, or null for a peer-hosted member. */
  localMemberId: number | null;
  managerIds: readonly number[];
  /** Existing non-REVOKED projection directions for this member, from authorization. */
  projectionDirections: readonly ('APPLICATION' | 'INVITATION')[];
  /** The group's own decision authors side A; the member's self-authored
   * withdrawal, invitation decline, and leave author side B. */
  authorSide: 'A' | 'B';
}

function accountFanoutScopeKey(threadId: number, accountId: number): string {
  return JSON.stringify(['ACCOUNT_THREAD_FANOUT', threadId, accountId]);
}

function groupMetaScopeKey(groupAccount: string): string {
  return JSON.stringify(['business-scope', 'ACCOUNT', 'local', groupAccount]);
}

function memberCoalescingKey(localMemberId: number): string {
  return JSON.stringify(['GROUP_MEMBER_INTENT', 'MEMBER', localMemberId]);
}

function localRecipientKey(
  groupAccount: string,
  memberAccount: string,
): string {
  // Matches ClientStateFeedService.compactionKey for the local recipient write.
  return JSON.stringify([
    'RELATIONSHIP_INTENT',
    0,
    groupAccount,
    'local',
    memberAccount,
    'local',
  ]);
}

/** One composed statement for the group-authored REVOKED decision. Roster effects,
 * the GROUP_LEFT system message, the local and federation fan-out admissions, and
 * the reverse task are all gated on the member's roster presence and collapse to
 * no-ops for a plain rejection. Sibling CTEs cannot observe one another's writes,
 * so row reads use the pre-statement snapshot: the federated audience close
 * excludes this pair explicitly, and the DEPART dedupe reads the last feed entry
 * exactly like reconcileMembersInTx. */
export function groupMembershipRevocationSql(
  input: GroupMembershipRevocationInput,
): SQL {
  const localMember = input.memberDomain === 'local';
  const accountScope =
    input.localMemberId === null
      ? ''
      : accountFanoutScopeKey(input.threadId, input.localMemberId);
  const groupScope = groupMetaScopeKey(input.groupAccount);
  const content = JSON.stringify({
    type: 'GROUP_LEFT',
    member: { account: input.memberAccount, domain: input.memberDomain },
  });
  return sql`
    WITH system_actor AS MATERIALIZED (
      SELECT id FROM "Account" WHERE kind = 'SYSTEM' ORDER BY id LIMIT 1
    ), authored AS (
      ${authoredIntentWriteSql({
        pair: { id: input.pairId, threadId: input.threadId },
        authorSide: input.authorSide,
        status: 'REVOKED',
        note: '',
        requestedAt: null,
        expiresAt: null,
      })}
    ), revocation AS MATERIALIZED (
      SELECT id, status, "profileRev", note, "requestedAt", "expiresAt" FROM authored
      UNION ALL
      SELECT id, status, "profileRev", note, "requestedAt", "expiresAt"
      FROM "RelationshipIntent" WHERE "pairId" = ${input.pairId} AND "authorSide" = ${input.authorSide}
        AND NOT EXISTS (SELECT 1 FROM authored)
    ), member_last AS MATERIALIZED (
      SELECT operation FROM "GroupMetaMemberFeed"
      WHERE "threadId" = ${input.threadId} AND "memberAccount" = ${input.memberAccount}
        AND "memberDomain" = ${input.memberDomain}
        AND "memberNamespaceId" = ${input.memberNamespaceId}
      ORDER BY "feedId" DESC LIMIT 1
    ), was_member AS MATERIALIZED (
      SELECT EXISTS (SELECT 1 FROM member_last WHERE operation = 'UPSERT') AS member
    ), pair_change AS (
      UPDATE "RelationshipPair" SET active = false, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${input.pairId} AND "threadId" = ${input.threadId}
        AND active IS DISTINCT FROM false
      RETURNING id
    ), depart_alloc AS (
      UPDATE "GroupMeta" f SET "metaEndId" = f."metaEndId" + 1, "updatedAt" = CURRENT_TIMESTAMP
      FROM was_member w WHERE f."threadId" = ${input.threadId} AND w.member
      RETURNING f."metaEndId"
    ), depart_fact AS (
      INSERT INTO "GroupMetaMemberFeed"
        ("threadId", "feedId", "memberAccount", "memberDomain", "memberNamespaceId", operation, body)
      SELECT ${input.threadId}, a."metaEndId", ${input.memberAccount}, ${input.memberDomain},
        ${input.memberNamespaceId}, 'DEPART'::"GroupMetaMemberOperation", '{}'::jsonb
      FROM depart_alloc a
      RETURNING "feedId"
    ), seq_alloc AS (
      -- One update per row per statement: the head allocation and the touch
      -- share this single write (PostgreSQL applies only one of two updates
      -- to the same row inside one statement).
      UPDATE "MessageThread" t SET "curSeq" = t."curSeq" + 1, "updatedAt" = CURRENT_TIMESTAMP
      FROM was_member w WHERE t.id = ${input.threadId} AND w.member
      RETURNING t."curSeq", t."tombstoneEndSeq"
    ), system_message AS (
      INSERT INTO "Message" ("threadId", seq, "contentType", content, "creatorAccount", "creatorDomain", "updatedAt")
      SELECT ${input.threadId}, s."curSeq", 'SYSTEM'::"ContentType", ${content}::jsonb,
        '$system', 'local', CURRENT_TIMESTAMP
      FROM seq_alloc s
      RETURNING seq
    ), member_watermark AS (
      UPDATE "AccountThreadState" a SET "messageVisibleThroughSeq" = m.seq, "updatedAt" = CURRENT_TIMESTAMP
      FROM system_message m
      WHERE a."threadId" = ${input.threadId} AND a."accountId" = ${input.localMemberId}
      RETURNING a."accountId"
    ), ${threadFanoutAdmissionSql({
      threadId: input.threadId,
      prefix: 'thread_fanout',
      federation: false,
    })}, departure_task AS (
      INSERT INTO "DurableTask"
        (kind, "scopeType", "scopeKey", "taskType", payload, "coalescingKey", status)
      SELECT 'PROJECTION'::"DurableTaskKind", 'THREAD'::"DurableTaskScopeType", ${accountScope},
        'FAN_OUT_ACCOUNT_THREAD_CONTENT',
        jsonb_build_object('threadId', ${input.threadId}::integer,
          'messageEndSeq', (SELECT seq FROM system_message),
          'tombstoneEndSeq', (SELECT "tombstoneEndSeq" FROM seq_alloc),
          'accountId', ${input.localMemberId}::integer),
        ${accountScope}, 'PENDING'::"DurableTaskStatus"
      FROM was_member w
      WHERE w.member AND ${input.localMemberId}::integer IS NOT NULL
        AND EXISTS (SELECT 1 FROM system_message)
      RETURNING id
    ), ${threadFanoutAdmissionSql({
      threadId: input.threadId,
      prefix: 'federation_fanout',
      federation: true,
    })}, reverse_task AS (
      INSERT INTO "DurableTask"
        (kind, "scopeType", "scopeKey", "taskType", "actorUserId", payload, "coalescingKey", status)
      SELECT 'MUTATION'::"DurableTaskKind", 'GROUP'::"DurableTaskScopeType", ${groupScope},
        'REVOKE_USER_RELATIONSHIP', (SELECT id FROM system_actor),
        jsonb_build_object('operation', 'RESPOND_TO_REVOKE', 'threadId', ${input.threadId}::integer,
          'memberUserId', ${input.localMemberId}::integer,
          'intentAuthorUserId', ${input.localMemberId}::integer),
        ${input.localMemberId === null ? '' : memberCoalescingKey(input.localMemberId)},
        'PENDING'::"DurableTaskStatus"
      FROM was_member w
      WHERE w.member AND ${input.localMemberId}::integer IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "DurableTask" d
          WHERE d.kind = 'MUTATION' AND d."scopeKey" = ${groupScope}
            AND d."coalescingKey" = ${input.localMemberId === null ? '' : memberCoalescingKey(input.localMemberId)}
            AND d.status = 'PENDING')
      RETURNING id
    ), ${managerProjectionFlipSql({
      threadId: input.threadId,
      memberAccount: input.memberAccount,
      memberDomain: input.memberDomain,
      memberNamespaceId: input.memberNamespaceId,
      managerIds: input.managerIds,
      status: 'REVOKED',
      directions: input.projectionDirections,
    })}, audience_close AS (
      DELETE FROM "ThreadAudience" ta
      WHERE ta."threadId" = ${input.threadId} AND (
        (ta."targetDomain" = 'local' AND ta."localUserId" = ${input.localMemberId}
          AND ta."targetNamespaceId" = 0)
        OR (${localMember ? sql`false` : sql`true`}
          AND ta."targetDomain" = ${input.memberDomain}
          AND ta."targetNamespaceId" = ${input.memberNamespaceId}
          AND NOT EXISTS (SELECT 1 FROM "RelationshipPair" p
            WHERE p.kind = 'GROUP_MEMBER' AND p."threadId" = ${input.threadId}
              AND p.active AND p."endpointBDomain" = ${input.memberDomain}
              AND p."endpointBNamespaceId" = ${input.memberNamespaceId}
              AND p.id <> ${input.pairId})))
      RETURNING ta.id
    ), ${localMember ? localRecipient(input) : peerRecipient(input)}
    SELECT v.id::text AS "requestId", v.status, v.note,
      EXISTS (SELECT 1 FROM authored) AS "intentChanged",
      EXISTS (SELECT 1 FROM pair_change) AS "pairChanged",
      EXISTS (SELECT 1 FROM depart_fact) AS "departed",
      EXISTS (SELECT 1 FROM audience_close) AS "audienceChanged",
      (SELECT seq FROM system_message) AS "systemMessageSeq",
      (SELECT "userId" FROM recipient_result) AS "recipientUserId",
      (SELECT "feedId" FROM recipient_result) AS "recipientFeedId"
    FROM revocation v
    CROSS JOIN (SELECT count(*) FROM seq_alloc) thread_barrier
    CROSS JOIN (SELECT count(*) FROM request_projection) projection_barrier
  `;
}

/** Local recipient: the compacted RELATIONSHIP_INTENT feed row with body-level
 * dedupe, so a repeated revocation neither allocates a feed id nor wakes anyone.
 * `established` is false: the pair is already inactive within this statement. */
function localRecipient(input: GroupMembershipRevocationInput): SQL {
  return sql`
    recipient_body AS MATERIALIZED (
      SELECT ${localRecipientKey(input.groupAccount, input.memberAccount)}::text AS "compactionKey",
        jsonb_build_object('status', v.status, 'note', v.note,
          'requestedAt', floor(extract(epoch FROM v."requestedAt") * 1000)::bigint,
          'expiresAt', CASE WHEN v."expiresAt" IS NULL THEN NULL
            ELSE floor(extract(epoch FROM v."expiresAt") * 1000)::bigint END,
          'threadId', ${input.threadId}::integer,
          'established', (SELECT p.established FROM "RelationshipPair" p WHERE p.id = ${input.pairId}),
          'group', jsonb_build_object('account', ${input.groupAccount}::text, 'domain', 'local',
            'isLocal', true, 'name', ${input.groupName}::text, 'avatar', ${input.groupAvatar}::text,
            'description', ${input.groupDescription}::text, 'profileRev', ${input.groupProfileRev}::integer)
        ) AS body
      FROM revocation v
    ), candidate_bodies AS MATERIALIZED (
      SELECT ${input.localMemberId}::integer AS "userId", 0 AS "namespaceId", 1 AS ordinal,
        b."compactionKey", ${input.groupAccount}::text AS account, 'local'::text AS domain,
        ${input.memberAccount}::text AS "subjectAccount", 'local'::text AS "subjectDomain", b.body
      FROM recipient_body b
    ), ${clientIntentFeedWriteSql()}
  `;
}

/** Peer recipient: one RELATIONSHIP_INTENT REVOKED event, suppressed when the
 * peer already holds the identical body (no feed id is consumed). */
function peerRecipient(input: GroupMembershipRevocationInput): SQL {
  return sql`
    peer_write AS MATERIALIZED (
      SELECT jsonb_build_object('status', v.status, 'profileRev', v."profileRev", 'note', v.note,
          'requestedAt', floor(extract(epoch FROM v."requestedAt") * 1000)::bigint,
          'expiresAt', CASE WHEN v."expiresAt" IS NULL THEN NULL
            ELSE floor(extract(epoch FROM v."expiresAt") * 1000)::bigint END) AS body
      FROM revocation v
    ), peer_changes AS MATERIALIZED (
      SELECT ${input.memberAccount}::text AS "subjectAccount", ${input.memberDomain}::text AS "subjectDomain",
        p.body, row_number() OVER () AS position, false AS invalid
      FROM peer_write p
      LEFT JOIN "PeerStateFeed" old ON old."namespaceId" = ${input.memberNamespaceId}
        AND old.account = ${input.groupAccount} AND old.domain = ${input.localDomain}
        AND old."eventType" = 'RELATIONSHIP_INTENT'
        AND old."subjectAccount" = ${input.memberAccount} AND old."subjectDomain" = ${input.memberDomain}
      WHERE old.body IS DISTINCT FROM p.body
    ), ${peerIntentFeedWriteSql({
      namespaceId: input.memberNamespaceId,
      peerDomain: input.memberDomain,
      selfAccount: input.groupAccount,
      selfDomain: input.localDomain,
    })}
  `;
}
