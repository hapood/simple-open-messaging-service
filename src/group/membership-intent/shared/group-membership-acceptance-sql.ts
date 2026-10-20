import { FEDERATION_HISTORY_ACCESS_SETTING_KEY } from '../../../federation/federation-history-access-setting.js';
import { sql, type SQL } from 'drizzle-orm';
import { authoredIntentWriteSql } from '../../../common/sql/authored-relationship-intent-sql.js';
import { threadFanoutAdmissionSql } from '../../../common/sql/thread-content-fanout-admission-sql.js';
import { groupMemberProfileAddressSql } from '../../meta/group-member-profile-address.js';

export interface GroupMembershipAcceptanceInput {
  pairId: bigint;
  threadId: number;
  groupAccount: string;
  groupProfileRev: number;
  memberAccount: string;
  profileNamespaceId: number;
  note: string;
  acceptedAt: Date;
  /** The member's ACK authors the member direction as well: it is the only
   * writer in this business family of a member-direction ACCEPTED, and
   * `join_source` reads the written row back so the roster fact sees this
   * round's profile revision. */
  memberAck?: boolean;
  /** Alternate validated writer for that side B ACK: a received peer intent
   * substitutes the wire snapshot (profileRev and heads are the origin's, not
   * locally derivable). Consumed by `groupMembershipAcceptanceIntentWrites`. */
  memberAuthoredSql?: SQL;
}

/** Authored ACCEPTED directions, written before the domain statement in the
 * owning transaction. Side A is the group's ACK. Side B is added for the
 * member's own ACK (`memberAuthoredSql` substitutes a received peer intent's
 * validated wire snapshot), and — with P2P reverse-upgrade parity — for a
 * manager's ACK of a **local** application: the applicant direction is
 * promoted in place (status/expiresAt only; its note, requestedAt and profile
 * reference survive). A remote applicant is never written here; its home
 * folds the direction from the wire ACK (mirror activation promote). Each
 * write runs as its own statement; the domain statement then reads the
 * committed rows back. */
export function groupMembershipAcceptanceIntentWrites(
  input: GroupMembershipAcceptanceInput,
): SQL[] {
  const sideA = authoredIntentWriteSql({
    author: { account: input.groupAccount, namespaceId: 0 },
    receiver: {
      account: input.memberAccount,
      namespaceId: input.profileNamespaceId,
    },
    threadId: input.threadId,
    status: 'ACCEPTED',
    note: input.note,
    requestedAt: input.acceptedAt,
    expiresAt: null,
  });
  if (input.memberAck) {
    const sideB =
      input.memberAuthoredSql ??
      authoredIntentWriteSql({
        author: {
          account: input.memberAccount,
          namespaceId: input.profileNamespaceId,
        },
        receiver: { account: input.groupAccount, namespaceId: 0 },
        threadId: input.threadId,
        status: 'ACCEPTED',
        note: input.note,
        requestedAt: input.acceptedAt,
        expiresAt: null,
      });
    return [sideA, sideB];
  }
  if (input.profileNamespaceId === 0)
    return [sideA, localApplicantPromotionSql(input)];
  return [sideA];
}

/** The manager-ACK promotion of a local application direction, mirroring the
 * P2P reverse upgrade: a still-live REQUESTED application collapses to
 * ACCEPTED without touching its note, requestedAt or profile coordinates, so
 * the applicant's own record stays its author's history. */
function localApplicantPromotionSql(
  input: GroupMembershipAcceptanceInput,
): SQL {
  return sql`
      UPDATE "RelationshipIntent" SET
        status = 'ACCEPTED'::"RelationshipIntentStatus",
        "expiresAt" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "authorAccount" = ${input.memberAccount} AND "authorNamespaceId" = 0
        AND "receiverAccount" = ${input.groupAccount} AND "receiverNamespaceId" = 0
        AND status = 'REQUESTED' AND "expiresAt" > CURRENT_TIMESTAMP
    `;
}

/** Shared CTE contract: join_source, accepted_intent, pair_change, roster_plan,
 * meta_head, seq_alloc and system_message. Input identities and locks are
 * validated by the transaction owner, and both intent directions are already
 * written by `groupMembershipAcceptanceIntentWrites` in this transaction, so
 * this statement owns domain effects only and reads the intent rows back. */
