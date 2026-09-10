import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { parseMessageEntities } from '../common/message-entity.js';
import { parseTextMessageContent } from '../../shared/text-message-content.js';
import { threadPreviewLimit } from './thread-preview-limit.js';

export function mentionsAccount(content: string, account: string): boolean {
  const text = parseTextMessageContent(content)?.text ?? '';
  return parseMessageEntities(text).some(
    (entity) =>
      entity.kind === 'entity' &&
      ((entity.entityType === 'audience' && entity.entityId === 'all') ||
        (entity.entityType === 'user' &&
          entity.entityId.toLowerCase() === account.toLowerCase())),
  );
}

type MentionProjectionState = {
  account: string;
  unreadCount: number;
  previewSeqs: number[];
  lastReadSeq: number;
  lastMentionSeq: number | null;
  messageEndSeq: number;
  tombstoneEndSeq: number;
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
      SELECT a.account, s."unreadCount", s."previewSeqs", s."lastReadSeq", s."lastMentionSeq", s."messageEndSeq",
        s."tombstoneEndSeq", s.blocked, t."clearedSeq", s."messageVisibleThroughSeq"
      FROM "AccountThreadState" s JOIN "Account" a ON a.id = s."accountId"
      JOIN "MessageThread" t ON t.id = s."threadId"
      WHERE s."accountId" = ${accountId} AND s."threadId" = ${threadId}
      FOR UPDATE OF s`);
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

  /** Stored references retain tomb slots; ordinary reads only prune existing references. */
  static async previewSeqsInTx(
    tx: DatabaseTransaction,
    accountId: number,
    threadId: number,
    previous: MentionProjectionState,
    next: { lastReadSeq: number; messageEndSeq: number },
  ): Promise<number[]> {
    if (previous.blocked) return [];
    const lower = Math.max(next.lastReadSeq, previous.clearedSeq ?? 0);
    const upper = Math.min(
      next.messageEndSeq,
      previous.messageVisibleThroughSeq ?? next.messageEndSeq,
    );
    if (lower >= upper) return [];
    if (
      next.messageEndSeq <= previous.messageEndSeq &&
      next.lastReadSeq >= previous.lastReadSeq
    ) {
      return previous.previewSeqs
        .filter((seq) => seq > lower && seq <= upper)
        .slice(0, threadPreviewLimit());
    }
    const result = await tx.execute<{ seq: number }>(sql`
      SELECT m.seq FROM "Message" m
      JOIN "AccountThreadState" s ON s."threadId" = m."threadId" AND s."accountId" = ${accountId}
      JOIN "MessageThread" t ON t.id = m."threadId"
      WHERE m."threadId" = ${threadId} AND m.seq > ${lower} AND m.seq <= ${upper}
        AND attention_message_eligible(m, s, t."clearedSeq")
      ORDER BY m.seq DESC LIMIT ${threadPreviewLimit()}`);
    return result.rows.map((row) => row.seq);
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
      tombstoneEndSeq: number;
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
    if (current !== null && next.tombstoneEndSeq > previous.tombstoneEndSeq) {
      const removed = await tx.execute(sql`
        SELECT 1 FROM "DeletedMessage" WHERE "threadId" = ${threadId}
          AND "messageSeq" = ${current}
          AND "deletionSeq" > ${previous.tombstoneEndSeq}
          AND "deletionSeq" <= ${next.tombstoneEndSeq} LIMIT 1`);
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
        mentionsAccount(row.content, previous.account),
      );
      if (found) return Math.max(current ?? 0, found.seq);
      if (candidates.rows.length < 100) return current;
      through = candidates.rows[candidates.rows.length - 1].seq - 1;
    }
  }

  /** Caller holds the thread lock, checks authorization, and checkpoints in this transaction. */
  static async advanceInTx(
    tx: DatabaseTransaction,
    accountId: number,
    target: {
      threadId: number;
      messageEndSeq: number;
      tombstoneEndSeq: number;
    },
  ): Promise<ThreadProjectionChange> {
    const unchanged = { unreadCountChanged: false, previewChanged: false };
    const state = await this.readStateInTx(tx, accountId, target.threadId);
    if (!state || state.blocked) return unchanged;
    const messageEndSeq = Math.max(state.messageEndSeq, target.messageEndSeq);
    const tombstoneEndSeq = Math.max(
      state.tombstoneEndSeq,
      target.tombstoneEndSeq,
    );
    const mentionOutsideVisibility =
      state.lastMentionSeq !== null &&
      (state.lastMentionSeq <=
        Math.max(state.lastReadSeq, state.clearedSeq ?? 0) ||
        (state.messageVisibleThroughSeq !== null &&
          state.lastMentionSeq > state.messageVisibleThroughSeq));
    if (
      !mentionOutsideVisibility &&
      !state.previewSeqs.some(
        (seq) =>
          seq <= Math.max(state.lastReadSeq, state.clearedSeq ?? 0) ||
          (state.messageVisibleThroughSeq !== null &&
            seq > state.messageVisibleThroughSeq),
      ) &&
      messageEndSeq === state.messageEndSeq &&
      tombstoneEndSeq === state.tombstoneEndSeq
    )
      return unchanged;
    const lastMentionSeq = await this.resolveMentionInTx(
      tx,
      accountId,
      target.threadId,
      state,
      {
        lastReadSeq: state.lastReadSeq,
        messageEndSeq,
        tombstoneEndSeq,
      },
    );
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
    const previewSeqs = await this.previewSeqsInTx(
      tx,
      accountId,
      target.threadId,
      state,
      {
        lastReadSeq: state.lastReadSeq,
        messageEndSeq,
      },
    );
    let previewChanged =
      previewSeqs.length !== state.previewSeqs.length ||
      previewSeqs.some((seq, index) => seq !== state.previewSeqs[index]);
    // References survive deletion, but their rendered status changes.
    if (
      !previewChanged &&
      previewSeqs.length &&
      tombstoneEndSeq > state.tombstoneEndSeq
    ) {
      const deleted = await tx.execute(sql`
        SELECT 1 FROM "DeletedMessage"
        WHERE "threadId" = ${target.threadId}
          AND "messageSeq" = ANY(${sql.param(previewSeqs)}::integer[])
          AND "deletionSeq" > ${state.tombstoneEndSeq}
          AND "deletionSeq" <= ${tombstoneEndSeq} LIMIT 1`);
      previewChanged = deleted.rows.length > 0;
    }
    await tx.execute(sql`
      UPDATE "AccountThreadState" SET
        "previewSeqs" = ${sql.param(previewSeqs)}::integer[],
        "unreadCount" = ${unreadCount},
        "lastMentionSeq" = ${lastMentionSeq},
        "messageEndSeq" = GREATEST("messageEndSeq", ${target.messageEndSeq}),
        "tombstoneEndSeq" = GREATEST("tombstoneEndSeq", ${target.tombstoneEndSeq})
      WHERE "accountId" = ${accountId} AND "threadId" = ${target.threadId}
        AND blocked = false
        AND ("messageEndSeq" < ${target.messageEndSeq}
          OR "tombstoneEndSeq" < ${target.tombstoneEndSeq}
          OR "lastMentionSeq" IS DISTINCT FROM ${lastMentionSeq}::integer
          OR "previewSeqs" IS DISTINCT FROM ${sql.param(previewSeqs)}::integer[])`);
    return {
      unreadCountChanged: unreadCount !== state.unreadCount,
      previewChanged,
    };
  }
}
