import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { parseSomfpUserMentionEntity } from '../common/account.js';
import { parseMessageEntities } from '../common/message-entity.js';
import { parseTextMessageContent } from '../../shared/text-message-content.js';
import { THREAD_PREVIEW_LIMIT } from './thread-preview-limit.js';

function userMentionTargetsIdentity(
  entityId: string,
  self: { account: string; namespaceId: number | null },
): boolean {
  const target = parseSomfpUserMentionEntity(entityId);
  return (
    !!target &&
    target.namespaceId === self.namespaceId &&
    target.account === self.account
  );
}

/** User tokens always use the group origin's namespace space, even on mirrors.
 * A missing peer-assigned namespace cannot identify a user mention. */
export function mentionsAccount(
  content: string,
  self: { account: string; namespaceId: number | null },
): boolean {
  const text = parseTextMessageContent(content)?.text ?? '';
  return parseMessageEntities(text).some(
    (entity) =>
      entity.kind === 'entity' &&
      ((entity.entityType === 'audience' && entity.entityId === 'all') ||
        (entity.entityType === 'user' &&
          userMentionTargetsIdentity(entity.entityId, self))),
  );
}

type MentionProjectionState = {
  account: string;
  selfMentionNamespaceId: number | null;
  unreadCount: number;
  previewSeqs: number[];
  previewDeletedSeqs: number[];
  lastReadSeq: number;
  lastMentionSeq: number | null;
  messageEndSeq: number;
  threadProfileRev: number;
  profileSourceId: number | null;
  blocked: boolean;
  clearedSeq: number | null;
  messageVisibleThroughSeq: number | null;
};

/** Count eligible immutable message slots in (afterSeq, throughSeq], including tombs. */
export interface ThreadUnreadInterval {
  afterSeq: number;
  throughSeq: number;
  sign: 1 | -1;
}

export interface ThreadProjectionChange {
  unreadCountChanged: boolean;
  previewChanged: boolean;
}

function coordinate(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError('thread sequence must be a nonnegative int32');
  }
}

function interval(
  afterSeq: number,
  throughSeq: number,
  sign: 1 | -1,
): ThreadUnreadInterval | null {
  return afterSeq < throughSeq ? { afterSeq, throughSeq, sign } : null;
}

/** Inputs must come from locked state and a complete committed forward boundary. */
export function messageAdvanceInterval(
  lastReadSeq: number,
  previousEndSeq: number,
  targetEndSeq: number,
): ThreadUnreadInterval | null {
  [lastReadSeq, previousEndSeq, targetEndSeq].forEach(coordinate);
  return interval(Math.max(lastReadSeq, previousEndSeq), targetEndSeq, 1);
}

/** Resolve force/monotonic semantics and validate history gaps before calling. */
export function readPositionInterval(
  previousReadSeq: number,
  nextReadSeq: number,
  messageEndSeq: number,
): ThreadUnreadInterval | null {
  [previousReadSeq, nextReadSeq, messageEndSeq].forEach(coordinate);
  return nextReadSeq >= previousReadSeq
    ? interval(previousReadSeq, Math.min(nextReadSeq, messageEndSeq), -1)
    : interval(nextReadSeq, Math.min(previousReadSeq, messageEndSeq), 1);
}

/** Publish content coordinates and mentions; the row trigger allocates the shared feed ID. */
export class ThreadFeedHeadWriter {
  static async readStateInTx(
    tx: DatabaseTransaction,
    accountId: number,
    threadId: number,
  ) {
    const result = await tx.execute<MentionProjectionState>(sql`
      SELECT a.account,
        CASE WHEN t.type <> 'GROUP' THEN NULL
          WHEN t."authorityNamespaceId" = 0 THEN 0
          ELSE origin."peerAssignedLocalNamespaceId" END AS "selfMentionNamespaceId",
        s."unreadCount", s."previewSeqs", s."previewDeletedSeqs", s."lastReadSeq", s."lastMentionSeq", s."messageEndSeq",
        s."threadProfileRev", s."profileSourceId", s.blocked, t."clearedSeq", s."messageVisibleThroughSeq"
      FROM "AccountThreadState" s JOIN "Account" a ON a.id = s."accountId"
      JOIN "MessageThread" t ON t.id = s."threadId"
      LEFT JOIN "IdentityNamespace" origin ON origin.id = t."authorityNamespaceId"
      WHERE s."accountId" = ${accountId} AND s."threadId" = ${threadId}
      FOR NO KEY UPDATE OF s`);
    return result.rows[0];
  }