function relationshipAndRoster(input: GroupMembershipAcceptanceInput): SQL {
  return sql`
    join_source AS MATERIALIZED (
      SELECT p.active AS "wasActive", t."curSeq", t."authorizationEpoch",
        b.note AS "requestNote", b."requestedAt", b."expiresAt",
        b."profileRev" AS "memberProfileRev", b."messageEndSeq" AS "sourceMessageEndSeq",
        b."tombstoneEndSeq" AS "sourceDeletionEndSeq"
      FROM "RelationshipPair" p JOIN "MessageThread" t ON t.id = p."threadId"
      JOIN "RelationshipIntent" b
        ON b."authorAccount" = ${input.memberAccount} AND b."authorNamespaceId" = ${input.profileNamespaceId}
          AND b."receiverAccount" = ${input.groupAccount} AND b."receiverNamespaceId" = 0
      WHERE p.id = ${input.pairId} AND t.id = ${input.threadId}
    ), accepted_intent AS MATERIALIZED (
      SELECT status, "profileRev", note, "requestedAt", "expiresAt"
      FROM "RelationshipIntent"
      WHERE "authorAccount" = ${input.groupAccount} AND "authorNamespaceId" = 0
        AND "receiverAccount" = ${input.memberAccount} AND "receiverNamespaceId" = ${input.profileNamespaceId}
    ), pair_change AS (
      UPDATE "RelationshipPair" SET active = true, established = true, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${input.pairId} AND NOT active AND EXISTS (SELECT 1 FROM accepted_intent)
      RETURNING id
    ), roster_plan AS MATERIALIZED (
      SELECT 'MEMBER'::text AS role,
        EXISTS (SELECT 1 FROM pair_change) AS "memberChanged",
        EXISTS (SELECT 1 FROM pair_change)
          AND profile."profileRev" IS DISTINCT FROM ${input.groupProfileRev}::integer AS "profileChanged"
      FROM join_source
      LEFT JOIN "GroupMeta" profile ON profile."threadId" = ${input.threadId}
      WHERE EXISTS (SELECT 1 FROM accepted_intent)
    ), meta_allocation AS (
      UPDATE "GroupMeta" f SET
        "metaEndId" = f."metaEndId" + p."memberChanged"::integer + p."profileChanged"::integer,
        "profileRev" = CASE WHEN p."profileChanged"
          THEN ${input.groupProfileRev}::integer ELSE f."profileRev" END,
        "updatedAt" = CURRENT_TIMESTAMP
      FROM roster_plan p WHERE f."threadId" = ${input.threadId} AND (p."memberChanged" OR p."profileChanged")
      RETURNING f."metaEndId"
    ), meta_head AS MATERIALIZED (
      SELECT "metaEndId" FROM meta_allocation
      UNION ALL SELECT "metaEndId" FROM "GroupMeta" WHERE "threadId" = ${input.threadId}
        AND NOT EXISTS (SELECT 1 FROM meta_allocation)
    ), member_fact AS (
      INSERT INTO "GroupMetaMemberFeed" ("threadId", "feedId", operation, body)
      SELECT ${input.threadId}, h."metaEndId" - p."profileChanged"::integer,
        'MEMBER_UPSERT', jsonb_build_object(
          'account', ${input.memberAccount}::text,
          'namespaceId', ${input.profileNamespaceId}::integer,
          'role', p.role,
          'profileRev', s."memberProfileRev"
        )
      FROM meta_head h CROSS JOIN roster_plan p CROSS JOIN join_source s
      CROSS JOIN meta_allocation
      WHERE p."memberChanged"
      ON CONFLICT ("threadId", (body ->> 'account'), (body -> 'namespaceId'))
        WHERE operation <> 'GROUP_ANNOUNCEMENT'
      DO UPDATE SET "feedId" = EXCLUDED."feedId",
        operation = EXCLUDED.operation, body = EXCLUDED.body,
        "profileSourceSeq" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      RETURNING "feedId"
    ), profile_fact AS (
      INSERT INTO "GroupMetaMemberFeed" ("threadId", "feedId", operation, body)
      SELECT ${input.threadId}, h."metaEndId",
        'GROUP_PROFILE'::"GroupMetaMemberOperation",
        jsonb_build_object('account', ${input.groupAccount}::text, 'namespaceId', 0,
          'profileRev', ${input.groupProfileRev}::integer)
      FROM meta_head h CROSS JOIN roster_plan p
      CROSS JOIN meta_allocation
      WHERE p."profileChanged"
      ON CONFLICT ("threadId", (body ->> 'account'), (body -> 'namespaceId'))
        WHERE operation <> 'GROUP_ANNOUNCEMENT'
      DO UPDATE SET "feedId" = EXCLUDED."feedId",
        operation = EXCLUDED.operation, body = EXCLUDED.body, "updatedAt" = CURRENT_TIMESTAMP
      RETURNING "feedId"
    ), group_profile_source AS MATERIALIZED (
      SELECT "feedId" AS "profileSourceId" FROM profile_fact
      UNION ALL
      SELECT fact."feedId" AS "profileSourceId"
      FROM "GroupMetaMemberFeed" fact
      WHERE fact."threadId" = ${input.threadId} AND fact.operation = 'GROUP_PROFILE'
        AND fact.body -> 'profileRev' = to_jsonb(${input.groupProfileRev}::integer)
        AND NOT EXISTS (SELECT 1 FROM profile_fact)
    ), seq_alloc AS (
      UPDATE "MessageThread" t SET
        "updatedAt" = CURRENT_TIMESTAMP,
        "curSeq" = t."curSeq" + (CASE WHEN EXISTS (SELECT 1 FROM pair_change) THEN 1 ELSE 0 END),
        "federationRoundsEnabled" = CASE WHEN ${input.profileNamespaceId === 0} THEN true ELSE t."federationRoundsEnabled" END
      FROM roster_plan p
      WHERE t.id = ${input.threadId} AND EXISTS (SELECT 1 FROM pair_change)
      RETURNING t."curSeq", t."tombstoneEndSeq"
    ), system_message AS (
      INSERT INTO "Message" ("threadId", seq, "contentType", content, "creatorAccount", "profileNamespaceId", "publisherNamespaceId", "updatedAt")
      SELECT ${input.threadId}, s."curSeq", 'SYSTEM'::"ContentType",
        jsonb_build_object('type', 'GROUP_JOINED', 'member',
          ${groupMemberProfileAddressSql({
            account: sql`${input.memberAccount}::text`,
            publisherNamespaceId: sql`0`,
            profileNamespaceId: sql`${input.profileNamespaceId}::integer`,
            profileRev: sql`(SELECT "memberProfileRev" FROM join_source)`,
          })}),
        '$system', 0, 0, CURRENT_TIMESTAMP
      FROM seq_alloc s CROSS JOIN roster_plan p
      WHERE EXISTS (SELECT 1 FROM pair_change)
      RETURNING seq
    )`;
}

