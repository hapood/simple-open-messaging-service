import { sql, type SQL } from 'drizzle-orm';
import { groupStateSql } from '../../../group/group-state.js';
import { authoredIntentWriteSql } from '../../shared/sql/authored-relationship-intent-sql.js';
import { threadFanoutAdmissionSql } from '../../shared/sql/thread-content-fanout-admission-sql.js';
import { managerProjectionFlipSql } from '../shared/group-membership-projection-sql.js';
import {
  clientIntentFeedWriteSql,
  peerIntentFeedWriteSql,
} from '../../shared/sql/relationship-intent-recipient-feed-sql.js';

/** Disband sweep command: depart one member of an already-dissolved local
 * group. The member is addressed directly (the sweep enumerates pairs, not
 * request projections), and the caller is the system — no manager, no
 * authorization beyond the dissolved-group invariant. */
export interface GroupDisbandMembershipRevocationInput {
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
  /** Pair liveness from the pre-statement authorization snapshot: the GROUP_LEFT
   * message and the departure fan-out fire only for a still-active pair, exactly
   * like the legacy fan-out's `outgoing.active` gate. */
  pairWasActive: boolean;
}

/** Use before locking only to name the business scopes and fail fast on a
 * missing group or pair. It authorizes nothing; the dissolved-group gate and
 * every mutable state are re-read after the locks. The pair is optional so the
 * caller can reproduce the legacy gate order: group first, then dissolution,
 * then the member. */
export function groupDisbandMembershipRevocationLocatorSql(input: {
  threadId: number;
  member: { account: string; domain: string; namespaceId: number };
}): SQL {
  return sql`
    SELECT g.account AS "groupAccount", g.domain AS "groupDomain",
      g."dissolvedAt" AS "dissolvedAt",
      pair.id::text AS "pairId",
      (SELECT a.id FROM "Account" a WHERE a.account = ${input.member.account}
        AND a.domain = 'local' AND a."namespaceId" = 0 LIMIT 1) AS "localMemberId"
    FROM ${groupStateSql} g
    LEFT JOIN "RelationshipPair" pair ON pair.kind = 'GROUP_MEMBER'
      AND pair."threadId" = g.id AND pair."endpointBType" = 'USER'
      AND pair."endpointBAccount" = ${input.member.account}
      AND pair."endpointBDomain" = ${input.member.domain}
      AND (${input.member.namespaceId} = 0
        OR pair."endpointBNamespaceId" = ${input.member.namespaceId})
    WHERE g.id = ${input.threadId}
    LIMIT 1
  `;
}

function accountFanoutScopeKey(threadId: number, accountId: number): string {
  return JSON.stringify(['ACCOUNT_THREAD_FANOUT', threadId, accountId]);
}

function groupToMemberKey(groupAccount: string, memberAccount: string): string {
  // Matches ClientStateFeedService.compactionKey for the group→member write.
  return JSON.stringify([
    'RELATIONSHIP_INTENT',
    0,
    groupAccount,
    'local',
    memberAccount,
    'local',
  ]);
}

function memberToGroupKey(memberAccount: string, groupAccount: string): string {
  // Matches ClientStateFeedService.compactionKey for the member's own
  // OUTGOING entry — the side B intent's recipient write.
  return JSON.stringify([
    'RELATIONSHIP_INTENT',
    0,
    memberAccount,
    'local',
    groupAccount,
    'local',
  ]);
}

/** One composed statement for the disband sweep's per-member departure. The
 * disband fan-out is deliberately leaner than a manager kick: it writes no
 * DEPART roster fact and admits no meta-head fan-out (the dissolved group keeps
 * its last roster), and it authors no reverse task (the group authors both
 * intent sides itself). The GROUP_LEFT message, its watermarks, the thread
 * fan-out, the projection flip, the audience close, and the recipient writes
 * are all gated on the pair's pre-statement liveness. Sibling CTEs cannot
 * observe one another's writes, so every read-back derives from the
 * statement's own RETURNING chains. */