  /** Shared signed slot count. Tombs retain their original sender and sequence. */
  static async unreadDeltaInTx(
    tx: DatabaseTransaction,
    accountId: number,
    threadId: number,
    interval: ThreadUnreadInterval | null,
  ): Promise<number> {
    if (!interval) return 0;
    const result = await tx.execute<{ count: number }>(sql`
      SELECT thread_unread_count(s, t."clearedSeq", ${interval.afterSeq}, ${interval.throughSeq}) AS count
      FROM "AccountThreadState" s JOIN "MessageThread" t ON t.id = s."threadId"
      WHERE s."accountId" = ${accountId} AND s."threadId" = ${threadId}`);
    if (!result.rows[0]) throw new Error('Unread projection state disappeared');
    return interval.sign * result.rows[0].count;
  }

  /**
   * Extend the stored preview memory only with newly published eligible messages.
   * Read cursors do not own this projection: an ineligible message or mark-read
   * must not evict the last useful conversation preview.
   */
  static async previewSeqsInTx(
    tx: DatabaseTransaction,
    accountId: number,
    threadId: number,
    previous: MentionProjectionState,
    next: { messageEndSeq: number },
  ): Promise<number[]> {
    if (previous.blocked) return [];
    const lower = previous.clearedSeq ?? 0;
    const upper = Math.min(
      next.messageEndSeq,
      previous.messageVisibleThroughSeq ?? next.messageEndSeq,
    );
    if (lower >= upper) return [];
    const retained = previous.previewSeqs.filter(
      (seq) => seq > lower && seq <= upper,
    );
    if (next.messageEndSeq <= previous.messageEndSeq)
      return retained.slice(0, THREAD_PREVIEW_LIMIT);
    const result = await tx.execute<{ seq: number }>(sql`
      SELECT m.seq FROM "Message" m
      JOIN "AccountThreadState" s ON s."threadId" = m."threadId" AND s."accountId" = ${accountId}
      JOIN "MessageThread" t ON t.id = m."threadId"
      WHERE m."threadId" = ${threadId}
        AND m.seq > ${Math.max(previous.messageEndSeq, lower)} AND m.seq <= ${upper}
        AND attention_message_eligible(m, s, t."clearedSeq")
      ORDER BY m.seq DESC LIMIT ${THREAD_PREVIEW_LIMIT}`);
    return [...new Set([...result.rows.map((row) => row.seq), ...retained])]
      .sort((left, right) => right - left)
      .slice(0, THREAD_PREVIEW_LIMIT);
  }

  /** Resolve the next pointer without publishing separately from the heads/read. */
  static async resolveMentionInTx(
    tx: DatabaseTransaction,
    accountId: number,
    threadId: number,
    previous: MentionProjectionState,
    next: {
      lastReadSeq: number;
      messageEndSeq: number;
    },
  ): Promise<number | null> {
    if (previous.blocked) return null;
    let current = previous.lastMentionSeq;
    if (
      current !== null &&
      current <= Math.max(next.lastReadSeq, previous.clearedSeq ?? 0)
    )
      current = null;
    let rescan = next.lastReadSeq < previous.lastReadSeq;
    if (
      current !== null &&
      previous.messageVisibleThroughSeq !== null &&
      current > previous.messageVisibleThroughSeq
    ) {
      current = null;
      rescan = true;
    }
    if (current !== null) {
      const removed = await tx.execute(sql`
        SELECT 1 FROM "Message" WHERE "threadId" = ${threadId}
          AND seq = ${current} AND "isDeleted" = true LIMIT 1`);
      if (removed.rows.length > 0) {
        current = null;
        rescan = true;
      }
    }
    const after = rescan
      ? next.lastReadSeq
      : Math.max(next.lastReadSeq, previous.messageEndSeq);
    if (after >= next.messageEndSeq) return current;
    let through = next.messageEndSeq;
    for (;;) {
      const candidates = await tx.execute<{ seq: number; content: string }>(sql`
        SELECT m.seq, m.content::text AS content FROM "Message" m
        JOIN "AccountThreadState" s ON s."threadId" = m."threadId" AND s."accountId" = ${accountId}
        JOIN "MessageThread" t ON t.id = m."threadId"
        WHERE m."threadId" = ${threadId} AND m."contentType" = 'PURE_TEXT'
          AND NOT m."isDeleted" AND attention_message_eligible(m, s, t."clearedSeq")
          AND m.seq > ${after} AND m.seq <= ${through}
        ORDER BY m.seq DESC LIMIT 100`);
      const found = candidates.rows.find((row) =>
        mentionsAccount(row.content, {
          account: previous.account,
          namespaceId: previous.selfMentionNamespaceId,
        }),
      );
      if (found) return Math.max(current ?? 0, found.seq);
      if (candidates.rows.length < 100) return current;
      through = candidates.rows[candidates.rows.length - 1].seq - 1;
    }
  }