/** An authoritative group's local activation starts fully read at curSeq, with no preview.
 * Since the read boundary reaches curSeq, no message/mention rescan is needed. Existing monotonic
 * read positions and unrelated preferences remain intact; unavailable accounts are not initialized. */
function localMember(input: GroupMembershipAcceptanceInput): SQL {
  return sql`
    local_member AS MATERIALIZED (
      SELECT * FROM "Account" WHERE account = ${input.memberAccount} AND "namespaceId" = 0
    ), member_state AS (
      INSERT INTO "AccountThreadState" ("accountId", "threadId", role, "lastReadSeq", "groupMetaFeedEndId", "threadProfileRev", "profileSourceId", "updatedAt")
      SELECT a.id, ${input.threadId}, p.role::"GroupRole",
        CASE WHEN a.availability = 'AVAILABLE' AND NOT s."wasActive" THEN s."curSeq" ELSE 0 END,
        h."metaEndId", ${input.groupProfileRev}, (SELECT "profileSourceId" FROM group_profile_source), CURRENT_TIMESTAMP
      FROM local_member a CROSS JOIN roster_plan p CROSS JOIN join_source s
      CROSS JOIN accepted_intent i
      CROSS JOIN (SELECT count(*) FROM pair_change) pair_barrier
      CROSS JOIN (SELECT count(*) FROM member_fact) roster_barrier
      CROSS JOIN meta_head h
      ON CONFLICT ("accountId", "threadId") DO UPDATE SET
        role = EXCLUDED.role, "messageVisibleThroughSeq" = NULL, "updatedAt" = CURRENT_TIMESTAMP,
        "threadProfileRev" = CASE WHEN (SELECT "wasActive" FROM join_source)
          THEN "AccountThreadState"."threadProfileRev" ELSE EXCLUDED."threadProfileRev" END,
        "profileSourceId" = CASE WHEN (SELECT "wasActive" FROM join_source)
          THEN "AccountThreadState"."profileSourceId" ELSE EXCLUDED."profileSourceId" END,
        "groupMetaFeedEndId" = GREATEST(
          COALESCE("AccountThreadState"."groupMetaFeedEndId", 0), EXCLUDED."groupMetaFeedEndId"),
        "lastReadSeq" = CASE WHEN (SELECT availability = 'AVAILABLE' FROM local_member) AND NOT (SELECT "wasActive" FROM join_source)
          THEN GREATEST("AccountThreadState"."lastReadSeq", EXCLUDED."lastReadSeq") ELSE "AccountThreadState"."lastReadSeq" END,
        "unreadCount" = CASE WHEN (SELECT availability = 'AVAILABLE' FROM local_member) AND NOT (SELECT "wasActive" FROM join_source)
          THEN 0 ELSE "AccountThreadState"."unreadCount" END,
        "previewSeqs" = CASE WHEN (SELECT availability = 'AVAILABLE' FROM local_member) AND NOT (SELECT "wasActive" FROM join_source)
          THEN '{}'::integer[] ELSE "AccountThreadState"."previewSeqs" END,
        "lastMentionSeq" = CASE WHEN (SELECT availability = 'AVAILABLE' FROM local_member) AND NOT (SELECT "wasActive" FROM join_source)
          THEN NULL ELSE "AccountThreadState"."lastMentionSeq" END
      RETURNING "accountId"
    ), audience_change AS (
      INSERT INTO "ThreadAudience" ("threadId", "targetNamespaceId", "localUserId", "groupMetaVisibleAfter")
      SELECT ${input.threadId}, 0, m."accountId", h."metaEndId" FROM member_state m CROSS JOIN meta_head h
      ON CONFLICT ("localUserId", "threadId") WHERE "localUserId" IS NOT NULL DO NOTHING
      RETURNING id
    )`;
}

