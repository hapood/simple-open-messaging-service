import { sql, type SQL } from 'drizzle-orm';
import { authoredIntentWriteSql } from '../../../common/sql/authored-relationship-intent-sql.js';
import { threadFanoutAdmissionSql } from '../../../common/sql/thread-content-fanout-admission-sql.js';
import { groupMemberProfileAddressSql } from '../../meta/group-member-profile-address.js';
import { peerIntentFeedWriteSql } from '../../../common/sql/relationship-intent-recipient-feed-sql.js';
import { isGroupAccount } from '../../../common/account.js';

export interface GroupMembershipRevocationInput {
  threadId: number;
  pairId: bigint;
  groupAccount: string;
  groupProfileRev: number;
  memberAccount: string;
  profileNamespaceId: number;
  /** Local Account.id of the member, or null for a peer-hosted member. */
  localMemberId: number | null;
  /** The REVOKED decision's author coordinates; the receiver is the other
   * endpoint. The `!` sigil distinguishes the group endpoint from the member,
   * so both the direction and the role derive from these two identities. */
  author: { account: string; namespaceId: number };
  receiver: { account: string; namespaceId: number };
  /** Alternate validated writer used by received peer intents: the wire
   * snapshot replaces the locally derived authored write. Consumed by
   * `groupMembershipRevocationIntentWrite`. */
  authoredSql?: SQL;
  /** Optional explicit cause; absent callers use the authored side and the
   * still-open projection direction to classify the terminal feed. */
  clientRequestStatus?: 'WITHDRAWN' | 'REJECTED';
  clientRequestDirection?: 'INCOMING' | 'OUTGOING';
}

function accountFanoutScopeKey(threadId: number, accountId: number): string {
  return JSON.stringify(['ACCOUNT_THREAD_FANOUT', threadId, accountId]);
}

/** The authored REVOKED direction, written before the domain statement in the
 * owning transaction: either the locally authored writer or a received peer
 * intent's validated wire snapshot. The domain statement reads the row back. */
export function groupMembershipRevocationIntentWrite(
  input: GroupMembershipRevocationInput,
): SQL {
  return (
    input.authoredSql ??
    authoredIntentWriteSql({
      author: input.author,
      receiver: input.receiver,
      threadId: input.threadId,
      status: 'REVOKED',
      note: '',
      statusChangedAt: new Date(),
      expiresAt: null,
    })
  );
}

/** One composed domain statement for a REVOKED decision; the intent direction
 * is written beforehand by `groupMembershipRevocationIntentWrite` in the same
 * transaction. The pair's active-to-inactive transition gates the MEMBER_DEPART
 * fact, GROUP_LEFT message, and departure fan-out; an inactive application
 * rejection has none of these effects. Sibling CTEs share the pre-statement
 * snapshot, so federated audience closure excludes this pair explicitly. */
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
  const publishPeer = !localMember && !authorIsMember;
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
    'account', ${input.memberAccount}::text,
    'namespaceId', ${memberProfileNamespaceId}::integer,
    'role', COALESCE((SELECT body ->> 'role' FROM "GroupMetaMemberFeed"
      WHERE "threadId" = ${input.threadId}
        AND body ->> 'account' = ${input.memberAccount}
        AND (body -> 'namespaceId') = to_jsonb(${memberProfileNamespaceId}::integer)
        AND operation = 'MEMBER_UPSERT' LIMIT 1), 'MEMBER')::text,
    'profileRev', COALESCE(${memberProfileRev}, 0)::integer)`;
  const content = sql`jsonb_build_object('type', 'GROUP_LEFT', 'member',
    ${groupMemberProfileAddressSql({
      account: sql`${input.memberAccount}::text`,
      publisherNamespaceId: sql`0`,
      profileNamespaceId: sql`${memberProfileNamespaceId}::integer`,
      profileRev: sql`COALESCE(${memberProfileRev}, 0)::integer`,
    })})`;
  return sql`
    WITH revocation AS MATERIALIZED (
      SELECT status, "profileNamespaceId", "profileRev", note, "statusChangedAt", "expiresAt"
      FROM "RelationshipIntent"
      WHERE "authorAccount" = ${input.author.account} AND "authorNamespaceId" = ${input.author.namespaceId}
        AND "receiverAccount" = ${input.receiver.account} AND "receiverNamespaceId" = ${input.receiver.namespaceId}
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
        ("threadId", "feedId", operation, body)
      SELECT ${input.threadId}, a."metaEndId",
        'MEMBER_DEPART'::"GroupMetaMemberOperation", ${memberBody}::jsonb
      FROM depart_alloc a
      ON CONFLICT ("threadId", (body ->> 'account'), (body -> 'namespaceId'))
        WHERE operation <> 'GROUP_ANNOUNCEMENT'
      DO UPDATE SET "feedId" = EXCLUDED."feedId",
        operation = EXCLUDED.operation, body = EXCLUDED.body,
        "createdAt" = EXCLUDED."createdAt", "originCreatedAt" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
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
    ) ${publishPeer ? sql`, ${peerRecipient(input)}` : sql.empty()}
    SELECT v.status, v.note,
      EXISTS (SELECT 1 FROM pair_change) AS "pairChanged",
      EXISTS (SELECT 1 FROM depart_fact) AS "departed",
      EXISTS (SELECT 1 FROM audience_close) AS "audienceChanged",
      (SELECT seq FROM system_message) AS "systemMessageSeq"
      ${
        publishPeer
          ? sql`, (SELECT "userId" FROM recipient_result) AS "recipientUserId",
        (SELECT "feedId" FROM recipient_result) AS "recipientFeedId"`
          : sql.empty()
      }
    FROM revocation v
    CROSS JOIN (SELECT count(*) FROM seq_alloc) thread_barrier
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
          'statusChangedAt', floor(extract(epoch FROM v."statusChangedAt") * 1000)::bigint,
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
