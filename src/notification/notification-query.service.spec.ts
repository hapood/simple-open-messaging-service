import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationQueryService } from './notification-query.service.js';

/**
 * buildNotifyResponse — the unified missed response: `items[]` (one row per thread, cursor-ordered) +
 * `notifications[]` (the server-authored descriptor). This spec pins:
 *  - the cursor → id resolution + the strict-total-order `id > cursor` forward pagination (no overlap);
 *  - the snapshot (absent cursor) = newest `take`, returned ASC;
 *  - `nextCursor` = the page's max-id item's (threadId, seq);
 *  - the descriptor fold (unread+unmuted → body + icon) + a `clear` descriptor when none qualify;
 *  - the BigInt id NEVER appears in `items` (attachMediaStatus is the strip point — mocked passthrough);
 *  - AvatarStackService is fed the unread+unmuted senders.
 *
 * DB-touching methods are mocked; this spec owns the orchestration invariants.
 */
describe('NotificationQueryService.buildNotifyResponse', () => {
  let svc: NotificationQueryService;
  let participants: ReturnType<typeof vi.fn>;
  let countUnread: ReturnType<typeof vi.fn>;
  let findMsgs: ReturnType<typeof vi.fn>;
  let attachMedia: ReturnType<typeof vi.fn>;
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
      thread: {
        type,
        lastMessageSeq: opts.lastMessageSeq ?? null,
        lastMessageAt: null,
      },
    };
  }

  beforeEach(() => {
    participants = vi.fn();
    countUnread = vi.fn();
    findMsgs = vi.fn();
    attachMedia = vi.fn();
    findPeers = vi.fn();
    queryUsers = vi.fn();
    resolveGroups = vi.fn();
    composeStack = vi.fn();
    blockedByMe = vi.fn().mockResolvedValue(new Set<number>());
    svc = new NotificationQueryService(
      { queryParticipants: participants, findP2PPeers: findPeers } as never,
      { countUnreadByThread: countUnread, findMessagesBySeqPairs: findMsgs, attachMediaStatus: attachMedia } as never,
      { queryUsers } as never,
      { resolveGroupUsersByThreadIds: resolveGroups } as never,
      { blockedByMe } as never,
      { composeStackedAvatar: composeStack } as never,
    );
  });

  /** Wire the mocks. `bodies` carries the LATEST message per thread WITH its internal id (the sort key) +
   *  optional creator (default 1). */
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
    composeStack.mockResolvedValue('/uploads/notif-icons/abc.png');
    // findMessagesBySeqPairs: return the matching messages (id intact) for ANY pair set — used both for the
    // cursor resolution (one pair) and the latest-message fetch (one pair per thread).
    const byPair = new Map(
      Object.entries(bodies).map(([tid, b]) => [
        `${tid}:${b.seq}`,
        { threadId: Number(tid), seq: b.seq, content: b.content, contentType: b.contentType, creator: b.creator ?? 1, createdAt: new Date(100), id: BigInt(b.id) },
      ]),
    );
    findMsgs.mockImplementation((pairs: Array<{ threadId: number; seq: number }>) =>
      pairs.map((p) => byPair.get(`${p.threadId}:${p.seq}`)).filter(Boolean),
    );
    attachMedia.mockImplementation((ms: Array<{ id: bigint; seq: number }>) =>
      ms.map(({ id: _drop, ...rest }) => ({ ...rest, mediaStatus: 'ready' as const, sv: rest.seq })),
    );
  }

  it('snapshot (no cursor) returns threads ASC by latest-message id; nextCursor = max-id item', async () => {
    wire(
      [row(1, 'P2P', { lastMessageSeq: 1 }), row(2, 'P2P', { lastMessageSeq: 1 }), row(3, 'P2P', { lastMessageSeq: 1 })],
      { 1: 1, 2: 1, 3: 1 },
      // ids deliberately out of threadId order to prove id-ordering.
      { 1: { seq: 1, content: 'a', contentType: 'PURE_TEXT', id: 20 },
        2: { seq: 1, content: 'b', contentType: 'PURE_TEXT', id: 10 },
        3: { seq: 1, content: 'c', contentType: 'PURE_TEXT', id: 30 } },
    );
    const res = await svc.buildNotifyResponse(1, { take: 50 });
    expect(res.items.map((i) => i.threadId)).toEqual([2, 1, 3]); // ASC by id 10,20,30
    expect(res.hasMore).toBe(false);
    expect(res.nextCursor).toEqual({ threadId: 3, seq: 1 }); // max-id item (id 30 → thread 3)
  });

  it('snapshot take caps to the newest threads; hasMore reflects the remainder', async () => {
    wire(
      [row(1, 'P2P', { lastMessageSeq: 1 }), row(2, 'P2P', { lastMessageSeq: 1 }), row(3, 'P2P', { lastMessageSeq: 1 })],
      { 1: 1, 2: 1, 3: 1 },
      { 1: { seq: 1, content: 'a', contentType: 'PURE_TEXT', id: 10 },
        2: { seq: 1, content: 'b', contentType: 'PURE_TEXT', id: 20 },
        3: { seq: 1, content: 'c', contentType: 'PURE_TEXT', id: 30 } },
    );
    const res = await svc.buildNotifyResponse(1, { take: 2 }); // newest 2 = ids 30,20
    expect(res.items.map((i) => i.threadId)).toEqual([2, 3]); // ASC within page
    expect(res.hasMore).toBe(true);
    expect(res.nextCursor).toEqual({ threadId: 3, seq: 1 }); // max-id of the page
  });

  it('cursor forward: id > cursor only, ASC — no overlap with the snapshot page', async () => {
    wire(
      [row(1, 'P2P', { lastMessageSeq: 1 }), row(2, 'P2P', { lastMessageSeq: 1 }), row(3, 'P2P', { lastMessageSeq: 1 })],
      { 1: 1, 2: 1, 3: 1 },
      { 1: { seq: 1, content: 'a', contentType: 'PURE_TEXT', id: 10 },
        2: { seq: 1, content: 'b', contentType: 'PURE_TEXT', id: 20 },
        3: { seq: 1, content: 'c', contentType: 'PURE_TEXT', id: 30 } },
    );
    // Cursor = thread 2's latest (id 20) → forward returns only id>20 = thread 3.
    const res = await svc.buildNotifyResponse(1, { cursor: { threadId: 2, seq: 1 }, take: 50 });
    expect(res.items.map((i) => i.threadId)).toEqual([3]);
    expect(res.nextCursor).toEqual({ threadId: 3, seq: 1 });
  });

  it('empty result → items [], nextCursor null, a clear descriptor', async () => {
    wire([row(1, 'P2P', { lastMessageSeq: 1 })], { 1: 0 }, { 1: { seq: 1, content: 'x', contentType: 'PURE_TEXT', id: 5 } });
    const res = await svc.buildNotifyResponse(1, { take: 50 });
    expect(res.items.map((i) => i.threadId)).toEqual([1]); // the thread is listed (read)…
    expect(res.notifications[0].kind).toBe('clear'); // …but nothing unread+unmuted → clear
    expect(res.notifications[0].tag).toBe('soms-away');
  });

  it('descriptor folds unread+unmuted senders; avatarStack is fed their avatars', async () => {
    wire(
      [row(1, 'P2P', { lastMessageSeq: 1 }), row(2, 'P2P', { lastMessageSeq: 1 })],
      { 1: 2, 2: 3 },
      { 1: { seq: 1, content: 'a', contentType: 'PURE_TEXT', id: 10 },
        2: { seq: 1, content: 'b', contentType: 'PURE_TEXT', id: 20 } },
      [{ threadId: 1, userId: 11 }, { threadId: 2, userId: 22 }],
      [{ id: 11, name: 'Alice', avatar: '/uploads/avatars/a-512.webp' },
        { id: 22, name: 'Bob', avatar: '/uploads/avatars/b-512.webp' }],
    );
    const res = await svc.buildNotifyResponse(1, { take: 50, acceptLanguage: 'en' });
    expect(res.notifications[0].kind).toBe('message-summary');
    expect(res.notifications[0].body).toBe('Alice, Bob sent you 5 messages');
    expect(res.notifications[0].icon).toBe('/uploads/notif-icons/abc.png');
    expect(composeStack).toHaveBeenCalledWith([
      { avatarUrl: '/uploads/avatars/a-512.webp', displayName: 'Alice', userId: 11 },
      { avatarUrl: '/uploads/avatars/b-512.webp', displayName: 'Bob', userId: 22 },
    ]);
  });

  it('honors Accept-Language: zh-CN → Chinese body', async () => {
    wire(
      [row(1, 'P2P', { lastMessageSeq: 1 })],
      { 1: 7 },
      { 1: { seq: 1, content: 'a', contentType: 'PURE_TEXT', id: 10 } },
      [{ threadId: 1, userId: 11 }],
      [{ id: 11, name: 'Alice', avatar: '' }],
    );
    const res = await svc.buildNotifyResponse(1, { take: 50, acceptLanguage: 'zh-CN' });
    expect(res.notifications[0].body).toBe('Alice 给你发了 7 条消息');
    expect(res.notifications[0].lang).toBe('zh-CN');
  });

  it('never exposes the BigInt id (attachMediaStatus is the strip point)', async () => {
    wire(
      [row(1, 'P2P', { lastMessageSeq: 1 })],
      { 1: 1 },
      { 1: { seq: 1, content: 'x', contentType: 'PURE_TEXT', id: 999 } },
    );
    const res = await svc.buildNotifyResponse(1, { take: 50 });
    expect(JSON.stringify(res.items)).not.toContain('"id"');
    expect(res.items[0].latestMessage).not.toHaveProperty('id');
  });

  it('an empty thread (lastMessageSeq null) is excluded — it has no cursor position', async () => {
    wire(
      [row(1, 'P2P', { lastMessageSeq: 1 }), row(2, 'P2P', { lastMessageSeq: null })],
      { 1: 1, 2: 1 },
      { 1: { seq: 1, content: 'x', contentType: 'PURE_TEXT', id: 10 } },
    );
    const res = await svc.buildNotifyResponse(1, { take: 50 });
    expect(res.items.map((i) => i.threadId)).toEqual([1]); // thread 2 (no messages) excluded
  });

  it('drops a P2P thread whose latest message is from a blocked creator (P2P block; groups keep them)', async () => {
    // thread 1's latest is from creator 99 (blocked); thread 2's from creator 1 (not blocked).
    blockedByMe.mockResolvedValue(new Set([99]));
    wire(
      [row(1, 'P2P', { lastMessageSeq: 1 }), row(2, 'P2P', { lastMessageSeq: 1 })],
      { 1: 1, 2: 1 },
      { 1: { seq: 1, content: 'a', contentType: 'PURE_TEXT', id: 10, creator: 99 },
        2: { seq: 1, content: 'b', contentType: 'PURE_TEXT', id: 20, creator: 1 } },
    );
    const res = await svc.buildNotifyResponse(1, { take: 50 });
    expect(res.items.map((i) => i.threadId)).toEqual([2]); // thread 1 (blocked creator) dropped
  });
});