/** This branch only handles a local group receiving a remote member, so reverseEnabled=false.
 * Preserve processed coordinates on re-entry; an epoch change may require deletion recovery. */
function remoteMember(input: GroupMembershipAcceptanceInput): SQL {
  return sql`
    history_policy AS MATERIALIZED (
      SELECT COALESCE((SELECT value <> 'false' FROM "SystemSetting"
        WHERE key = ${FEDERATION_HISTORY_ACCESS_SETTING_KEY}), true) AS allowed
    ), audience_boundary AS MATERIALIZED (
      SELECT CASE WHEN allowed THEN 0 ELSE (SELECT "curSeq" FROM join_source) END AS "messageAccessAfterSeq"
      FROM history_policy
    ), source_sync AS (
      INSERT INTO "FederationThreadSyncState" ("threadId", "namespaceId", "messageTargetSeq", "deletionTargetSeq",
        "messageProcessedThroughSeq", "deletionProcessedThroughSeq", "authorizationEpoch", "updatedAt")
      SELECT ${input.threadId}, ${input.profileNamespaceId}, s."sourceMessageEndSeq", s."sourceDeletionEndSeq",
        0, 0, s."authorizationEpoch", CURRENT_TIMESTAMP
      FROM join_source s CROSS JOIN (SELECT count(*) FROM pair_change) pair_barrier
      WHERE NOT s."wasActive"
      ON CONFLICT ("threadId", "namespaceId") DO UPDATE SET
        "messageTargetSeq" = GREATEST("FederationThreadSyncState"."messageTargetSeq", EXCLUDED."messageTargetSeq"),
        "deletionTargetSeq" = GREATEST("FederationThreadSyncState"."deletionTargetSeq", EXCLUDED."deletionTargetSeq"),
        "deletionRecoveryThroughSeq" = CASE WHEN "FederationThreadSyncState"."authorizationEpoch" = EXCLUDED."authorizationEpoch"
          THEN "FederationThreadSyncState"."deletionRecoveryThroughSeq"
          WHEN GREATEST("FederationThreadSyncState"."deletionTargetSeq", EXCLUDED."deletionTargetSeq") > "FederationThreadSyncState"."deletionProcessedThroughSeq"
          THEN GREATEST("FederationThreadSyncState"."deletionTargetSeq", EXCLUDED."deletionTargetSeq") ELSE NULL END,
        "deletionRecoveryMaxMessageSeq" = CASE WHEN "FederationThreadSyncState"."authorizationEpoch" = EXCLUDED."authorizationEpoch"
          THEN "FederationThreadSyncState"."deletionRecoveryMaxMessageSeq"
          WHEN GREATEST("FederationThreadSyncState"."deletionTargetSeq", EXCLUDED."deletionTargetSeq") > "FederationThreadSyncState"."deletionProcessedThroughSeq"
          THEN "FederationThreadSyncState"."messageProcessedThroughSeq" ELSE NULL END,
        "activeGapId" = CASE WHEN "FederationThreadSyncState"."authorizationEpoch" = EXCLUDED."authorizationEpoch"
          THEN "FederationThreadSyncState"."activeGapId" ELSE NULL END,
        "authorizationEpoch" = EXCLUDED."authorizationEpoch", "updatedAt" = CURRENT_TIMESTAMP
      RETURNING "threadId"
    ), audience_change AS (
      INSERT INTO "ThreadAudience" ("threadId", "targetNamespaceId", "localUserId", "groupMetaVisibleAfter", "messageAccessAfterSeq")
      SELECT ${input.threadId}, ${input.profileNamespaceId}, NULL, h."metaEndId",
        boundary."messageAccessAfterSeq"
      FROM meta_head h CROSS JOIN audience_boundary boundary
      CROSS JOIN (SELECT count(*) FROM member_fact) roster_barrier
      CROSS JOIN (SELECT count(*) FROM source_sync) sync_barrier
      ON CONFLICT ("targetNamespaceId", "threadId") WHERE "localUserId" IS NULL DO NOTHING
      RETURNING id, "messageAccessAfterSeq"
    ), branch_done AS MATERIALIZED (
      SELECT count(*) FROM source_sync
    ), ${peerRecipient(input)}`;
}

