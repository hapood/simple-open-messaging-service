import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { ThreadFeedHeadWriter } from './thread-feed-head.writer.js';

describe('mention projection in the shared head writer', () => {
  afterEach(() => vi.restoreAllMocks());
  const state = {
    account: 'reader',
    unreadCount: 0,
    previewSeqs: [],
    lastReadSeq: 0,
    lastMentionSeq: 3,
    messageEndSeq: 5,
    tombstoneEndSeq: 0,
    threadProfileRev: 0,
    profileSourceId: null,
    blocked: false,
    clearedSeq: null,
    messageVisibleThroughSeq: null,
  };
  const next = { lastReadSeq: 0, messageEndSeq: 8, tombstoneEndSeq: 0 };
  const mention = (seq: number) => ({
    seq,
    content: '{"text":"[@Reader](somfp://user/0/reader)"}',
  });

  it('scans the added message interval and chooses the latest semantic mention', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [{ seq: 8, content: '{"text":"plain"}' }, mention(7), mention(6)],
    });
    expect(
      await ThreadFeedHeadWriter.resolveMentionInTx(
        { execute } as never,
        1,
        2,
        state,
        next,
      ),
    ).toBe(7);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rescans after a tomb interval hits the current mention', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [mention(2), mention(1)] });
    expect(
      await ThreadFeedHeadWriter.resolveMentionInTx(
        { execute } as never,
        1,
        2,
        state,
        { ...next, messageEndSeq: 5, tombstoneEndSeq: 1 },
      ),
    ).toBe(2);
  });

  it('does not rescan old history for unrelated tombs', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    expect(
      await ThreadFeedHeadWriter.resolveMentionInTx(
        { execute } as never,
        1,
        2,
        state,
        { ...next, messageEndSeq: 5, tombstoneEndSeq: 1 },
      ),
    ).toBe(3);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('clears read mentions without a history query', async () => {
    const execute = vi.fn();
    expect(
      await ThreadFeedHeadWriter.resolveMentionInTx(
        { execute } as never,
        1,
        2,
        state,
        { ...next, lastReadSeq: 3, messageEndSeq: 5 },
      ),
    ).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('finds mentions exposed by a forced backwards read', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [mention(3)] });
    expect(
      await ThreadFeedHeadWriter.resolveMentionInTx(
        { execute } as never,
        1,
        2,
        { ...state, lastReadSeq: 4, lastMentionSeq: null },
        { ...next, messageEndSeq: 5 },
      ),
    ).toBe(3);
  });

  it('clears mentions covered by history clearing without scanning', async () => {
    const execute = vi.fn();
    expect(
      await ThreadFeedHeadWriter.resolveMentionInTx(
        { execute } as never,
        1,
        2,
        { ...state, clearedSeq: 3 },
        { ...next, messageEndSeq: 5 },
      ),
    ).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rescans when the latest mention is outside the visible upper boundary', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [mention(2)] });
    expect(
      await ThreadFeedHeadWriter.resolveMentionInTx(
        { execute } as never,
        1,
        2,
        { ...state, messageVisibleThroughSeq: 2 },
        { ...next, messageEndSeq: 5 },
      ),
    ).toBe(2);
  });

  it('takes the latest counterpart message revision for P2P without changing group revisions on content fanout', async () => {
    vi.spyOn(ThreadFeedHeadWriter, 'readStateInTx').mockResolvedValue({
      ...state,
      lastMentionSeq: null,
    });
    vi.spyOn(ThreadFeedHeadWriter, 'resolveMentionInTx').mockResolvedValue(
      null,
    );
    vi.spyOn(ThreadFeedHeadWriter, 'unreadDeltaInTx').mockResolvedValue(0);
    vi.spyOn(ThreadFeedHeadWriter, 'previewSeqsInTx').mockResolvedValue([]);
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    await ThreadFeedHeadWriter.advanceInTx({ execute } as never, 1, {
      threadId: 2,
      messageEndSeq: 6,
      tombstoneEndSeq: 0,
      profileRev: 100,
    });
    const update = new PgDialect().sqlToQuery(execute.mock.lastCall![0] as SQL);
    expect(update.sql).toContain("CASE WHEN thread.type = 'P2P'");
    expect(update.sql).toContain('WITH selected_peer_profile AS');
    expect(update.sql).toContain(
      'SELECT "profileRev" FROM selected_peer_profile',
    );
    expect(update.sql).toContain('SELECT seq FROM selected_peer_profile');
    expect(update.sql).toContain(
      '"profileSourceId" = CASE WHEN thread.type = \'P2P\'',
    );
    expect(update.sql).toContain('"profileRev" IS DISTINCT FROM');
    expect(update.sql).toContain('message."creatorAccount" = viewer.account');
    expect(update.sql).toContain('message."profileNamespaceId" = 0');
    expect(update.sql).toContain('ORDER BY message.seq DESC LIMIT 1');
    expect(update.sql).not.toContain('meta_head."profileRev"');
    expect(update.params).not.toContain(100);
  });

  it('does not replace a profile selected by a newer message coordinate', async () => {
    vi.spyOn(ThreadFeedHeadWriter, 'readStateInTx').mockResolvedValue({
      ...state,
      lastMentionSeq: null,
      profileSourceId: 10,
    });
    vi.spyOn(ThreadFeedHeadWriter, 'resolveMentionInTx').mockResolvedValue(
      null,
    );
    vi.spyOn(ThreadFeedHeadWriter, 'unreadDeltaInTx').mockResolvedValue(0);
    vi.spyOn(ThreadFeedHeadWriter, 'previewSeqsInTx').mockResolvedValue([]);
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    await ThreadFeedHeadWriter.advanceInTx({ execute } as never, 1, {
      threadId: 2,
      messageEndSeq: 8,
      tombstoneEndSeq: 0,
    });
    const update = new PgDialect().sqlToQuery(execute.mock.lastCall![0] as SQL);
    expect(update.sql).toContain('message.seq > $');
    expect(update.params).toContain(10);
    expect(update.sql).toContain('SELECT seq FROM selected_peer_profile');
  });

  it('compares GROUP_PROFILE feed IDs before revisions and does not rebase on the source ID alone', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    await ThreadFeedHeadWriter.advanceGroupMetaCoordinatesInTx(
      { execute } as never,
      {
        threadId: 2,
        userIds: [1],
        groupMetaFeedEndId: 7,
        profileRev: 3,
        profileSourceId: 5,
      },
    );
    const update = new PgDialect().sqlToQuery(execute.mock.lastCall![0] as SQL);
    expect(update.sql).toContain('s."profileSourceId" IS NULL');
    expect(update.sql).toContain('s."profileSourceId" <');
    expect(update.sql).toContain('s."threadProfileRev" IS DISTINCT FROM');
    expect(update.sql).toContain('"profileSourceId" = CASE');
    expect(update.sql).toContain('"groupMetaFeedEndId" = GREATEST');
  });

  it('skips duplicate fanout heads entirely', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [state] });
    await ThreadFeedHeadWriter.advanceInTx({ execute } as never, 1, {
      threadId: 2,
      messageEndSeq: 5,
      tombstoneEndSeq: 0,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('skips duplicate heads with a preview older than the read cursor', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        { ...state, lastReadSeq: 5, lastMentionSeq: null, previewSeqs: [3] },
      ],
    });
    await ThreadFeedHeadWriter.advanceInTx({ execute } as never, 1, {
      threadId: 2,
      messageEndSeq: 5,
      tombstoneEndSeq: 0,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    { delta: 0, previews: [5], tomb: false, expected: [false, false] },
    { delta: 1, previews: [5], tomb: false, expected: [true, false] },
    { delta: 0, previews: [6], tomb: false, expected: [false, true] },
    { delta: 0, previews: [5], tomb: true, expected: [false, true] },
    { delta: 0, previews: [], tomb: false, expected: [false, true] },
  ])(
    'reports notification changes from locked projection state: %j',
    async ({ delta, previews, tomb, expected }) => {
      vi.spyOn(ThreadFeedHeadWriter, 'readStateInTx').mockResolvedValue({
        ...state,
        previewSeqs: [5],
      });
      vi.spyOn(ThreadFeedHeadWriter, 'resolveMentionInTx').mockResolvedValue(
        null,
      );
      vi.spyOn(ThreadFeedHeadWriter, 'unreadDeltaInTx').mockResolvedValue(
        delta,
      );
      vi.spyOn(ThreadFeedHeadWriter, 'previewSeqsInTx').mockResolvedValue(
        previews,
      );
      const execute = vi.fn().mockResolvedValue({ rows: tomb ? [{}] : [] });
      expect(
        await ThreadFeedHeadWriter.advanceInTx({ execute } as never, 1, {
          threadId: 2,
          messageEndSeq: 6,
          tombstoneEndSeq: 1,
        }),
      ).toEqual({
        unreadCountChanged: expected[0],
        previewChanged: expected[1],
      });
    },
  );
});