  /** Publish the end-anchored group profile revision to members whose stored
   * copy is behind. Blocked recipients stay stale; unblocking re-reads the head.
   * Caller holds the thread lock and runs this after the content-head writes;
   * the allocation trigger numbers each changed row for the thread feed. */
  static async advanceGroupProfileInTx(
    tx: DatabaseTransaction,
    input: {
      threadId: number;
      userIds: readonly number[];
      profileRev: number;
      profileSourceId: number | null;
    },
  ): Promise<number[]> {
    if (input.userIds.length === 0 || input.profileSourceId === null) return [];
    const changed = await tx.execute<{ accountId: number }>(sql`
      UPDATE "AccountThreadState" s
      SET "updatedAt" = CURRENT_TIMESTAMP,
        "threadProfileRev" = ${input.profileRev},
        "profileSourceId" = ${input.profileSourceId}
      FROM unnest(${sql.param([...input.userIds])}::integer[]) AS u(id)
      WHERE s."threadId" = ${input.threadId} AND s."accountId" = u.id
        AND s.blocked = false
        AND (s."profileSourceId" IS NULL OR s."profileSourceId" < ${input.profileSourceId})
        AND s."threadProfileRev" IS DISTINCT FROM ${input.profileRev}
      RETURNING s."accountId" AS "accountId"`);
    return changed.rows.map(({ accountId }) => accountId);
  }

  /** Publish the group profile revision from the canonical GROUP_PROFILE fact. No-op for P2P. */
  static async reconcileGroupProfileInTx(
    tx: DatabaseTransaction,
    input: { threadId: number; userIds: readonly number[] },
  ): Promise<number[]> {
    const result = await tx.execute<{
      profileRev: number;
      profileSourceId: number | null;
    }>(sql`
      SELECT meta."profileRev",
        fact."feedId" AS "profileSourceId"
      FROM "GroupMeta" meta
      LEFT JOIN "GroupMetaMemberFeed" fact ON fact."threadId" = meta."threadId"
        AND fact.operation = 'GROUP_PROFILE'
        AND fact.body -> 'profileRev' = to_jsonb(meta."profileRev")
      WHERE meta."threadId" = ${input.threadId} LIMIT 1`);
    const head = result.rows[0];
    if (!head) return [];
    if (head.profileRev > 0 && head.profileSourceId === null)
      throw new Error(
        'group profile reference has no matching GROUP_PROFILE item',
      );
    return this.advanceGroupProfileInTx(tx, {
      threadId: input.threadId,
      userIds: input.userIds,
      profileRev: head.profileRev,
      profileSourceId: head.profileSourceId,
    });
  }