function peerRecipient(input: GroupMembershipAcceptanceInput): SQL {
  return sql`
    audience_floor AS MATERIALIZED (
      SELECT "messageAccessAfterSeq" FROM audience_change
      UNION ALL SELECT "messageAccessAfterSeq" FROM "ThreadAudience"
      WHERE "threadId" = ${input.threadId} AND "targetNamespaceId" = ${input.profileNamespaceId}
        AND NOT EXISTS (SELECT 1 FROM audience_change)
    ), peer_heads AS MATERIALIZED (
      SELECT COALESCE((SELECT max(seq) FROM "Message" WHERE "threadId" = ${input.threadId}
        AND seq > a."messageAccessAfterSeq" AND "contentType" <> 'SYSTEM'), a."messageAccessAfterSeq") AS "messageEndSeq",
        COALESCE((SELECT max(d."deletionSeq") FROM "DeletedMessage" d JOIN "Message" m ON m."threadId" = d."threadId" AND m.seq = d."messageSeq"
          WHERE d."threadId" = ${input.threadId} AND d."publisherNamespaceId" = 0), 0) AS "tombstoneEndSeq",
        COALESCE((SELECT max(seq) FROM "Message" WHERE "threadId" = ${input.threadId} AND "contentType" <> 'SYSTEM'), 0) AS "relationshipMessageEndSeq",
        m."metaEndId" AS "groupMetaFeedEndId"
      FROM audience_floor a CROSS JOIN branch_done CROSS JOIN meta_head m
    ), peer_writes AS MATERIALIZED (
      SELECT 'THREAD_CONTENT_HEAD'::"PeerStateEventType" AS "eventType", ''::text AS "subjectAccount", 0::integer AS "subjectNamespaceId", 1 AS ordinal,
        jsonb_build_object('messageEndSeq', h."messageEndSeq", 'tombstoneEndSeq', h."tombstoneEndSeq",
          'groupMetaFeedEndId', h."groupMetaFeedEndId") AS body FROM peer_heads h
      UNION ALL
      SELECT 'RELATIONSHIP_INTENT'::"PeerStateEventType", ${input.memberAccount}, ${input.profileNamespaceId}, 2,
        jsonb_build_object('status', i.status, 'namespaceId', 0, 'profileRev', i."profileRev", 'note', i.note,
          'requestedAt', floor(extract(epoch FROM i."requestedAt") * 1000)::bigint, 'expiresAt', NULL,
          'messageEndSeq', h."relationshipMessageEndSeq", 'tombstoneEndSeq', h."tombstoneEndSeq")
      FROM peer_heads h CROSS JOIN accepted_intent i
    ), peer_changes AS MATERIALIZED (
      SELECT w.*, row_number() OVER (ORDER BY w.ordinal) AS position,
        w."eventType" = 'THREAD_CONTENT_HEAD' AND old.body IS DISTINCT FROM w.body
          AND old.body->'messageEndSeq' = w.body->'messageEndSeq' AND old.body->'tombstoneEndSeq' = w.body->'tombstoneEndSeq'
          AND COALESCE(old.body->>'groupMetaFeedEndId', '') = COALESCE(w.body->>'groupMetaFeedEndId', '') AS invalid
      FROM peer_writes w LEFT JOIN "PeerStateFeed" old ON old."namespaceId" = ${input.profileNamespaceId}
        AND old.account = ${input.groupAccount} AND old."eventType" = w."eventType"
        AND old."subjectAccount" = w."subjectAccount" AND old."subjectNamespaceId" = w."subjectNamespaceId"
      WHERE w."eventType" = 'RELATIONSHIP_INTENT' OR old.body IS DISTINCT FROM w.body
    ), peer_allocation AS (
      UPDATE "IdentityNamespace" SET "stateFeedEndId" = "stateFeedEndId" + (SELECT count(*) FROM peer_changes)
      WHERE id = ${input.profileNamespaceId} AND "retiredAt" IS NULL
      RETURNING "stateFeedEndId" AS "allocatedThrough"
    ), peer_feeds AS (
      INSERT INTO "PeerStateFeed" ("namespaceId", account, "eventType", "subjectAccount", "subjectNamespaceId", "feedId", body)
      SELECT ${input.profileNamespaceId}, ${input.groupAccount}, w."eventType", w."subjectAccount", w."subjectNamespaceId",
        a."allocatedThrough" - (SELECT count(*) FROM peer_changes) + w.position, w.body FROM peer_changes w CROSS JOIN peer_allocation a
      ON CONFLICT ("namespaceId", account, "eventType", "subjectAccount", "subjectNamespaceId") DO UPDATE SET
        "feedId" = EXCLUDED."feedId", body = EXCLUDED.body, "updatedAt" = CURRENT_TIMESTAMP
      RETURNING "feedId"
    ), recipient_result AS MATERIALIZED (
      SELECT NULL::integer AS "userId", max("feedId")::text AS "feedId", COALESCE((SELECT bool_or(invalid) FROM peer_changes), false) AS invalid FROM peer_feeds
    )`;
}

