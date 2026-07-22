import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationQueryService } from './notification-query.service.js';

/**
 * buildSummary (POST /notifications/missed-summary) + buildNotifyResponse (POST /notifications/missed), the
 * two separated endpoints. This spec pins:
 *  - buildSummary: the `(from, to]` double-boundary walk — threads with latest-id in range, ASC, nextCursor =
 *    page max; `to ≤ from` (stale SSE) → empty no-op; `from` absent (first boot) → all active ≤ to.
 *  - buildNotifyResponse: per-sender aggregation since the HWM → ONE descriptor; "999+" past the 1000-sample;
 *    `since` absent / nothing new → a `clear` descriptor.
 *  - the BigInt id NEVER appears in `items` (attachMediaStatus is the strip point — mocked passthrough).
 *
 * DB-touching methods are mocked; this spec owns the orchestration invariants.
 */
describe('NotificationQueryService', () => {
  let svc: NotificationQueryService;
  let participants: ReturnType<typeof vi.fn>;
  let countUnread: ReturnType<typeof vi.fn>;
  let findMsgs: ReturnType<typeof vi.fn>;
  let attachMedia: ReturnType<typeof vi.fn>;
  let senderCountsSince: ReturnType<typeof vi.fn>;
  let threadAwayBuckets: ReturnType<typeof vi.fn>;
  let threadCountSinceBound: ReturnType<typeof vi.fn>;
  let findNewest: ReturnType<typeof vi.fn>;
  let findPeers: ReturnType<typeof vi.fn>;
  let queryUsers: ReturnType<typeof vi.fn>;
  let resolveGroups: ReturnType<typeof vi.fn>;
  let composeStack: ReturnType<typeof vi.fn>;
  let blockedByMe: ReturnType<typeof vi.fn>;

  /** A participant row shape (the subset the service reads). */
  function row(
    threadId: number,
    type: 'P2P' | 'GROUP',
    opts: { lastMessageSeq?: number | null; muted?: boolean } = {},
  ) {
    return {
      threadId,
      muted: opts.muted ?? false,
      thread: { type, lastMessageSeq: opts.lastMessageSeq ?? null, lastMessageAt: null },
    };
  }

  beforeEach(() => {
    participants = vi.fn();
    countUnread = vi.fn();
    findMsgs = vi.fn();
    attachMedia = vi.fn();
    senderCountsSince = vi.fn();
    threadAwayBuckets = vi.fn();
    threadCountSinceBound = vi.fn();
    findNewest = vi.fn();
    findPeers = vi.fn();
    queryUsers = vi.fn();
    resolveGroups = vi.fn();
    composeStack = vi.fn().mockResolvedValue('/uploads/notif-icons/abc.png');
    blockedByMe = vi.fn().mockResolvedValue(new Set<number>());
    svc = new NotificationQueryService(
      { queryParticipants: participants, findP2PPeers: findPeers } as never,
      { countUnreadByThread: countUnread, findMessagesBySeqPairs: findMsgs, attachMediaStatus: attachMedia, senderCountsSince, threadAwayBuckets, threadCountSinceBound, findNewestForUser: findNewest } as never,
      { queryUsers } as never,
      { resolveGroupUsersByThreadIds: resolveGroups } as never,
      { blockedByMe } as never,
      { composeStackedAvatar: composeStack } as never,
    );
  });

  /** Wire the per-thread mocks. `bodies` carries the LATEST message per thread WITH its internal id. */
  function wire(
    threads: ReturnType<typeof row>[],
    unread: Record<number, number>,
    bodies: Record<number, { seq: number; content: string; contentType: string; id: number; creator?: number }>,
    peers: Array<{ threadId: number; userId: number }> = [],
    users: Array<{ id: number; name: string; avatar: string }> = [],
  ) {
    participants.mockResolvedValue(threads);
    countUnread.mockResolvedValue(new Map(Object.entries(unread).map(([k, v]) => [Number(k), v])));
    findPeers.mockResolvedValue(peers);
    queryUsers.mockResolvedValue(users);
    resolveGroups.mockResolvedValue(new Map());
    const byPair = new Map(
      Object.entries(bodies).map(([tid, b]) => [
        `${tid}:${b.seq}`,
        { threadId: Number(tid), seq: b.seq, content: b.content, contentType: b.contentType, creator: b.creator ?? 1, createdAt: new Date(100), id: BigInt(b.id) },
      ]),
    );
    // findMessagesBySeqPairs serves BOTH the cursor (from/to) resolution AND the per-thread latest fetch.
    findMsgs.mockImplementation((pairs: Array<{ threadId: number; seq: number }>) =>
      pairs.map((p) => byPair.get(`${p.threadId}:${p.seq}`)).filter(Boolean),
    );
    attachMedia.mockImplementation((ms: Array<{ id: bigint; seq: number }>) =>
      ms.map(({ id: _drop, ...rest }) => ({ ...rest, mediaStatus: 'ready' as const, sv: rest.seq })),
    );
  }

  // ── buildSummary: the (from, to] double-boundary walk ─────────────────────────────────────────

  it('buildSummary: threads whose latest-id ∈ (from, to], ASC; nextCursor = page max-id', async () => {
    wire(
      [row(1, 'P2P', { lastMessageSeq: 1 }), row(2, 'P2P', { lastMessageSeq: 1 }), row(3, 'P2P', { lastMessageSeq: 1 })],
      { 1: 0, 2: 0, 3: 0 },
      { 1: { seq: 1, content: 'a', contentType: 'PURE_TEXT', id: 10 },
        2: { seq: 1, content: 'b', contentType: 'PURE_TEXT', id: 20 },
        3: { seq: 1, content: 'c', contentType: 'PURE_TEXT', id: 30 } },
    );
    // from = thread 1 (id 10), to = thread 3 (id 30) → range (10,30] = threads 2 + 3.
    const res = await svc.buildSummary(1, { from: { threadId: 1, seq: 1 }, to: { threadId: 3, seq: 1 }, take: 50 });
    expect(res.items.map((i) => i.threadId)).toEqual([2, 3]); // ASC by id 20,30
    expect(res.hasMore).toBe(false);
    expect(res.nextCursor).toBeNull(); // all fit → no continuation
  });

  it('buildSummary: paginates — nextCursor = page max-id when hasMore', async () => {
    wire(
      [row(1, 'P2P', { lastMessageSeq: 1 }), row(2, 'P2P', { lastMessageSeq: 1 }), row(3, 'P2P', { lastMessageSeq: 1 })],
      { 1: 0, 2: 0, 3: 0 },
      { 1: { seq: 1, content: 'a', contentType: 'PURE_TEXT', id: 10 },
        2: { seq: 1, content: 'b', contentType: 'PURE_TEXT', id: 20 },
        3: { seq: 1, content: 'c', contentType: 'PURE_TEXT', id: 30 } },
    );
    // from absent (first boot), to = thread 3 (id 30), take 2 → ASC oldest-first in (-∞,30] = threads 1,2.
    const res = await svc.buildSummary(1, { to: { threadId: 3, seq: 1 }, take: 2 });
    expect(res.items.map((i) => i.threadId)).toEqual([1, 2]); // ids 10,20 (the walk advances `from` toward `to`)
    expect(res.hasMore).toBe(true);
    expect(res.nextCursor).toEqual({ threadId: 2, seq: 1 }); // page max-id → the next `from`
  });

  it('buildSummary: to ≤ from (stale SSE) → empty no-op', async () => {
    wire(
      [row(1, 'P2P', { lastMessageSeq: 1 }), row(2, 'P2P', { lastMessageSeq: 1 })],
      { 1: 0, 2: 0 },
      { 1: { seq: 1, content: 'a', contentType: 'PURE_TEXT', id: 10 },
        2: { seq: 1, content: 'b', contentType: 'PURE_TEXT', id: 20 } },
    );
    // from = thread 2 (id 20), to = thread 1 (id 10) → to ≤ from → no-op.
    const res = await svc.buildSummary(1, { from: { threadId: 2, seq: 1 }, to: { threadId: 1, seq: 1 }, take: 50 });
    expect(res.items).toEqual([]);
    expect(res.hasMore).toBe(false);
  });

  it('buildSummary: from absent (first boot) → every active thread with latest ≤ to', async () => {
    wire(
      [row(1, 'P2P', { lastMessageSeq: 1 }), row(2, 'P2P', { lastMessageSeq: 1 })],
      { 1: 0, 2: 0 },
      { 1: { seq: 1, content: 'a', contentType: 'PURE_TEXT', id: 10 },
        2: { seq: 1, content: 'b', contentType: 'PURE_TEXT', id: 20 } },
    );
    const res = await svc.buildSummary(1, { to: { threadId: 2, seq: 1 }, take: 50 });
    expect(res.items.map((i) => i.threadId)).toEqual([1, 2]);
  });

  it('buildSummary never exposes the BigInt id', async () => {
    wire(
      [row(1, 'P2P', { lastMessageSeq: 1 })],
      { 1: 0 },
      { 1: { seq: 1, content: 'x', contentType: 'PURE_TEXT', id: 999 } },
    );
    const res = await svc.buildSummary(1, { to: { threadId: 1, seq: 1 }, take: 50 });
    expect(JSON.stringify(res.items)).not.toContain('"id"');
    expect(res.items[0].latestMessage).not.toHaveProperty('id');
  });

  // ── buildNotifyResponse: per-sender aggregation since the HWM ────────────────────────────────

  function wireAway(opts: {
    counts?: Map<number, number>;
    overflow?: boolean;
    blocked?: number[];
    senders?: Array<{ id: number; name: string; avatar: string }>;
    /** The new HWM target the descriptor's `data` carries (the global newest covered message). */
    newest?: { threadId: number; seq: number; ts: number } | null;
  }) {
    participants.mockResolvedValue([]);
    // resolveId(since) → findMessagesBySeqPairs([since]) resolves the cursor to a valid id (100).
    findMsgs.mockResolvedValue([{ threadId: 1, seq: 5, id: 100n }]);
    blockedByMe.mockResolvedValue(new Set(opts.blocked ?? []));
    senderCountsSince.mockResolvedValue({
      counts: opts.counts ?? new Map<number, number>(),
      overflow: opts.overflow ?? false,
    });
    queryUsers.mockResolvedValue(opts.senders ?? []);
    // findNewestForUser → the new HWM cursor the dismiss action advances to (default deterministic).
    findNewest.mockResolvedValue(opts.newest === undefined ? { threadId: 2, seq: 9, ts: 0 } : opts.newest);
  }

  it('buildNotifyResponse: since absent (first-ever) → clear descriptor', async () => {
    wireAway({});
    const res = await svc.buildNotifyResponse(1, { acceptLanguage: 'en' });
    expect(res.notifications).toHaveLength(1);
    expect(res.notifications[0].kind).toBe('clear');
  });

  it('buildNotifyResponse: nothing new since HWM → clear', async () => {
    wireAway({ counts: new Map() });
    const res = await svc.buildNotifyResponse(1, { since: { threadId: 1, seq: 5 }, acceptLanguage: 'en' });
    expect(res.notifications[0].kind).toBe('clear');
  });

  it('buildNotifyResponse: folds senders + total count into the body + feeds the icon', async () => {
    wireAway({
      counts: new Map([[11, 2], [22, 3]]),
      senders: [{ id: 11, name: 'Alice', avatar: '/a.webp' }, { id: 22, name: 'Bob', avatar: '/b.webp' }],
    });
    const res = await svc.buildNotifyResponse(1, { since: { threadId: 1, seq: 5 }, acceptLanguage: 'en' });
    const d = res.notifications[0];
    expect(d.kind).toBe('message-summary');
    expect(d.body).toBe('Alice, Bob sent you 5 messages');
    expect(d.icon).toBe('/uploads/notif-icons/abc.png');
    // The `dismiss` action is pure frontend — `data` carries the new HWM target (the global newest covered
    // message), which the client advances its away-HWM to on dismiss (no POST, no read-watermark change).
    expect(d.data).toEqual({ threadId: 2, seq: 9 });
    expect(composeStack).toHaveBeenCalledWith([
      { avatarUrl: '/a.webp', displayName: 'Alice', userId: 11 },
      { avatarUrl: '/b.webp', displayName: 'Bob', userId: 22 },
    ]);
  });

  it('buildNotifyResponse: overflow (≥1000 sampled) → "999+" capped body', async () => {
    wireAway({
      counts: new Map([[11, 1000]]),
      overflow: true,
      senders: [{ id: 11, name: 'Alice', avatar: '' }],
    });
    const res = await svc.buildNotifyResponse(1, { since: { threadId: 1, seq: 5 }, acceptLanguage: 'zh-CN' });
    expect(res.notifications[0].body).toBe('Alice 给你发了 999+ 条消息');
  });

  // ── buildNotifyResponse: "thread" grouping (one notification CARD per conversation) ───────────

  it('grouping:thread → one descriptor per new conversation, newest first; kind:thread-message', async () => {
    blockedByMe.mockResolvedValue(new Set<number>());
    threadAwayBuckets.mockResolvedValue(
      new Map([[1, { count: 2, latestSeq: 7 }], [2, { count: 1, latestSeq: 8 }], [3, { count: 5, latestSeq: 9 }]]),
    );
    wire(
      [row(1, 'P2P', { lastMessageSeq: 7 }), row(2, 'P2P', { lastMessageSeq: 8 }), row(3, 'P2P', { lastMessageSeq: 9 })],
      { 1: 2, 2: 1, 3: 5 },
      {
        1: { seq: 7, content: 'a', contentType: 'PURE_TEXT', id: 10 },
        2: { seq: 8, content: 'b', contentType: 'PURE_TEXT', id: 20 },
        3: { seq: 9, content: 'c', contentType: 'PURE_TEXT', id: 30 },
        99: { seq: 1, content: 'cursor', contentType: 'PURE_TEXT', id: 5 },
      },
      [{ threadId: 1, userId: 11 }, { threadId: 2, userId: 22 }, { threadId: 3, userId: 33 }],
      [{ id: 11, name: 'Alice', avatar: '' }, { id: 22, name: 'Bob', avatar: '' }, { id: 33, name: 'Carol', avatar: '' }],
    );
    const res = await svc.buildNotifyResponse(1, { since: { threadId: 99, seq: 1 }, grouping: 'thread', acceptLanguage: 'en' });
    expect(res.notifications).toHaveLength(3);
    // newest conversation (highest latest-id) first: thread 3 (30) → 2 (20) → 1 (10).
    expect(res.notifications.map((d) => d.tag)).toEqual(['soms-thread-3', 'soms-thread-2', 'soms-thread-1']);
    const carol = res.notifications[0];
    expect(carol.kind).toBe('thread-message');
    expect(carol.body).toBe('Carol sent you 5 messages'); // single-sender all-mode template
    expect(carol.icon).toBeNull(); // no per-thread avatar composition
    expect(carol.data).toEqual({ threadId: 3, seq: 9 }); // dismiss target = latest seq (from Query A)
    expect(res.notifications[1].body).toBe('Bob sent you a message'); // count 1 → the "one" template
  });

  it('grouping:thread → nothing new → empty list (client clears all soms-thread-*)', async () => {
    blockedByMe.mockResolvedValue(new Set<number>());
    threadAwayBuckets.mockResolvedValue(new Map());
    wire(
      [row(1, 'P2P', { lastMessageSeq: 1 })],
      { 1: 0 },
      {
        1: { seq: 1, content: 'old', contentType: 'PURE_TEXT', id: 10 },
        99: { seq: 1, content: 'cursor', contentType: 'PURE_TEXT', id: 100 },
      },
      [{ threadId: 1, userId: 11 }],
      [{ id: 11, name: 'Alice', avatar: '' }],
    );
    const res = await svc.buildNotifyResponse(1, { since: { threadId: 99, seq: 1 }, grouping: 'thread', acceptLanguage: 'en' });
    expect(res.notifications).toEqual([]); // NOT a clear descriptor — empty list; the client clears all soms-thread-*
  });

  it('grouping:thread → count ≥1000 → "999+" body', async () => {
    blockedByMe.mockResolvedValue(new Set<number>());
    threadAwayBuckets.mockResolvedValue(new Map([[1, { count: 1000, latestSeq: 1000 }]]));
    wire(
      [row(1, 'P2P', { lastMessageSeq: 1000 })],
      { 1: 1000 },
      {
        1: { seq: 1000, content: 'x', contentType: 'PURE_TEXT', id: 10 },
        99: { seq: 1, content: 'cursor', contentType: 'PURE_TEXT', id: 5 },
      },
      [{ threadId: 1, userId: 11 }],
      [{ id: 11, name: 'Alice', avatar: '' }],
    );
    const res = await svc.buildNotifyResponse(1, { since: { threadId: 99, seq: 1 }, grouping: 'thread', acceptLanguage: 'en' });
    expect(res.notifications[0].body).toBe('Alice sent you 999+ messages');
  });

  it('grouping:thread → threadHwms (dismissed) overrides the count via Query B; a 0-count dismissed thread is dropped', async () => {
    blockedByMe.mockResolvedValue(new Set<number>());
    // Query A: 3 threads new since globalHWM (1: 5, 2: 3, 3: 4).
    threadAwayBuckets.mockResolvedValue(
      new Map([[1, { count: 5, latestSeq: 9 }], [2, { count: 3, latestSeq: 8 }], [3, { count: 4, latestSeq: 11 }]]),
    );
    // Query B (only for dismissed threads 1 + 3): thread 1 → 2 new since dismiss; thread 3 → 0 (dropped).
    threadCountSinceBound.mockImplementation((_u, _s, tid) => Promise.resolve(tid === 1 ? 2 : 0));
    wire(
      [row(1, 'P2P', { lastMessageSeq: 9 }), row(2, 'P2P', { lastMessageSeq: 8 }), row(3, 'P2P', { lastMessageSeq: 11 })],
      { 1: 5, 2: 3, 3: 4 },
      {
        1: { seq: 9, content: 'a', contentType: 'PURE_TEXT', id: 10 },
        2: { seq: 8, content: 'b', contentType: 'PURE_TEXT', id: 20 },
        3: { seq: 11, content: 'c', contentType: 'PURE_TEXT', id: 30 },
        99: { seq: 1, content: 'cursor', contentType: 'PURE_TEXT', id: 5 },
      },
      [{ threadId: 1, userId: 11 }, { threadId: 2, userId: 22 }, { threadId: 3, userId: 33 }],
      [{ id: 11, name: 'Alice', avatar: '' }, { id: 22, name: 'Bob', avatar: '' }, { id: 33, name: 'Carol', avatar: '' }],
    );
    const res = await svc.buildNotifyResponse(1, {
      since: { threadId: 99, seq: 1 },
      grouping: 'thread',
      threadHwms: { 1: 7, 3: 10 },
      acceptLanguage: 'en',
    });
    const byThread = new Map(res.notifications.map((d) => [d.data.threadId, d]));
    expect(res.notifications).toHaveLength(2); // thread 3 dropped (dismissed, 0 new)
    expect(byThread.get(1)?.body).toBe('Alice sent you 2 messages'); // Query B (since dismiss seq 7)
    expect(byThread.get(2)?.body).toBe('Bob sent you 3 messages'); // not dismissed → Query A count
    expect(byThread.has(3)).toBe(false); // dismissed with 0 new → dropped
  });
});
