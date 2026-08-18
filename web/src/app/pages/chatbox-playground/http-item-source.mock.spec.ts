/**
 * MockItemSource unit tests (cursor contract: init / getOlder / getNewer / pushLive + getPending).
 *
 * Pure data layer — no DOM, no kernel: drive directly via await, assert the returned items' msgId (the buildItems
 * positive seq), ascending order, and boundary. latency=0 makes init/getOlder/getNewer resolve in the same frame.
 * Mirrors production semantics (raw single-image msgs; album merging is the kernel's mergeItems job).
 */
import { MockItemSource, MockUserService } from './http-item-source.mock';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type {
  ChatItemData,
  ChatMsgData,
} from '../../components/message-cards/chat-item';

/** Build a minimal ChatMsgData (for pushLive / pending tests). id and data.msgId are both the numeric msgId. */
function msg(msgId: number, isSelf = true): CbItem<ChatItemData> {
  const data: ChatMsgData = {
    type: 'msg',
    msgId,
    creator: isSelf ? 1 : 2,
    isSelf,
    name: isSelf ? 'Me' : 'Alice',
    text: 'x',
    time: '09:00',
    contentType: 'PURE_TEXT',
    images: null,
    file: null,
    createdAtMs: Date.now(),
  };
  return { id: msgId, data };
}