/** One parameterized domain statement; the intent directions are written
 * beforehand by the shared authored-intent writers in the same transaction.
 * CTE output dependencies connect the common and address-specific parts. The
 * roster effect admits the local and federation thread fan-outs in the same
 * statement (forward heads only; the executor reconciles the Meta coordinate). */
export function groupMembershipAcceptanceSql(
  input: GroupMembershipAcceptanceInput,
): SQL {
  return sql`WITH ${relationshipAndRoster(input)},
    ${input.profileNamespaceId === 0 ? localMember(input) : remoteMember(input)},
    ${threadFanoutAdmissionSql({
      threadId: input.threadId,
      prefix: 'thread_fanout',
      federation: false,
    })},
    ${threadFanoutAdmissionSql({
      threadId: input.threadId,
      prefix: 'federation_fanout',
      federation: true,
    })}
    SELECT i.status, i."profileRev", i.note, i."requestedAt", i."expiresAt",
      ${
        input.profileNamespaceId !== 0
          ? sql`
        (SELECT "feedId" FROM recipient_result) AS "recipientFeedId",
        (SELECT "userId" FROM recipient_result) AS "recipientUserId",
        COALESCE((SELECT invalid FROM recipient_result), false) AS "invalidPeerHead",`
          : sql.empty()
      }
      p."memberChanged" AS "canonicalRosterChanged", EXISTS (SELECT 1 FROM audience_change) AS "audienceChanged",
      h."metaEndId"::text AS "groupMetaFeedEndId",
      (SELECT seq FROM system_message) AS "systemMessageSeq"
    FROM accepted_intent i CROSS JOIN roster_plan p CROSS JOIN meta_head h
    CROSS JOIN (SELECT count(*) FROM seq_alloc) thread_barrier`;
}
