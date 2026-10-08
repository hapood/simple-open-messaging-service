import { sql, type SQL } from 'drizzle-orm';
import { authoredIntentWriteSql } from '../../../common/sql/authored-relationship-intent-sql.js';
import { threadFanoutAdmissionSql } from '../../../common/sql/thread-content-fanout-admission-sql.js';
import { requestProjectionFlipSql } from './group-membership-projection-sql.js';
import {
  clientIntentFeedWriteSql,
  peerIntentFeedWriteSql,
} from '../../../common/sql/relationship-intent-recipient-feed-sql.js';
import { isGroupAccount } from '../../../common/account.js';

export interface GroupMembershipRevocationInput {
  threadId: number;
  pairId: bigint;
  groupAccount: string;
  groupAvatar: string;
  groupDescription: string;
  groupProfileRev: number;
  memberAccount: string;
  profileNamespaceId: number;
  /** Local Account.id of the member, or null for a peer-hosted member. */
  localMemberId: number | null;
  /** Existing non-REVOKED projection directions for this member, from authorization. */
  projectionDirections: readonly ('APPLICATION' | 'INVITATION')[];
  /** The REVOKED decision's author coordinates; the receiver is the other
   * endpoint. The `!` sigil distinguishes the group endpoint from the member,
   * so both the direction and the role derive from these two identities. */
  author: { account: string; namespaceId: number };
  receiver: { account: string; namespaceId: number };
  /** Alternate validated writer used by received peer intents: the wire
   * snapshot replaces the locally derived authored write. */
  authoredSql?: SQL;
  /** Optional explicit cause; absent callers use the authored side and the
   * still-open projection direction to classify the terminal feed. */
  clientRequestStatus?: 'WITHDRAWN' | 'REJECTED';
  clientRequestDirection?: 'INCOMING' | 'OUTGOING';
}

function accountFanoutScopeKey(threadId: number, accountId: number): string {
  return JSON.stringify(['ACCOUNT_THREAD_FANOUT', threadId, accountId]);
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
    memberAccount,
  ]);
}

/** One composed statement for a REVOKED decision. The pair's active-to-inactive
 * transition gates the MEMBER_DEPART fact, GROUP_LEFT message, and departure fan-out;
 * an inactive application rejection has none of these effects. Sibling CTEs
 * share the pre-statement snapshot, so federated audience closure excludes this
 * pair explicitly. */
