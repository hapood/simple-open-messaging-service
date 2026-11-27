/**
 * MockItemSource unit tests (cursor contract: init / getOlder / getNewer / pushLive + getPending).
 *
 * Pure data layer — no DOM, no kernel: drive directly via await, assert the returned items' msgId (the buildItems
 * positive seq), ascending order, and boundary. latency=0 makes init/getOlder/getNewer resolve in the same frame.
 * Mirrors production semantics (raw single-image msgs; album merging is the kernel's mergeItems job).
 */
import { firstValueFrom } from 'rxjs';
import { vi } from 'vitest';
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
  function intervalSource(total = 100) {
    const committed = vi.fn();
    const started = vi.fn(() => committed);
    const source = new MockItemSource(
      total,
      0,
      0,
      new MockUserService(),
      1,
      false,
      1,
      { onHistoryIntervalStarted: started },
    );
    return { source, committed, started };
  }

  it('commits actual bounded scan coverage, including a deleted newest coordinate', async () => {
    const { source, committed } = intervalSource();
    source.withdraw(100);
    await source.getNewer(0, 10);
    expect(committed).toHaveBeenLastCalledWith(0, 10);
    await source.getNewer(95, 10);
    expect(committed).toHaveBeenLastCalledWith(95, 100);
    source.destroy();
  });

  it('reports start/read-seam windows only for their scanned range', async () => {
    const { source, committed } = intervalSource();
    expect(
      (await source.loadWindow({ kind: 'start', count: 10 })).map(
        (item) => item.id,
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(committed).toHaveBeenLastCalledWith(0, 10);
    source.withdraw(50);
    expect(
      (
        await source.loadWindow({
          kind: 'around',
          messageId: 50,
          olderCount: 2,
          newerCount: 2,
        })
      ).map((item) => item.id),
    ).toEqual([48, 49, 51, 52]);
    expect(committed).toHaveBeenLastCalledWith(47, 52);
    source.destroy();
  });

  it('captures a page endpoint before latency, not a head that advances during the fetch', async () => {
    const { source, committed } = intervalSource();
    let release!: () => void;
    source.beforeHistoryScan = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    source.pushLive([msg(101)]);
    const page = source.getNewer(100, 50);
    source.advanceDeletedHead(103);
    release();
    expect((await page).map((item) => item.id)).toEqual([101]);
    expect(committed).toHaveBeenCalledExactlyOnceWith(100, 101);
    source.beforeHistoryScan = undefined;
    expect(await source.getNewer(101, 50)).toEqual([]);
    expect(committed).toHaveBeenLastCalledWith(101, 103);
    source.destroy();
  });

  it('keeps an empty live consumer and commits later deleted-only coverage without inventing messages', async () => {
    const { source, committed, started } = intervalSource();
    const delivered = vi.fn();
    const subscription = source.requestNewer(100, 50).subscribe(delivered);
    source.advanceDeletedHead(102);
    await vi.waitFor(() =>
      expect(committed).toHaveBeenCalledExactlyOnceWith(100, 102),
    );
    expect(delivered).not.toHaveBeenCalled();
    expect(started).toHaveBeenCalledTimes(1);
    source.pushLive([msg(103)]);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));
    expect(committed).toHaveBeenLastCalledWith(102, 103);
    subscription.unsubscribe();
    source.destroy();
  });

  it('does not complete a range on history failure; a fresh consumer can retry', async () => {
    const { source, committed } = intervalSource();
    const error = new Error('Mock history failed');
    source.beforeHistoryScan = async () => {
      throw error;
    };
    expect(await firstValueFrom(source.requestNewer(90, 50))).toEqual({
      kind: 'error',
      error,
    });
    expect(committed).not.toHaveBeenCalled();
    source.beforeHistoryScan = undefined;
    expect((await firstValueFrom(source.requestNewer(90, 50))).kind).toBe(
      'items',
    );
    expect(committed).toHaveBeenCalledExactlyOnceWith(90, 100);
    source.destroy();
  });

  for (const action of ['unsubscribe', 'destroy'] as const) {
    it(`does not publish delayed scan evidence after ${action}`, async () => {
      const { source, committed } = intervalSource();
      let release!: () => void;
      let signal!: AbortSignal;
      source.beforeHistoryScan = (_range, current) => {
        signal = current;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      };
      const delivered = vi.fn();
      const subscription = source.requestNewer(90, 50).subscribe(delivered);
      if (action === 'destroy') source.destroy();
      else subscription.unsubscribe();
      expect(signal.aborted).toBe(true);
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(committed).not.toHaveBeenCalled();
      expect(delivered).not.toHaveBeenCalled();
      source.destroy();
    });
  }

  it('cancels an older consumer without reporting coverage after its transport resolves', async () => {
    const { source, committed } = intervalSource();
    let release!: () => void;
    source.beforeHistoryScan = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const delivered = vi.fn();
    const subscription = source.requestOlder(90, 50).subscribe(delivered);
    subscription.unsubscribe();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(committed).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
    source.destroy();
  });

  it('honors a cancelled window binding without publishing its range', async () => {
    const { source, committed } = intervalSource();
    let release!: () => void;
    source.beforeHistoryScan = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const controller = new AbortController();
    const page = source.loadWindow(
      { kind: 'latest', count: 50 },
      { signal: controller.signal },
    );
    controller.abort();
    release();
    await expect(page).rejects.toMatchObject({ name: 'AbortError' });
    expect(committed).not.toHaveBeenCalled();
    source.destroy();
  });

  it('around an absent cursor retains surrounding history', async () => {
    const source = new MockItemSource(100, 0, 0, new MockUserService(), 1);
    source.withdraw(50);
    const aroundHole = await source.loadWindow({
      kind: 'around',
      messageId: 50,
      olderCount: 2,
      newerCount: 2,
    });
    expect(aroundHole.map((item) => item.id)).toEqual([48, 49, 51, 52]);
    const beyondTail = await source.loadWindow({
      kind: 'around',
      messageId: 101,
      olderCount: 2,
      newerCount: 2,
    });
    expect(beyondTail.map((item) => item.id)).toEqual([99, 100]);
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
    const msgs = items.filter(
      (i): i is typeof i & { data: Extract<typeof i.data, { type: 'msg' }> } =>
        i.data.type === 'msg',
    );
    expect(msgs.some((i) => i.data.contentType === 'IMAGE')).toBe(true);
    const ms = msgs.map((i) => i.data.createdAtMs);
    expect(Math.max(...ms) - Math.min(...ms)).toBeGreaterThan(86400000);
  });

  it('mirrors production: every IMAGE is a single image (consecutive same-creator merged by kernel mergeItems)', async () => {
    const s = new MockItemSource(2000, 0, 0, new MockUserService(), 1);
    const items = await s.loadWindow({ kind: 'latest', count: 2000 });
    const albums = items.filter(
      (i): i is typeof i & { data: Extract<typeof i.data, { type: 'msg' }> } =>
        i.data.type === 'msg' && i.data.contentType === 'IMAGE',
    );
    expect(albums.length).toBeGreaterThan(0);
    expect(albums.every((a) => a.data.images?.length === 1)).toBe(true); // single image; merging is in mergeItems
  });

  it('ensureProfiles fills name/isSelf by creator via MockUserService (mirrors production ensureProfiles→queryUserInfo)', async () => {
    const s = new MockItemSource(500, 0, 0, new MockUserService(), 1);
    const items = await s.loadWindow({ kind: 'latest', count: 100 });
    const self = items.find(
      (i): i is typeof i & { data: Extract<typeof i.data, { type: 'msg' }> } =>
        i.data.type === 'msg' &&
        i.data.creator === JSON.stringify([0, 'user-1']),
    )!;
    const other = items.find(
      (i): i is typeof i & { data: Extract<typeof i.data, { type: 'msg' }> } =>
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
