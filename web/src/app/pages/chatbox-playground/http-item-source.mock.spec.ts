/**
 * MockItemSource unit tests (cursor contract: init / getOlder / getNewer / pushLive + getPending).
 *
 * Pure data layer — no DOM, no kernel: drive directly via await, assert the returned items' msgId (the buildItems
 * positive seq), ascending order, and boundary. latency=0 makes init/getOlder/getNewer resolve in the same frame.
 * Mirrors production semantics (raw single-image msgs; album merging is the kernel's mergeItems job).
 */
import {
  MockItemSource,
  MockUserService,
  mockSender,
} from './http-item-source.mock';
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
    creator: isSelf
      ? JSON.stringify([0, 'user-1'])
      : JSON.stringify([0, 'user-2']),
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
  it('around an absent cursor retains surrounding history', async () => {
    const source = new MockItemSource(100, 0, 0, new MockUserService(), 1);
    source.withdraw(50);
    const aroundHole = await source.loadWindow({
      kind: 'around', messageId: 50, olderCount: 2, newerCount: 2,
    });
    expect(aroundHole.map(item => item.id)).toEqual([48, 49, 51, 52]);
    const beyondTail = await source.loadWindow({
      kind: 'around', messageId: 101, olderCount: 2, newerCount: 2,
    });
    expect(beyondTail.map(item => item.id)).toEqual([99, 100]);
    source.destroy();
  });

  it('init(-1,100,0) caps at MAX_PAGE (50): newest 50 ascending; last=newest; not yet at oldest', async () => {
    const s = new MockItemSource(500, 0, 0, new MockUserService(), 1);
    const items = await s.loadWindow({ kind: 'latest', count: 100 }); // olderCount(100) > MAX_PAGE → one page returned (mirrors HttpItemSource)
    expect(items.length).toBe(50); // capped at MAX_PAGE
    expect(items[0].id).toBe(451); // oldest of this capped batch
    expect(items[49].id).toBe(500); // anchor = newest
    expect(items[49].boundary).toBe('newest');
    expect(items[0].boundary).toBeUndefined(); // not yet at the global oldest (more pages remain)
  });

  it('init with a small total (olderCount overshoots) → takes all; first=oldest, last=newest', async () => {
    const s = new MockItemSource(50, 0, 0, new MockUserService(), 1);
    const items = await s.loadWindow({ kind: 'latest', count: 100 });
    expect(items.length).toBe(50);
    expect(items[0].id).toBe(1);
    expect(items[0].boundary).toBe('oldest');
    expect(items[49].id).toBe(50);
    expect(items[49].boundary).toBe('newest');
  });

  it('getOlder(400,100) caps at MAX_PAGE (50): 50 older ascending; no boundary', async () => {
    const s = new MockItemSource(500, 0, 0, new MockUserService(), 1);
    await s.loadWindow({ kind: 'latest', count: 100 });
    const items = await s.getOlder(400, 100); // count(100) > MAX_PAGE → one page returned
    expect(items.length).toBe(50); // capped at MAX_PAGE
    expect(items[0].id).toBe(350);
    expect(items[49].id).toBe(399);
    expect(items.every((i) => !i.boundary)).toBe(true);
  });

  it('getOlder reaching the oldest → truncates + first=oldest', async () => {
    const s = new MockItemSource(500, 0, 0, new MockUserService(), 1);
    const items = await s.getOlder(51, 100); // cursor=full[50], older=full[0..49]
    expect(items.length).toBe(50);
    expect(items[0].id).toBe(1);
    expect(items[0].boundary).toBe('oldest');
    expect(items[49].id).toBe(50);
  });

  it('getOlder already at the oldest (cursor=1) → empty', async () => {
    const s = new MockItemSource(500, 0, 0, new MockUserService(), 1);
    const items = await s.getOlder(1, 100);
    expect(items.length).toBe(0);
  });

  it("getNewer(400,100) caps at MAX_PAGE (50): 50 newer ascending; doesn't reach the end → no newest", async () => {
    const s = new MockItemSource(500, 0, 0, new MockUserService(), 1);
    const items = await s.getNewer(400, 100); // 99 newer remain (> MAX_PAGE) → one page, end NOT reached
    expect(items.length).toBe(50); // capped at MAX_PAGE
    expect(items[0].id).toBe(401);
    expect(items[49].id).toBe(450);
    expect(items.every((i) => !i.boundary)).toBe(true); // didn't reach the end → no 'newest' tag
  });

  it('pushLive caches; getNewer then returns the live items (last tagged newest)', async () => {
    const s = new MockItemSource(100, 0, 0, new MockUserService(), 1);
    await s.loadWindow({ kind: 'latest', count: 100 });
    s.pushLive([msg(101), msg(102)]);
    const newer = await s.getNewer(100, 10);
    expect(newer.map((i) => i.id)).toEqual([101, 102]);
    expect(newer[1].boundary).toBe('newest');
  });

  it('a sender-carrying live push under a real-account creator keeps its name (no Unknown fallback)', async () => {
    const s = new MockItemSource(100, 0, 0, new MockUserService(), 1);
    await s.loadWindow({ kind: 'latest', count: 100 });
    // Live ticker pushes are authored under real playground accounts, which the
    // synthetic user-N profile table cannot resolve; the push carries its own
    // revision-backed sender (mirroring production toMsgData). shape must pass
    // that sender and the item's name through — the creator lookup misses.
    const base = msg(101, false).data;
    if (base.type !== 'msg') throw new Error('expected a msg item');
    const live: CbItem<ChatItemData> = {
      id: 101,
      data: {
        ...base,
        creator: JSON.stringify([0, 'alice']),
        name: 'Alice',
        sender: mockSender(
          { account: 'alice', namespaceId: 0, profileRev: 1 },
          'Alice',
        ),
      },
    };
    s.pushLive([live]);
    const newer = await s.getNewer(100, 10);
    expect(newer).toHaveLength(1);
    expect(newer[0].data.type).toBe('msg');
    if (newer[0].data.type !== 'msg') return;
    expect(newer[0].data.name).toBe('Alice');
    expect(newer[0].data.sender?.kind).toBe('demand');
  });

  it('newer history preserves server identity and client correlation at the newest boundary', async () => {
    const s = new MockItemSource(100, 0, 0, new MockUserService(), 1);
    await s.loadWindow({ kind: 'latest', count: 100 });
    s.pushLive([{ ...msg(500), clientMessageId: 'cid-1' }]);
    const newer = await s.getNewer(100, 10);
    expect(newer.map((item) => item.id)).toEqual([500]);
    expect(newer[0].clientMessageId).toBe('cid-1');
    expect(newer[0].boundary).toBe('newest');
  });

  it('latest window includes the first confirmed message with both history boundaries', async () => {
    const s = new MockItemSource(0, 0, 0, new MockUserService(), 1);
    s.pushLive([{ ...msg(1), clientMessageId: 'cid-1' }]);
    const items = await s.loadWindow({ kind: 'latest', count: 100 });
    expect(items.map((item) => item.id)).toEqual([1]);
    expect(items[0].clientMessageId).toBe('cid-1');
    expect(items[0].boundary).toBe('both');
  });

  it('caps newer history pages while retaining the newest boundary', async () => {
    const s = new MockItemSource(150, 0, 0, new MockUserService(), 1); // total=150 → id 101..150 = exactly MAX_PAGE newer
    await s.loadWindow({ kind: 'latest', count: 100 });
    // The requested count exceeds MAX_PAGE, but the capped page still reaches the history head.
    const newer = await s.getNewer(100, 100);
    expect(newer.length).toBe(50); // page full (capped) at the edge
    expect(newer[49].id).toBe(150);
    expect(newer[49].boundary).toBe('newest'); // reached the end
  });

  it('deterministic: same total, two inits → identical data', async () => {
    const a = new MockItemSource(300, 0, 0, new MockUserService(), 1);
    const b = new MockItemSource(300, 0, 0, new MockUserService(), 1);
    const ia = await a.loadWindow({ kind: 'latest', count: 300 });
    const ib = await b.loadWindow({ kind: 'latest', count: 300 });
    expect(ia.map((i) => JSON.stringify(i.data))).toEqual(
      ib.map((i) => JSON.stringify(i.data)),
    );
  });

  it('data shape: all msgs + createdAtMs spread across many days', async () => {
    const s = new MockItemSource(2000, 0, 0, new MockUserService(), 1);
    const items = await s.loadWindow({ kind: 'latest', count: 2000 });
    expect(items.every((i) => i.data.type === 'msg')).toBe(true);
    expect(items.some((i) => i.data.contentType === 'IMAGE')).toBe(true);
    const ms = items.map((i) => i.data.createdAtMs);
    expect(Math.max(...ms) - Math.min(...ms)).toBeGreaterThan(86400000);
  });

  it('mirrors production: every IMAGE is a single image (consecutive same-creator merged by kernel mergeItems)', async () => {
    const s = new MockItemSource(2000, 0, 0, new MockUserService(), 1);
    const items = await s.loadWindow({ kind: 'latest', count: 2000 });
    const albums = items.filter((i) => i.data.contentType === 'IMAGE');
    expect(albums.length).toBeGreaterThan(0);
    expect(albums.every((a) => a.data.images?.length === 1)).toBe(true); // single image; merging is in mergeItems
  });

  it('ensureProfiles fills name/isSelf by creator via MockUserService (mirrors production ensureProfiles→queryUserInfo)', async () => {
    const s = new MockItemSource(500, 0, 0, new MockUserService(), 1);
    const items = await s.loadWindow({ kind: 'latest', count: 100 });
    const self = items.find(
      (i) =>
        i.data.type === 'msg' &&
        i.data.creator === JSON.stringify([0, 'user-1']),
    )!;
    const other = items.find(
      (i) =>
        i.data.type === 'msg' &&
        i.data.creator === JSON.stringify([0, 'user-2']),
    )!;
    expect(self.data.name).toBe('Me'); // ensureProfiles from MockUserService (buildItems raw msg name placeholder '')
    expect(self.data.isSelf).toBe(true); // isSelf = creator === userId(1)
    expect(self.data.avatarIdentityId).toBe(JSON.stringify([0, 'user-1']));
    expect(other.data.name).toBe('Alice');
    expect(other.data.isSelf).toBe(false);
    expect(other.data.avatarIdentityId).toBe(JSON.stringify([0, 'user-2']));
  });

});