export function groupMembershipRevocationSql(
  input: GroupMembershipRevocationInput,
): SQL {
  const localMember = input.profileNamespaceId === 0;
  const authorIsMember = !isGroupAccount(input.author.account);
  const memberEndpoint = authorIsMember ? input.author : input.receiver;
  const groupEndpoint = authorIsMember ? input.receiver : input.author;
  // A remote member's received member direction has no group-authored recipient
  // event. A still-positive group direction is concluded and published by its
  // own writer.
  const recipient = localMember
    ? localRecipient(input, authorIsMember)
    : authorIsMember
      ? sql`recipient_result AS MATERIALIZED (
          SELECT NULL::integer AS "userId", NULL::text AS "feedId"
        )`
      : peerRecipient(input);
  const accountScope =
    input.localMemberId === null
      ? ''
      : accountFanoutScopeKey(input.threadId, input.localMemberId);
  // Freeze the departing member's final profile reference in the canonical
  // departure body. The body is retained for coordinate continuity but does not
  // cause a profile fetch on mirrors.
  const memberProfileRev = authorIsMember
    ? sql`(SELECT "profileRev" FROM revocation)`
    : sql`(SELECT "profileRev" FROM "RelationshipIntent"
      WHERE "authorAccount" = ${memberEndpoint.account} AND "authorNamespaceId" = ${memberEndpoint.namespaceId}
        AND "receiverAccount" = ${groupEndpoint.account} AND "receiverNamespaceId" = ${groupEndpoint.namespaceId} LIMIT 1)`;
  const memberProfileNamespaceId = input.profileNamespaceId;
  const memberBody = sql`jsonb_build_object(
    'role', COALESCE((SELECT body ->> 'role' FROM "GroupMetaMemberFeed"
      WHERE "threadId" = ${input.threadId}
        AND "memberAccount" = ${input.memberAccount}
        AND "profileNamespaceId" = ${memberProfileNamespaceId}
        AND operation = 'MEMBER_UPSERT' LIMIT 1), 'MEMBER')::text,
    'profileNamespaceId', ${memberProfileNamespaceId}::integer,
    'profileRev', COALESCE(${memberProfileRev}, 0)::integer)`;
  const content = sql`jsonb_build_object('type', 'GROUP_LEFT', 'member',
    jsonb_build_object('account', ${input.memberAccount}::text,
      'profileNamespaceId', ${memberProfileNamespaceId}::integer,
      'profileRev', COALESCE(${memberProfileRev}, 0)))`;
  return sql`
    WITH authored AS (
      ${
        input.authoredSql ??
        authoredIntentWriteSql({
          author: input.author,
          receiver: input.receiver,
          threadId: input.threadId,
          status: 'REVOKED',
          note: '',
          requestedAt: null,
          expiresAt: null,
        })
      }
    ), revocation AS MATERIALIZED (
      SELECT status, "profileNamespaceId", "profileRev", note, "requestedAt", "expiresAt" FROM authored
      UNION ALL
      SELECT status, "profileNamespaceId", "profileRev", note, "requestedAt", "expiresAt"
      FROM "RelationshipIntent"
      WHERE "authorAccount" = ${input.author.account} AND "authorNamespaceId" = ${input.author.namespaceId}
        AND "receiverAccount" = ${input.receiver.account} AND "receiverNamespaceId" = ${input.receiver.namespaceId}
        AND NOT EXISTS (SELECT 1 FROM authored)
    ), pair_change AS (
      UPDATE "RelationshipPair" SET active = false, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${input.pairId} AND "threadId" = ${input.threadId}
        AND active IS DISTINCT FROM false
      RETURNING id
    ), depart_alloc AS (
      UPDATE "GroupMeta" f SET "metaEndId" = f."metaEndId" + 1, "updatedAt" = CURRENT_TIMESTAMP
      FROM pair_change p WHERE f."threadId" = ${input.threadId}
      RETURNING f."metaEndId"
    ), depart_fact AS (
      INSERT INTO "GroupMetaMemberFeed"
        ("threadId", "feedId", "memberAccount", "profileNamespaceId", operation, body)
      SELECT ${input.threadId}, a."metaEndId", ${input.memberAccount}, ${memberProfileNamespaceId},
        'MEMBER_DEPART'::"GroupMetaMemberOperation", ${memberBody}::jsonb
      FROM depart_alloc a
      ON CONFLICT ("threadId", "memberAccount", "profileNamespaceId")
      DO UPDATE SET "feedId" = EXCLUDED."feedId",
        operation = EXCLUDED.operation, body = EXCLUDED.body, "updatedAt" = CURRENT_TIMESTAMP
      RETURNING "feedId"
    ), seq_alloc AS (
      -- One update per row per statement: the head allocation and the touch
      -- share this single write (PostgreSQL applies only one of two updates
      -- to the same row inside one statement).
      UPDATE "MessageThread" t SET "curSeq" = t."curSeq" + 1, "updatedAt" = CURRENT_TIMESTAMP
      FROM pair_change p WHERE t.id = ${input.threadId}
      RETURNING t."curSeq", t."tombstoneEndSeq"
    ), system_message AS (
      INSERT INTO "Message" ("threadId", seq, "contentType", content, "creatorAccount", "profileNamespaceId", "publisherNamespaceId", "updatedAt")
      SELECT ${input.threadId}, s."curSeq", 'SYSTEM'::"ContentType", ${content}::jsonb,
        '$system', 0, 0, CURRENT_TIMESTAMP
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
      FROM pair_change p
      WHERE ${input.localMemberId}::integer IS NOT NULL
        AND EXISTS (SELECT 1 FROM system_message)
      RETURNING id
    ), ${threadFanoutAdmissionSql({
      threadId: input.threadId,
      prefix: 'federation_fanout',
      federation: true,
    })}, ${requestProjectionFlipSql({
      threadId: input.threadId,
      memberAccount: input.memberAccount,
      profileNamespaceId: input.profileNamespaceId,
      status: 'REVOKED',
      authorAccount: input.author.account,
      directions: input.projectionDirections,
    })}, audience_close AS (
      DELETE FROM "ThreadAudience" ta
      WHERE ta."threadId" = ${input.threadId} AND (
        (ta."localUserId" = ${input.localMemberId}
          AND ta."targetNamespaceId" = 0)
        OR (${localMember ? sql`false` : sql`true`}
          AND ta."targetNamespaceId" = ${input.profileNamespaceId}
          AND NOT EXISTS (SELECT 1 FROM "RelationshipPair" p
            WHERE p.kind = 'GROUP_MEMBER' AND p."threadId" = ${input.threadId}
              AND p.active AND p."endpointBNamespaceId" = ${input.profileNamespaceId}
              AND p."endpointBType" = 'USER'
              AND p.id <> ${input.pairId})))
      RETURNING ta.id
    ), ${recipient}
    SELECT v.status, v.note,
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
function localRecipient(
  input: GroupMembershipRevocationInput,
  authorIsMember: boolean,
): SQL {
  const projection = input.projectionDirections[0];
  const direction =
    input.clientRequestDirection ??
    (projection === 'APPLICATION' ? 'OUTGOING' : 'INCOMING');
  const status =
    input.clientRequestStatus ??
    (projection === undefined
      ? null
      : authorIsMember
        ? projection === 'APPLICATION'
          ? 'WITHDRAWN'
          : 'REJECTED'
        : projection === 'APPLICATION'
          ? 'REJECTED'
          : 'WITHDRAWN');
  return sql`
    recipient_body AS MATERIALIZED (
      SELECT ${localRecipientKey(input.groupAccount, input.memberAccount)}::text AS "compactionKey",
        jsonb_build_object('status', v.status, 'note', v.note,
          'requestedAt', floor(extract(epoch FROM v."requestedAt") * 1000)::bigint,
          'expiresAt', CASE WHEN v."expiresAt" IS NULL THEN NULL
            ELSE floor(extract(epoch FROM v."expiresAt") * 1000)::bigint END,
          'threadId', ${input.threadId}::integer,
          'established', (SELECT p.established FROM "RelationshipPair" p WHERE p.id = ${input.pairId}),
          'group', jsonb_build_object('account', ${input.groupAccount}::text, 'namespaceId', 0,
            'description', ${input.groupDescription}::text, 'profileRev', ${input.groupProfileRev}::integer)
        ) || CASE WHEN ${status === null} THEN '{}'::jsonb
          ELSE jsonb_build_object('requestStatus', ${status}::text,
            'requestDirection', ${direction}::text) END AS body
      FROM revocation v
    ), candidate_bodies AS MATERIALIZED (
      SELECT ${input.localMemberId}::integer AS "userId", 0 AS "namespaceId", 1 AS ordinal,
        b."compactionKey", ${input.groupAccount}::text AS account, (SELECT domain FROM "IdentityNamespace" WHERE id = 0)::text AS domain,
        ${input.memberAccount}::text AS "subjectAccount", 0::integer AS "subjectNamespaceId", b.body
      FROM recipient_body b
    ), ${clientIntentFeedWriteSql()}
  `;
}

/** Group-authored peer recipient: one side-A RELATIONSHIP_INTENT REVOKED event, suppressed when the
 * peer already holds the identical body (no feed id is consumed). */
function peerRecipient(input: GroupMembershipRevocationInput): SQL {
  return sql`
    peer_write AS MATERIALIZED (
      SELECT jsonb_build_object('status', v.status,
          'namespaceId', v."profileNamespaceId",
          'profileRev', v."profileRev", 'note', v.note,
          'requestedAt', floor(extract(epoch FROM v."requestedAt") * 1000)::bigint,
          'expiresAt', CASE WHEN v."expiresAt" IS NULL THEN NULL
            ELSE floor(extract(epoch FROM v."expiresAt") * 1000)::bigint END) AS body
      FROM revocation v
    ), peer_changes AS MATERIALIZED (
      SELECT ${input.memberAccount}::text AS "subjectAccount", ${input.profileNamespaceId}::integer AS "subjectNamespaceId",
        p.body, row_number() OVER () AS position, false AS invalid
      FROM peer_write p
      LEFT JOIN "PeerStateFeed" old ON old."namespaceId" = ${input.profileNamespaceId}
        AND old.account = ${input.groupAccount}
        AND old."eventType" = 'RELATIONSHIP_INTENT'
        AND old."subjectAccount" = ${input.memberAccount} AND old."subjectNamespaceId" = ${input.profileNamespaceId}
      WHERE old.body IS DISTINCT FROM p.body
    ), ${peerIntentFeedWriteSql({
      namespaceId: input.profileNamespaceId,
      selfAccount: input.groupAccount,
    })}
  `;
}
