import { sql, type SQL } from 'drizzle-orm';
import { clientIntentFeedWriteSql } from '../../shared/sql/relationship-intent-recipient-feed-sql.js';
import { threadFanoutAdmissionSql } from '../../shared/sql/thread-content-fanout-admission-sql.js';
import {
  epochMillisSql,
  mirrorIntentCompactionKey,
  mirrorIntentFeedBodySql,
  mirrorIntentReadBackSql,
  mirrorIntentWriteSql,
  type MirrorGroupPresentationInput,
} from '../membership-intent/received/mirror-membership-shared-sql.js';

/** One command: the mirror disband sweep's per-member departure. The origin's
 * dissolution reaches a mirror as lost read access, never as roster DEPARTs
 * (a dissolution appends no synthetic empty roster) and never as a terminal
 * meta head — the meta channel is closed exactly when this sweep runs. This
 * statement therefore synthesizes the mirror departure boundary outright: the
 * mirrored group
 * fact, the member's own closed direction, the GROUP_LEFT message with its
 * watermarks, and the member's client feed row. No meta facts, no audience
 * rows, and no peer state-feed writes — the origin owns those. */
export interface MirrorGroupDisbandRevocationInput {
  threadId: number;
  pairId: bigint;
  presentation: MirrorGroupPresentationInput;
  memberAccount: string;
  localMemberId: number;
}

function accountFanoutScopeKey(threadId: number, accountId: number): string {
  return JSON.stringify(['ACCOUNT_THREAD_FANOUT', threadId, accountId]);
}

/** One composed statement for the mirror disband sweep's per-member departure.
 * The departure effects are gated on the pair's in-statement deactivation, so a
 * replayed child after the sweep converges is a read-only no-op. Sibling CTEs
 * cannot observe one another's writes, so the feed body derives from the
 * statement's own side-A read-back. */
export function mirrorGroupDisbandRevocationSql(
  input: MirrorGroupDisbandRevocationInput,
): SQL {
  const content = JSON.stringify({
    type: 'GROUP_LEFT',
    member: { account: input.memberAccount, domain: 'local' },
  });
  const accountScope = accountFanoutScopeKey(
    input.threadId,
    input.localMemberId,
  );
  return sql`
    WITH authored_a AS (
      ${mirrorIntentWriteSql({
        pairId: input.pairId,
        authorSide: 'A',
        status: 'REVOKED',
        note: '',
        requestedAt: null,
        expiresAt: null,
        profileRev: 0,
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
      })}
    ), authored_b AS (
      ${mirrorIntentWriteSql({
        pairId: input.pairId,
        authorSide: 'B',
        status: 'REVOKED',
        note: '',
        requestedAt: null,
        expiresAt: null,
        profileRev: 0,
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
      })}
    ), ${mirrorIntentReadBackSql({
      writeName: 'authored_a',
      readBackName: 'revocation',
      pairId: input.pairId,
      authorSide: 'A',
    })}, pair_change AS (
      UPDATE "RelationshipPair" SET active = false, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${input.pairId} AND "threadId" = ${input.threadId}
        AND active IS DISTINCT FROM false
      RETURNING id
    ), seq_alloc AS (
      -- One update per row per statement: the head allocation and the touch
      -- share this single write (PostgreSQL applies only one of two updates
      -- to the same row inside one statement).
      UPDATE "MessageThread" t SET "curSeq" = t."curSeq" + 1, "updatedAt" = CURRENT_TIMESTAMP
      WHERE t.id = ${input.threadId} AND EXISTS (SELECT 1 FROM pair_change)
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
      WHERE EXISTS (SELECT 1 FROM system_message)
      RETURNING id
    ), candidate_bodies AS MATERIALIZED (
      SELECT ${input.localMemberId}::integer AS "userId",
        ${input.presentation.groupNamespaceId}::integer AS "namespaceId", 1 AS ordinal,
        ${mirrorIntentCompactionKey({
          groupNamespaceId: input.presentation.groupNamespaceId,
          groupAccount: input.presentation.groupAccount,
          groupDomain: input.presentation.groupDomain,
          memberAccount: input.memberAccount,
        })}::text AS "compactionKey",
        ${input.presentation.groupAccount}::text AS account,
        ${input.presentation.groupDomain}::text AS domain,
        ${input.memberAccount}::text AS "subjectAccount", 'local'::text AS "subjectDomain",
        ${mirrorIntentFeedBodySql({
          status: sql`v.status`,
          note: sql`v.note`,
          requestedAt: epochMillisSql(sql`v."requestedAt"`),
          expiresAt: epochMillisSql(sql`v."expiresAt"`),
          established: sql`(SELECT p.established FROM "RelationshipPair" p
            WHERE p.id = ${input.pairId})`,
          threadId: input.threadId,
          presentation: input.presentation,
        })} AS body
      FROM revocation v
    ), ${clientIntentFeedWriteSql()}
    SELECT EXISTS (SELECT 1 FROM authored_a)
        OR EXISTS (SELECT 1 FROM authored_b) AS "intentChanged",
      EXISTS (SELECT 1 FROM pair_change) AS "pairChanged",
      EXISTS (SELECT 1 FROM departure_task) AS "departureInserted",
      (SELECT seq FROM system_message) AS "systemMessageSeq",
      (SELECT "userId" FROM recipient_result) AS "recipientUserId",
      (SELECT "feedId" FROM recipient_result) AS "recipientFeedId"
    FROM revocation v
    CROSS JOIN (SELECT count(*) FROM seq_alloc) thread_barrier
  `;
}