describe('MockItemSource (cursor contract)', () => {
  it('init(-1,100,0) caps at MAX_PAGE (50): newest 50 ascending; last=newest; not yet at oldest', async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    const items = await s.init(-1, 100, 0); // olderCount(100) > MAX_PAGE → one page returned (mirrors HttpItemSource)
    expect(items.length).toBe(50); // capped at MAX_PAGE
    expect(items[0].id).toBe(451); // oldest of this capped batch
    expect(items[49].id).toBe(500); // anchor = newest
    expect(items[49].boundary).toBe('newest');
    expect(items[0].boundary).toBeUndefined(); // not yet at the global oldest (more pages remain)
  });

  it('init with a small total (olderCount overshoots) → takes all; first=oldest, last=newest', async () => {
    const s = new MockItemSource(50, 0, new MockUserService(), 1);
    const items = await s.init(-1, 100, 0);
    expect(items.length).toBe(50);
    expect(items[0].id).toBe(1);
    expect(items[0].boundary).toBe('oldest');
    expect(items[49].id).toBe(50);
    expect(items[49].boundary).toBe('newest');
  });

  it('getOlder(400,100) caps at MAX_PAGE (50): 50 older ascending; no boundary', async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    await s.init(-1, 100, 0);
    const items = await s.getOlder(400, 100); // count(100) > MAX_PAGE → one page returned
    expect(items.length).toBe(50); // capped at MAX_PAGE
    expect(items[0].id).toBe(350);
    expect(items[49].id).toBe(399);
    expect(items.every((i) => !i.boundary)).toBe(true);
  });

  it('getOlder reaching the oldest → truncates + first=oldest', async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    const items = await s.getOlder(51, 100); // cursor=full[50], older=full[0..49]
    expect(items.length).toBe(50);
    expect(items[0].id).toBe(1);
    expect(items[0].boundary).toBe('oldest');
    expect(items[49].id).toBe(50);
  });

  it('getOlder already at the oldest (cursor=1) → empty', async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    const items = await s.getOlder(1, 100);
    expect(items.length).toBe(0);
  });

  it("getNewer(400,100) caps at MAX_PAGE (50): 50 newer ascending; doesn't reach the end → no newest", async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    const items = await s.getNewer(400, 100); // 99 newer remain (> MAX_PAGE) → one page, end NOT reached
    expect(items.length).toBe(50); // capped at MAX_PAGE
    expect(items[0].id).toBe(401);
    expect(items[49].id).toBe(450);
    expect(items.every((i) => !i.boundary)).toBe(true); // didn't reach the end → no 'newest' tag
  });

  it('pushLive caches; getNewer then returns the live items (last tagged newest)', async () => {
    const s = new MockItemSource(100, 0, new MockUserService(), 1);
    await s.init(-1, 100, 0);
    s.pushLive([msg(101), msg(102)]);
    const newer = await s.getNewer(100, 10);
    expect(newer.map((i) => i.id)).toEqual([101, 102]);
    expect(newer[1].boundary).toBe('newest');
  });

  it('getNewer returns reals only + reconciles pending by clientMessageId (never appends pending)', async () => {
    const s = new MockItemSource(100, 0, new MockUserService(), 1);
    await s.init(-1, 100, 0);
    // Two in-flight optimistic sends, each keyed by a clientMessageId. The server echo carries the SAME clientMessageId
    // but a FRESH server msgId (mirrors production: clientMessageId reconciles, the server-assigned msgId is new).
    s.addPending({ ...msg(201), clientMessageId: 'cid-1' });
    s.addPending({ ...msg(202), clientMessageId: 'cid-2' });
    s.pushLive([{ ...msg(500), clientMessageId: 'cid-1' }]); // server echo confirming pending-1 (cid-1)
    // getNewer returns reals only: [500]. As a side effect it reconciles pending — pending-1 (cid-1 matched) is
    // dropped. pending-2 is NOT appended (the kernel mounts pending separately via getPending at the newest edge).
    const newer = await s.getNewer(100, 10);
    expect(newer.map((i) => i.id)).toEqual([500]);
    expect(newer[0].clientMessageId).toBe('cid-1'); // shape preserves the reconcile key on the confirmed real
    expect(newer[0].boundary).toBe('newest'); // reached the sequence end
    // pending-1 dropped (confirmed); pending-2 still in flight → recoverable via getPending.
    expect(s.hasPending()).toBe(true);
    const pending = s.getPending();
    expect(pending.map((p) => p.id)).toEqual([202]);
    expect(pending[0].clientMessageId).toBe('cid-2');
  });

  it('init reconciles pending by clientMessageId (empty-thread confirm routes through init, not getNewer)', async () => {
    const s = new MockItemSource(0, 0, new MockUserService(), 1);
    s.addPending({ ...msg(201), clientMessageId: 'cid-1' });
    s.pushLive([{ ...msg(1), clientMessageId: 'cid-1' }]); // server echo confirming pending-1 (cid-1)
    // The kernel's loadNewer falls back to init(-1) when the window is entirely optimistic (an empty-thread confirm).
    // init MUST reconcile pending just like getNewer — otherwise the confirmed pending survives in source.pending and
    // the kernel's elevatePending re-mounts it as a stale optimistic bubble below the next incoming message.
    const items = await s.init(-1, 100, 0);
    expect(items.map((i) => i.id)).toEqual([1]);
    expect(items[0].clientMessageId).toBe('cid-1'); // shape preserves the reconcile key on the confirmed real
    expect(items[0].boundary).toBe('both'); // sole item spanning both edges (empty thread)
    expect(s.hasPending()).toBe(false); // pending-1 dropped (confirmed) — the regression this guards
    expect(s.getPending().map((p) => p.id)).toEqual([]);
  });

  it('getNewer never appends pending even when real fills the page at the edge (MAX_PAGE reals reach the end)', async () => {
    const s = new MockItemSource(150, 0, new MockUserService(), 1); // total=150 → id 101..150 = exactly MAX_PAGE newer
    await s.init(-1, 100, 0);
    s.addPending(msg(299));
    // cursor=100, count=100: exactly MAX_PAGE (50) real items (101..150) fill the page AND reach the end → no pending mixing.
    const newer = await s.getNewer(100, 100);
    expect(newer.length).toBe(50); // page full (capped) at the edge
    expect(newer[49].id).toBe(150);
    expect(newer[49].boundary).toBe('newest'); // reached the end
    expect(s.hasPending()).toBe(true); // pending untouched, recoverable via getPending
    expect(s.getPending().map((p) => p.id)).toEqual([299]);
  });

  it('deterministic: same total, two inits → identical data', async () => {
    const a = new MockItemSource(300, 0, new MockUserService(), 1);
    const b = new MockItemSource(300, 0, new MockUserService(), 1);
    const ia = await a.init(-1, 300, 0);
    const ib = await b.init(-1, 300, 0);
    expect(ia.map((i) => JSON.stringify(i.data))).toEqual(
      ib.map((i) => JSON.stringify(i.data)),
    );
  });

  it('data shape: all msgs + createdAtMs spread across many days', async () => {
    const s = new MockItemSource(2000, 0, new MockUserService(), 1);
    const items = await s.init(-1, 2000, 0);
    expect(items.every((i) => i.data.type === 'msg')).toBe(true);
    expect(items.some((i) => i.data.contentType === 'IMAGE')).toBe(true);
    const ms = items.map((i) => i.data.createdAtMs);
    expect(Math.max(...ms) - Math.min(...ms)).toBeGreaterThan(86_400_000);
  });

  it('mirrors production: every IMAGE is a single image (consecutive same-creator merged by kernel mergeItems)', async () => {
    const s = new MockItemSource(2000, 0, new MockUserService(), 1);
    const items = await s.init(-1, 2000, 0);
    const albums = items.filter((i) => i.data.contentType === 'IMAGE');
    expect(albums.length).toBeGreaterThan(0);
    expect(albums.every((a) => a.data.images?.length === 1)).toBe(true); // single image; merging is in mergeItems
  });

  it('ensureProfiles fills name/isSelf by creator via MockUserService (mirrors production ensureProfiles→queryUserInfo)', async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    const items = await s.init(-1, 100, 0);
    const self = items.find((i) => i.data.creator === 1)!;
    const other = items.find((i) => i.data.creator === 2)!;
    expect(self.data.name).toBe('Me'); // ensureProfiles from MockUserService (buildItems raw msg name placeholder '')
    expect(self.data.isSelf).toBe(true); // isSelf = creator === userId(1)
    expect(self.data.avatarIdentityId).toBe(1);
    expect(other.data.name).toBe('Alice');
    expect(other.data.isSelf).toBe(false);
    expect(other.data.avatarIdentityId).toBe(2);
  });

  // failPending / retryPending: a failed send stays the SAME entity (stable clientMessageId) and sinks to the tail of
  // the pending queue. clientMessageId is the retry/reconcile key; data.msgId is a stable numeric id unchanged across
  // the fail/retry flip (it is NOT the retry key — that is clientMessageId).
  it('failPending flips status to failed, sinks the entry to the end of pending, keeps clientMessageId + msgId stable', async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    await s.init(-1, 100, 0);
    s.addPending({ ...msg(201), clientMessageId: 'cid-A' });
    s.addPending({ ...msg(202), clientMessageId: 'cid-B' });
    expect(s.failPending('cid-A')).toBe(true);
    expect(s.failPending('no-such')).toBe(false); // unknown clientMessageId → no-op
    const pending = s.getPending();
    expect(pending.map((p) => p.clientMessageId)).toEqual(['cid-B', 'cid-A']); // A sunk to the end
    const failed = pending[1];
    expect(failed.data.status).toBe('failed');
    expect(failed.clientMessageId).toBe('cid-A'); // stable identity (the retry/reconcile key)
    expect(failed.data.msgId).toBe(201); // stable numeric id, unchanged across the fail flip
  });

  it('retryPending flips status back to sending at its current position, keeping clientMessageId + msgId stable', async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    await s.init(-1, 100, 0);
    s.addPending({ ...msg(201), clientMessageId: 'cid-A' });
    s.failPending('cid-A');
    const retrying = s.retryPending('cid-A');
    expect(retrying).toBeDefined();
    expect(s.retryPending('no-such')).toBeUndefined();
    expect(retrying!.data.status).toBe('sending');
    expect(retrying!.clientMessageId).toBe('cid-A'); // stable identity (no fresh uuid on retry)
    expect(retrying!.data.msgId).toBe(201); // stable numeric id, unchanged across the retry flip
    expect(s.getPending().map((p) => p.clientMessageId)).toEqual(['cid-A']); // stayed at the end (its current position)
  });

  it('markPendingAccepted keeps the optimistic entry and spinner until its push echo arrives', async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    await s.init(-1, 100, 0);
    s.addPending({
      ...msg(201),
      clientMessageId: 'cid-A',
      data: { ...msg(201).data, status: 'sending', kind: 'pending' },
    });

    expect(s.markPendingAccepted('cid-A')).toBe(true);
    expect(s.getPending()[0].data.status).toBe('accepted');
    expect(s.getPending()[0].data.kind).toBeUndefined();
    expect(s.markPendingAccepted('missing')).toBe(false);
  });
});
