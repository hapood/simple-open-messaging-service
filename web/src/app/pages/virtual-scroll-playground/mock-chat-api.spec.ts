/**
 * MockItemSource 单元测试（游标契约：init / getOlder / getNewer / appendLive）。
 *
 * 纯数据层、无 DOM、无内核：直接 await 驱动，断言返回 items 的 msgId（'id-N'）、升序、boundary。
 * latency=0 使 init/getOlder/getNewer 同帧 resolve。镜像生产语义（原始单图 msg，合并在内核 mergeItems）。
 */
import { MockItemSource, MockUserService } from './mock-chat-api';
import type { VsItem } from '../../lib/virtual-scroll/virtual-scroller';
import type { ChatItemData, ChatMsgData } from '../../components/message-cards/chat-item';

/** 构造一条最小 ChatMsgData（供 appendLive 测试）。 */
function msg(msgId: string, isSelf = true): VsItem<ChatItemData> {
  const data: ChatMsgData = {
    type: 'msg', msgId, creator: isSelf ? 1 : 2, isSelf,
    name: isSelf ? '我' : '阿黄', text: 'x', time: '09:00',
    contentType: 'PURE_TEXT', images: null, createdAtMs: Date.now(),
  };
  return { id: msgId, data };
}

describe('MockItemSource（游标契约）', () => {
  it('init(-1,100,0) 取末 100 条升序、末位=newest；未到最老 → 首位无 oldest', async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    const items = await s.init(-1, 100, 0);
    expect(items.length).toBe(100);
    expect(items[0].id).toBe('id-400');   // 这批最老
    expect(items[99].id).toBe('id-499');  // 锚点=最新
    expect(items[99].boundary).toBe('newest');
    expect(items[0].boundary).toBeUndefined(); // 未到全局最老
  });

  it('init 小 total（olderCount 超出）→ 全取、首位=oldest、末位=newest', async () => {
    const s = new MockItemSource(50, 0, new MockUserService(), 1);
    const items = await s.init(-1, 100, 0);
    expect(items.length).toBe(50);
    expect(items[0].id).toBe('id-0');
    expect(items[0].boundary).toBe('oldest');
    expect(items[49].id).toBe('id-49');
    expect(items[49].boundary).toBe('newest');
  });

  it("getOlder('id-400',100) 取更老 100 条升序、未到边界", async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    await s.init(-1, 100, 0);
    const items = await s.getOlder('id-400', 100);
    expect(items.length).toBe(100);
    expect(items[0].id).toBe('id-300');
    expect(items[99].id).toBe('id-399');
    expect(items.every(i => !i.boundary)).toBe(true);
  });

  it('getOlder 到最老 → 截断 + 首位=oldest', async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    const items = await s.getOlder('id-50', 100); // cursor=full[50]，更老=full[0..49]
    expect(items.length).toBe(50);
    expect(items[0].id).toBe('id-0');
    expect(items[0].boundary).toBe('oldest');
    expect(items[49].id).toBe('id-49');
  });

  it('getOlder 已在最老（cursor=id-0）→ 返回空', async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    const items = await s.getOlder('id-0', 100);
    expect(items.length).toBe(0);
  });

  it("getNewer('id-400',100) 取更新到末、末位=newest", async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    const items = await s.getNewer('id-400', 100); // full[401..499] = 99 条
    expect(items.length).toBe(99);
    expect(items[0].id).toBe('id-401');
    expect(items[98].id).toBe('id-499');
    expect(items[98].boundary).toBe('newest');
  });

  it('appendLive 标 newest；之后 getNewer 从 full 末取到 live', async () => {
    const s = new MockItemSource(100, 0, new MockUserService(), 1);
    await s.init(-1, 100, 0);
    const out = s.appendLive([msg('live-1'), msg('live-2')]);
    expect(out.map(i => i.id)).toEqual(['live-1', 'live-2']);
    expect(out[1].boundary).toBe('newest');
    const newer = await s.getNewer('id-99', 10);
    expect(newer.map(i => i.id)).toEqual(['live-1', 'live-2']);
    expect(newer[1].boundary).toBe('newest');
  });

  it('确定性：同 total 两次 init → 数据完全一致', async () => {
    const a = new MockItemSource(300, 0, new MockUserService(), 1);
    const b = new MockItemSource(300, 0, new MockUserService(), 1);
    const ia = await a.init(-1, 300, 0);
    const ib = await b.init(-1, 300, 0);
    expect(ia.map(i => JSON.stringify(i.data))).toEqual(ib.map(i => JSON.stringify(i.data)));
  });

  it('数据形态：全 msg + createdAtMs 跨多天分布', async () => {
    const s = new MockItemSource(2000, 0, new MockUserService(), 1);
    const items = await s.init(-1, 2000, 0);
    expect(items.every(i => i.data.type === 'msg')).toBe(true);
    expect(items.some(i => i.data.contentType === 'IMAGE')).toBe(true);
    const ms = items.map(i => i.data.createdAtMs);
    expect(Math.max(...ms) - Math.min(...ms)).toBeGreaterThan(86_400_000);
  });

  it('镜像生产：每条 IMAGE 是单图（连续同 creator 由内核 mergeItems 合并）', async () => {
    const s = new MockItemSource(2000, 0, new MockUserService(), 1);
    const items = await s.init(-1, 2000, 0);
    const albums = items.filter(i => i.data.contentType === 'IMAGE');
    expect(albums.length).toBeGreaterThan(0);
    expect(albums.every(a => a.data.images?.length === 1)).toBe(true); // 单图；合并在 mergeItems
  });

  it('ensureProfiles 按 creator 查 MockUserService 填 name/isSelf（镜像生产 ensureProfiles→queryUserInfo）', async () => {
    const s = new MockItemSource(500, 0, new MockUserService(), 1);
    const items = await s.init(-1, 100, 0);
    const self = items.find(i => i.data.creator === 1)!;
    const other = items.find(i => i.data.creator === 2)!;
    expect(self.data.name).toBe('我');   // ensureProfiles 从 MockUserService 查填（buildItems 的原始 msg name 占位 ''）
    expect(self.data.isSelf).toBe(true);  // isSelf = creator === userId(1)
    expect(other.data.name).toBe('阿黄');
    expect(other.data.isSelf).toBe(false);
  });
});
