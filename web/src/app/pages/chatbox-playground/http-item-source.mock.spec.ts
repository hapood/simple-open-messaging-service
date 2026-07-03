/**
 * MockItemSource unit tests (cursor contract: init / getOlder / getNewer / pushLive + getPending).
 *
 * Pure data layer — no DOM, no kernel: drive directly via await, assert the returned items' msgId ('id-N'),
 * ascending order, and boundary. latency=0 makes init/getOlder/getNewer resolve in the same frame. Mirrors
 * production semantics (raw single-image msgs; album merging is the kernel's mergeItems job).
 */
import { MockItemSource, MockUserService } from './http-item-source.mock';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { ChatItemData, ChatMsgData } from '../../components/message-cards/chat-item';

/** Build a minimal ChatMsgData (for pushLive / pending tests). */
function msg(msgId: string, isSelf = true): CbItem<ChatItemData> {
  const data: ChatMsgData = {
    type: 'msg', msgId, creator: isSelf ? 1 : 2, isSelf,
    name: isSelf ? 'Me' : 'Alice', text: 'x', time: '09:00',
    contentType: 'PURE_TEXT', images: null, file: null, createdAtMs: Date.now(),
  };
  return { id: msgId, data };
}

describe('MockItemSource (cursor contract)', () => {
  it('init(-1,100,0) takes the newest 100 ascending; last=newest; not yet at oldest → first has no oldest', async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    const items = await s.init(-1, 100, 0);
    expect(items.length).toBe(100);
    expect(items[0].id).toBe('id-400');   // oldest of this batch
    expect(items[99].id).toBe('id-499');  // anchor = newest
    expect(items[99].boundary).toBe('newest');
    expect(items[0].boundary).toBeUndefined(); // not yet at the global oldest
  });

  it('init with a small total (olderCount overshoots) → takes all; first=oldest, last=newest', async () => {
    const s = new MockItemSource(50, 0, new MockUserService(), 1);
    const items = await s.init(-1, 100, 0);
    expect(items.length).toBe(50);
    expect(items[0].id).toBe('id-0');
    expect(items[0].boundary).toBe('oldest');
    expect(items[49].id).toBe('id-49');
    expect(items[49].boundary).toBe('newest');
  });

  it("getOlder('id-400',100) takes 100 older ascending; no boundary", async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    await s.init(-1, 100, 0);
    const items = await s.getOlder('id-400', 100);
    expect(items.length).toBe(100);
    expect(items[0].id).toBe('id-300');
    expect(items[99].id).toBe('id-399');
    expect(items.every(i => !i.boundary)).toBe(true);
  });

  it('getOlder reaching the oldest → truncates + first=oldest', async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    const items = await s.getOlder('id-50', 100); // cursor=full[50], older=full[0..49]
    expect(items.length).toBe(50);
    expect(items[0].id).toBe('id-0');
    expect(items[0].boundary).toBe('oldest');
    expect(items[49].id).toBe('id-49');
  });

  it('getOlder already at the oldest (cursor=id-0) → empty', async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    const items = await s.getOlder('id-0', 100);
    expect(items.length).toBe(0);
  });

  it("getNewer('id-400',100) takes newer through the end; last=newest", async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    const items = await s.getNewer('id-400', 100); // full[401..499] = 99 items
    expect(items.length).toBe(99);
    expect(items[0].id).toBe('id-401');
    expect(items[98].id).toBe('id-499');
    expect(items[98].boundary).toBe('newest');
  });

  it('pushLive caches; getNewer then returns the live items (last tagged newest)', async () => {
    const s = new MockItemSource(100, 0, new MockUserService(), 1);
    await s.init(-1, 100, 0);
    s.pushLive([msg('live-1'), msg('live-2')]);
    const newer = await s.getNewer('id-99', 10);
    expect(newer.map(i => i.id)).toEqual(['live-1', 'live-2']);
    expect(newer[1].boundary).toBe('newest');
  });

  it('getNewer returns reals only + reconciles pending by clientMessageId (never appends pending)', async () => {
    const s = new MockItemSource(100, 0, new MockUserService(), 1);
    await s.init(-1, 100, 0);
    // Two in-flight optimistic sends, each keyed by a clientMessageId. The server echo carries the SAME clientMessageId
    // but a FRESH server msgId (mirrors production: clientMessageId reconciles, the server-assigned msgId is new).
    s.addPending({ ...msg('pending-1'), clientMessageId: 'cid-1' });
    s.addPending({ ...msg('pending-2'), clientMessageId: 'cid-2' });
    s.pushLive([{ ...msg('real-500'), clientMessageId: 'cid-1' }]); // server echo confirming pending-1 (cid-1)
    // getNewer returns reals only: [real-500]. As a side effect it reconciles pending — pending-1 (cid-1 matched) is
    // dropped. pending-2 is NOT appended (the kernel mounts pending separately via getPending at the newest edge).
    const newer = await s.getNewer('id-99', 10);
    expect(newer.map(i => i.id)).toEqual(['real-500']);
    expect(newer[0].clientMessageId).toBe('cid-1'); // shape preserves the reconcile key on the confirmed real
    expect(newer[0].boundary).toBe('newest');       // reached the sequence end
    // pending-1 dropped (confirmed); pending-2 still in flight → recoverable via getPending.
    expect(s.hasPending()).toBe(true);
    const pending = s.getPending();
    expect(pending.map(p => p.id)).toEqual(['pending-2']);
    expect(pending[0].clientMessageId).toBe('cid-2');
  });

  it('init reconciles pending by clientMessageId (empty-thread confirm routes through init, not getNewer)', async () => {
    const s = new MockItemSource(0, 0, new MockUserService(), 1);
    s.addPending({ ...msg('pending-1'), clientMessageId: 'cid-1' });
    s.pushLive([{ ...msg('real-0'), clientMessageId: 'cid-1' }]); // server echo confirming pending-1 (cid-1)
    // The kernel's loadNewer falls back to init(-1) when the window is entirely optimistic (an empty-thread confirm).
    // init MUST reconcile pending just like getNewer — otherwise the confirmed pending survives in source.pending and
    // the kernel's elevatePending re-mounts it as a stale optimistic bubble below the next incoming message.
    const items = await s.init(-1, 100, 0);
    expect(items.map(i => i.id)).toEqual(['real-0']);
    expect(items[0].clientMessageId).toBe('cid-1'); // shape preserves the reconcile key on the confirmed real
    expect(items[0].boundary).toBe('both');          // sole item spanning both edges (empty thread)
    expect(s.hasPending()).toBe(false);              // pending-1 dropped (confirmed) — the regression this guards
    expect(s.getPending().map(p => p.id)).toEqual([]);
  });

  it('getNewer never appends pending even when real == count (page full at the edge)', async () => {
    const s = new MockItemSource(200, 0, new MockUserService(), 1);
    await s.init(-1, 100, 0);
    s.addPending(msg('pending-x'));
    // cursor=id-99, count=100: 100 real items (id-100..id-199) reach the end exactly → page full, no pending mixing.
    const newer = await s.getNewer('id-99', 100);
    expect(newer.length).toBe(100);
    expect(newer[99].id).toBe('id-199');
    expect(newer[99].boundary).toBe('newest');
    expect(s.hasPending()).toBe(true);              // pending untouched, recoverable via getPending
    expect(s.getPending().map(p => p.id)).toEqual(['pending-x']);
  });

  it('deterministic: same total, two inits → identical data', async () => {
    const a = new MockItemSource(300, 0, new MockUserService(), 1);
    const b = new MockItemSource(300, 0, new MockUserService(), 1);
    const ia = await a.init(-1, 300, 0);
    const ib = await b.init(-1, 300, 0);
    expect(ia.map(i => JSON.stringify(i.data))).toEqual(ib.map(i => JSON.stringify(i.data)));
  });

  it('data shape: all msgs + createdAtMs spread across many days', async () => {
    const s = new MockItemSource(2000, 0, new MockUserService(), 1);
    const items = await s.init(-1, 2000, 0);
    expect(items.every(i => i.data.type === 'msg')).toBe(true);
    expect(items.some(i => i.data.contentType === 'IMAGE')).toBe(true);
    const ms = items.map(i => i.data.createdAtMs);
    expect(Math.max(...ms) - Math.min(...ms)).toBeGreaterThan(86_400_000);
  });

  it('mirrors production: every IMAGE is a single image (consecutive same-creator merged by kernel mergeItems)', async () => {
    const s = new MockItemSource(2000, 0, new MockUserService(), 1);
    const items = await s.init(-1, 2000, 0);
    const albums = items.filter(i => i.data.contentType === 'IMAGE');
    expect(albums.length).toBeGreaterThan(0);
    expect(albums.every(a => a.data.images?.length === 1)).toBe(true); // single image; merging is in mergeItems
  });

  it('ensureProfiles fills name/isSelf by creator via MockUserService (mirrors production ensureProfiles→queryUserInfo)', async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    const items = await s.init(-1, 100, 0);
    const self = items.find(i => i.data.creator === 1)!;
    const other = items.find(i => i.data.creator === 2)!;
    expect(self.data.name).toBe('Me');    // ensureProfiles from MockUserService (buildItems raw msg name placeholder '')
    expect(self.data.isSelf).toBe(true);  // isSelf = creator === userId(1)
    expect(other.data.name).toBe('Alice');
    expect(other.data.isSelf).toBe(false);
  });

  // failPending / retryPending: a failed send stays the SAME entity (stable clientMessageId) and sinks to the tail of
  // the pending queue. data.msgId MUST equal clientMessageId (the row's retry output emits data.msgId as the retry key).
  it('failPending flips status to failed, sinks the entry to the end of pending, keeps clientMessageId + msgId stable', async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    await s.init(-1, 100, 0);
    s.addPending({ ...msg('cid-A'), clientMessageId: 'cid-A' });
    s.addPending({ ...msg('cid-B'), clientMessageId: 'cid-B' });
    expect(s.failPending('cid-A')).toBe(true);
    expect(s.failPending('no-such')).toBe(false); // unknown clientMessageId → no-op
    const pending = s.getPending();
    expect(pending.map(p => p.clientMessageId)).toEqual(['cid-B', 'cid-A']); // A sunk to the end
    const failed = pending[1];
    expect(failed.data.status).toBe('failed');
    expect(failed.clientMessageId).toBe('cid-A');      // stable identity
    expect(failed.data.msgId).toBe('cid-A');           // msgId === clientMessageId (the retry key the row emits)
  });

  it('retryPending flips status back to sending at its current position, keeping clientMessageId + msgId stable', async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    await s.init(-1, 100, 0);
    s.addPending({ ...msg('cid-A'), clientMessageId: 'cid-A' });
    s.failPending('cid-A');
    const retrying = s.retryPending('cid-A');
    expect(retrying).toBeDefined();
    expect(s.retryPending('no-such')).toBeUndefined();
    expect(retrying!.data.status).toBe('sending');
    expect(retrying!.clientMessageId).toBe('cid-A');   // stable identity (no fresh uuid on retry)
    expect(retrying!.data.msgId).toBe('cid-A');
    expect(s.getPending().map(p => p.clientMessageId)).toEqual(['cid-A']); // stayed at the end (its current position)
  });
});