export function groupDisbandMembershipRevocationSql(
  input: GroupDisbandMembershipRevocationInput,
): SQL {
  const localMember = input.memberDomain === 'local';
  const accountScope =
    input.localMemberId === null
      ? ''
      : accountFanoutScopeKey(input.threadId, input.localMemberId);
  const content = JSON.stringify({
    type: 'GROUP_LEFT',
    member: { account: input.memberAccount, domain: input.memberDomain },
  });
  return sql`
    WITH ${
      localMember
        ? sql`authored_b AS (
      ${authoredIntentWriteSql({
        pair: { id: input.pairId, threadId: input.threadId },
        authorSide: 'B',
        status: 'REVOKED',
        note: '',
        requestedAt: null,
        expiresAt: null,
      })}
    ), `
        : sql``
    }authored AS (
      ${authoredIntentWriteSql({
        pair: { id: input.pairId, threadId: input.threadId },
        authorSide: 'A',
        status: 'REVOKED',
        note: '',
        requestedAt: null,
        expiresAt: null,
      })}
    ), revocation AS MATERIALIZED (
      SELECT id, status, "profileRev", note, "requestedAt", "expiresAt" FROM authored
      UNION ALL
      SELECT id, status, "profileRev", note, "requestedAt", "expiresAt"
      FROM "RelationshipIntent" WHERE "pairId" = ${input.pairId} AND "authorSide" = 'A'
        AND NOT EXISTS (SELECT 1 FROM authored)
    ), pair_change AS (
      UPDATE "RelationshipPair" SET active = false, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${input.pairId} AND "threadId" = ${input.threadId}
        AND active IS DISTINCT FROM false
      RETURNING id
    ), seq_alloc AS (
      -- One update per row per statement: the head allocation and the touch
      -- share this single write (PostgreSQL applies only one of two updates
      -- to the same row inside one statement).
      UPDATE "MessageThread" t SET "curSeq" = t."curSeq" + 1, "updatedAt" = CURRENT_TIMESTAMP
      WHERE t.id = ${input.threadId} AND ${input.pairWasActive}
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
      WHERE ${input.pairWasActive} AND ${input.localMemberId}::integer IS NOT NULL
        AND EXISTS (SELECT 1 FROM system_message)
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
    ), ${localMember ? localRecipients(input) : peerRecipient(input)}
    SELECT v.id::text AS "requestId", v.status, v.note,
      EXISTS (SELECT 1 FROM authored) AS "intentChanged",
      EXISTS (SELECT 1 FROM pair_change) AS "pairChanged",
      EXISTS (SELECT 1 FROM audience_close) AS "audienceChanged",
      EXISTS (SELECT 1 FROM departure_task) AS "departureInserted",
      (SELECT seq FROM system_message) AS "systemMessageSeq",
      (SELECT "userId" FROM recipient_result) AS "recipientUserId",
      (SELECT "feedId" FROM recipient_result) AS "recipientFeedId"
    FROM revocation v
    CROSS JOIN (SELECT count(*) FROM seq_alloc) thread_barrier
    CROSS JOIN (SELECT count(*) FROM request_projection) projection_barrier
  `;
}

/** The two local recipient entries the legacy fan-out writes: the group→member
 * compacted RELATIONSHIP_INTENT row (status flip with the group snapshot) and
 * the member's own OUTGOING entry under the member-as-account key, whose
 * requestedAt the legacy REVOKED write clears. */
function localRecipients(input: GroupDisbandMembershipRevocationInput): SQL {
  return sql`
    recipient_bodies AS MATERIALIZED (
      SELECT ${groupToMemberKey(input.groupAccount, input.memberAccount)}::text AS "compactionKey",
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
      FROM recipient_bodies b
      UNION ALL
      SELECT ${input.localMemberId}::integer, 0, 2,
        ${memberToGroupKey(input.memberAccount, input.groupAccount)}::text,
        ${input.memberAccount}::text, 'local'::text,
        ${input.groupAccount}::text, 'local'::text,
        jsonb_build_object('status', v.status, 'note', '',
          'requestedAt', NULL::bigint,
          'expiresAt', NULL::bigint,
          'direction', 'OUTGOING',
          'threadId', ${input.threadId}::integer,
          'group', jsonb_build_object('account', ${input.groupAccount}::text, 'domain', 'local',
            'isLocal', true, 'name', ${input.groupName}::text, 'avatar', ${input.groupAvatar}::text,
            'description', ${input.groupDescription}::text, 'profileRev', ${input.groupProfileRev}::integer))
      FROM revocation v
    ), ${clientIntentFeedWriteSql()}
  `;
}

/** Peer recipient for a remote member: one RELATIONSHIP_INTENT REVOKED event,
 * suppressed when the peer already holds the identical body (no feed id is
 * consumed). */
function peerRecipient(input: GroupDisbandMembershipRevocationInput): SQL {
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