  /** Caller holds the thread lock, checks authorization, and checkpoints in this transaction. */
  static async advanceInTx(
    tx: DatabaseTransaction,
    accountId: number,
    target: {
      threadId: number;
      messageEndSeq: number;
      profileRev?: number;
    },
  ): Promise<ThreadProjectionChange> {
    const unchanged = { unreadCountChanged: false, previewChanged: false };
    const state = await this.readStateInTx(tx, accountId, target.threadId);
    if (!state || state.blocked) return unchanged;
    const messageEndSeq = Math.max(state.messageEndSeq, target.messageEndSeq);
    const previewSeqs = await this.previewSeqsInTx(
      tx,
      accountId,
      target.threadId,
      state,
      {
        messageEndSeq,
      },
    );
    const previewDeletedRows =
      previewSeqs.length === 0
        ? []
        : (
            await tx.execute<{ seq: number }>(sql`
              SELECT seq FROM "Message"
              WHERE "threadId" = ${target.threadId}
                AND seq = ANY(${sql.param(previewSeqs)}::integer[])
                AND "isDeleted" = true
              ORDER BY seq ASC`)
          ).rows;
    const previewDeletedSeqs = previewDeletedRows.map((row) => row.seq);
    const previewSeqsChanged =
      previewSeqs.length !== state.previewSeqs.length ||
      previewSeqs.some((seq, index) => seq !== state.previewSeqs[index]);
    const previewDeletedChanged =
      previewDeletedSeqs.length !== state.previewDeletedSeqs.length ||
      previewDeletedSeqs.some(
        (seq, index) => seq !== state.previewDeletedSeqs[index],
      );
    const previewChanged = previewSeqsChanged || previewDeletedChanged;
    const mentionOutsideVisibility =
      state.lastMentionSeq !== null &&
      (state.lastMentionSeq <=
        Math.max(state.lastReadSeq, state.clearedSeq ?? 0) ||
        (state.messageVisibleThroughSeq !== null &&
          state.lastMentionSeq > state.messageVisibleThroughSeq));
    const lastMentionSeq = await this.resolveMentionInTx(
      tx,
      accountId,
      target.threadId,
      state,
      {
        lastReadSeq: state.lastReadSeq,
        messageEndSeq,
      },
    );
    if (
      !mentionOutsideVisibility &&
      !previewChanged &&
      messageEndSeq === state.messageEndSeq &&
      lastMentionSeq === state.lastMentionSeq
    )
      return unchanged;
    const unreadCount =
      state.unreadCount +
      (await this.unreadDeltaInTx(
        tx,
        accountId,
        target.threadId,
        messageAdvanceInterval(
          state.lastReadSeq,
          state.messageEndSeq,
          messageEndSeq,
        ),
      ));
    await tx.execute(sql`
      WITH selected_peer_profile AS (
        SELECT message.seq, message."profileRev"
        FROM "Message" message
        JOIN "Account" viewer ON viewer.id = ${accountId}
        WHERE message."threadId" = ${target.threadId}
          AND message.seq > ${Math.max(state.messageEndSeq, state.profileSourceId ?? 0)}
          AND message.seq <= ${target.messageEndSeq}
          AND message."creatorAccount" IS NOT NULL
          AND message."creatorAccount" <> '$system'
          AND NOT (message."creatorAccount" = viewer.account
            AND message."profileNamespaceId" = 0)
        ORDER BY message.seq DESC LIMIT 1
      )
      UPDATE "AccountThreadState" SET
        "updatedAt" = CURRENT_TIMESTAMP,
        "previewSeqs" = ${sql.param(previewSeqs)}::integer[],
        "previewDeletedSeqs" = ${sql.param(previewDeletedSeqs)}::integer[],
        "unreadCount" = ${unreadCount},
        "lastMentionSeq" = ${lastMentionSeq},
        "messageEndSeq" = GREATEST("AccountThreadState"."messageEndSeq", ${target.messageEndSeq}),
        "threadProfileRev" = CASE WHEN thread.type = 'P2P' THEN COALESCE((
            SELECT "profileRev" FROM selected_peer_profile
          ), "AccountThreadState"."threadProfileRev")
          ELSE "AccountThreadState"."threadProfileRev" END,
        "profileSourceId" = CASE WHEN thread.type = 'P2P'
          AND EXISTS (SELECT 1 FROM selected_peer_profile
            WHERE "profileRev" IS DISTINCT FROM ${state.threadProfileRev})
          THEN (SELECT seq FROM selected_peer_profile)
          ELSE "AccountThreadState"."profileSourceId" END
      FROM "MessageThread" thread
      WHERE "AccountThreadState"."accountId" = ${accountId}
        AND "AccountThreadState"."threadId" = ${target.threadId}
        AND thread.id = ${target.threadId}
        AND "AccountThreadState".blocked = false
        AND ("AccountThreadState"."messageEndSeq" < ${target.messageEndSeq}
          OR "AccountThreadState"."lastMentionSeq" IS DISTINCT FROM ${lastMentionSeq}::integer
          OR "AccountThreadState"."previewSeqs" IS DISTINCT FROM ${sql.param(previewSeqs)}::integer[]
          OR "AccountThreadState"."previewDeletedSeqs" IS DISTINCT FROM ${sql.param(previewDeletedSeqs)}::integer[])`);
    return {
      unreadCountChanged: unreadCount !== state.unreadCount,
      previewChanged,
    };
  }
}
