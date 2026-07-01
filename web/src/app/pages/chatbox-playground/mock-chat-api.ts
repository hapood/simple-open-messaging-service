/**
 * Playground mock 数据层：MockItemSource（实现 VsSource<ChatItemData>）+ 确定性生成器 buildItems。
 *
 * **镜像生产**：MockItemSource 给【原始 msg】（不合并相册、不分配展示用 id），用 msgId 当游标
 *  （getOlder/getNewer）——与 HttpItemSource 同构。相册合并由内核 mergeItems hook 做。
 *  buildItems 也镜像生产语义：相册 = 多条连续单图 IMAGE msg（同 creator），不再"单 msg 多图"。
 *
 * date 分隔不在数据层产生（由前端 createItem 派生）。
 */
import { of, firstValueFrom, type Observable } from 'rxjs';
import type { VsItem } from '../../lib/chat-box/chat-box-scroller';
import type { VsSource, VsSourceInitOpts } from '../../lib/chat-box/source';
import type { AlbumImage, ChatItemData, ChatMsgData } from '../../components/message-cards/chat-item';
import type { StandardResponse, User } from '../../services/model';

/** Mock 用户表（id → User）。镜像生产后端用户表；MockItemSource.ensureProfiles 按 creator 查此表。 */
const MOCK_USERS: ReadonlyMap<number, User> = new Map([
  [1, { id: 1, uniqName: '我', isForeigner: false, createdAt: 0, updatedAt: 0, isDeleted: false } as User],
  [2, { id: 2, uniqName: '阿黄', isForeigner: false, createdAt: 0, updatedAt: 0, isDeleted: false } as User],
]);

/**
 * Playground mock 用户查询 service：镜像生产 UserService.queryUserInfo（POST /user/query）。
 * mock 走内存（of 同步），生产走 HTTP；签名一致 → MockItemSource.ensureProfiles 与生产 HttpItemSource 同构。
 */
export class MockUserService {
  /** 按 userIds 返回 User[]（of 同步模拟 HTTP）。 */
  queryUserInfo(params: { userIds: number[] }): Observable<StandardResponse<User[]>> {
    const data = params.userIds.map(id => MOCK_USERS.get(id)).filter((u): u is User => !!u);
    return of({ code: 0, message: 'ok', data });
  }
}

/**
 * Playground mock 数据源：实现 {@link VsSource}<{@link ChatItemData}>，确定性生成器 buildItems 作后端。
 *
 * 【逻辑序列】`sequence() = [...full, ...live]` 升序（最老→最新）：full=buildItems 历史记录，
 *  live=appendLive 的 WS 新消息。cursorId（msgId）在此序列 findIndex 定位。
 *  - `full[k].id = 'id-k'`（buildItems 生成序号，稳定可寻址）。
 *  - live item 的 id = 调用方给的 msgId（playground 'mock-N'/'recv-N'）。
 *
 * 【游标】getOlder(cursorId,count) 取 cursor 之前（更老）count 条；getNewer 取之后（更新）。
 *  到序列首（最老）→ out[0] 标 'oldest'；到末（最新）→ out[last] 标 'newest'。升序返回。
 *
 * @param total 生成器种子（确定性数据量 == full.length；buildItems 恰好产 total 条）。
 * @param latency 模拟 IO 延迟（ms）；测试传 0 使 init/getOlder/getNewer 同帧 resolve。
 */
export class MockItemSource implements VsSource<ChatItemData> {
  private readonly full: VsItem<ChatItemData>[];
  private readonly live: VsItem<ChatItemData>[] = [];
  /** 模拟 IO 延迟（ms）；playground 可动态调（0/200/1s/5s）测慢加载体验。 */
  latency: number;
  /** mock 用户查询 service（镜像生产 UserService）；ensureProfiles 按 creator 查它填 profiles。 */
  private readonly userService: MockUserService;
  /** 当前用户 id（isSelf 判定 = creator === userId）。 */
  private readonly userId: number;
  /** 用户信息缓存（creator → name/isSelf），由 ensureProfiles 按 creator 查 userService 填——镜像生产 HttpItemSource.profiles。 */
  private readonly profiles = new Map<number, { name: string; isSelf: boolean }>();

  constructor(total: number, latency: number, userService: MockUserService, userId: number) {
    this.full = buildItems(total);
    this.latency = latency;
    this.userService = userService;
    this.userId = userId;
  }

  /**
   * 初始化 / 重锚：
   *  - anchorId === -1：取末 olderCount 条（最新 olderCount 条，含锚点=最新），升序、标边界。
   *  - 其他（真实 msgId）：在 sequence 定位 anchorId，取 older（含 anchorId）+ newer 切片，合并升序
   *    （镜像生产 HttpItemSource 双向取）；older 取到序列首 → out[0] 标 'oldest'；newer 取到序列末 → out[last] 标 'newest'。
   */
  async init(anchorId: string | number, olderCount: number, newerCount: number, _opts?: VsSourceInitOpts): Promise<VsItem<ChatItemData>[]> {
    await this.wait();
    const seq = this.sequence();
    if (anchorId === -1) {
      const start = Math.max(0, seq.length - olderCount);
      const raw = seq.slice(start);
      if (raw.length === 0) return [];
      await this.ensureProfiles(raw); // 按 creator 查 userService 填 profiles（镜像生产）
      const items = raw.map(it => this.shape(it));
      if (start === 0) items[0] = { ...items[0], boundary: 'oldest' };
      items[items.length - 1] = { ...items[items.length - 1], boundary: 'newest' };
      return items;
    }
    // 真实 msgId：双向切片（older 含 anchorId = olderCount 条；newer = newerCount 条）
    const idx = seq.findIndex(it => String(it.id) === String(anchorId));
    if (idx < 0) return [];
    const olderStart = Math.max(0, idx - olderCount + 1);
    const newerEnd = Math.min(seq.length, idx + 1 + newerCount);
    const raw = [...seq.slice(olderStart, idx + 1), ...seq.slice(idx + 1, newerEnd)]; // [older..anchorId] ++ (anchorId..newer]
    if (raw.length === 0) return [];
    await this.ensureProfiles(raw);
    const items = raw.map(it => this.shape(it));
    if (olderStart === 0) items[0] = { ...items[0], boundary: 'oldest' };
    if (newerEnd === seq.length) items[items.length - 1] = { ...items[items.length - 1], boundary: 'newest' };
    return items;
  }

  /** 从 cursorId 向更老取 count 条（升序；不含 cursor）。到序列首 → out[0] 标 'oldest'。 */
  async getOlder(cursorId: string | number, count: number): Promise<VsItem<ChatItemData>[]> {
    await this.wait();
    const seq = this.sequence();
    const idx = seq.findIndex(it => String(it.id) === String(cursorId));
    if (idx < 0) return [];
    const start = Math.max(0, idx - count);
    const raw = seq.slice(start, idx);
    if (raw.length === 0) return [];
    await this.ensureProfiles(raw);
    const items = raw.map(it => this.shape(it));
    if (start === 0) items[0] = { ...items[0], boundary: 'oldest' };
    return items;
  }

  /** 从 cursorId 向更新取 count 条（升序；不含 cursor）。到序列末 → out[last] 标 'newest'。 */
  async getNewer(cursorId: string | number, count: number): Promise<VsItem<ChatItemData>[]> {
    await this.wait();
    const seq = this.sequence();
    const idx = seq.findIndex(it => String(it.id) === String(cursorId));
    if (idx < 0) return [];
    const end = Math.min(seq.length, idx + 1 + count);
    const raw = seq.slice(idx + 1, end);
    if (raw.length === 0) return [];
    await this.ensureProfiles(raw);
    const items = raw.map(it => this.shape(it));
    if (end === seq.length) items[items.length - 1] = { ...items[items.length - 1], boundary: 'newest' };
    return items;
  }

  /** WS 新消息：入 live、标 newest。id 用调用方给的 msgId（playground makeMockItem）。 */
  appendLive(rawItems: VsItem<ChatItemData>[]): VsItem<ChatItemData>[] {
    const out: VsItem<ChatItemData>[] = [];
    for (const raw of rawItems) {
      this.live.push(raw);
      out.push({ ...this.shape(raw), boundary: 'newest' }); // shape 填 name（playground makeMockItem 给的 raw 是占位）
    }
    return out;
  }

  destroy(): void {}

  // ---------- 逻辑序列 ----------

  /** full（历史）+ live（WS）拼接，升序（最老→最新）。 */
  private sequence(): VsItem<ChatItemData>[] {
    return [...this.full, ...this.live];
  }

  /** 按 creator 收集 missing → 查 userService 填 profiles（镜像生产 HttpItemSource.ensureProfiles）。 */
  private async ensureProfiles(items: VsItem<ChatItemData>[]): Promise<void> {
    const missing = new Set<number>();
    for (const it of items) if (!this.profiles.has(it.data.creator)) missing.add(it.data.creator);
    if (missing.size === 0) return;
    const res = await firstValueFrom(this.userService.queryUserInfo({ userIds: [...missing] }));
    if (res.code === 0 && res.data) {
      for (const u of res.data) this.profiles.set(u.id, { name: u.uniqName, isSelf: u.id === this.userId });
    }
  }

  /** 整形：克隆 item 去 boundary + 按 creator 从 profiles 填 name/isSelf（镜像生产 toMsgData；fallback '未知'/creator===userId）。 */
  private shape(it: VsItem<ChatItemData>): VsItem<ChatItemData> {
    const p = this.profiles.get(it.data.creator);
    return { id: it.id, data: { ...it.data, name: p?.name ?? '未知', isSelf: p?.isSelf ?? it.data.creator === this.userId } };
  }

  private wait(): Promise<void> {
    return new Promise(r => setTimeout(r, this.latency));
  }
}

// ---------- 数据生产（确定性）----------

const PHRASES = [
  '在吗？', '虚拟滚动内核跑起来了', '你那边列表卡不卡', '我把容器改成了恒定高度',
  'Telegram 那套确实稳', '气泡用的是项目设计 token', '晚上一起复盘下手感', '收到',
  '滚轮惯性还得再调调', '这消息列表能扛几万条了', '你看右边「已挂载节点」', '切数据量它不会涨',
];

/** mulberry32：seeded PRNG，同 seed 同序列 → generate(count) 数据确定性。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pad2(n: number): string { return String(n).padStart(2, '0'); }

function formatTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 假数据占位图：基于 seed 生成渐变 SVG（dataURL），按真实比例 rw×rh 生成，离线稳定、不依赖图床。 */
function placeholderImage(seed: number, rw: number, rh: number): string {
  const h1 = (seed * 53) % 360;
  const h2 = (h1 + 80) % 360;
  // SVG 尺寸按真实比例（长边 400 为基准），让占位图本身比例与数据 w/h 一致 → 行式排版验证才真实。
  const W = rw >= rh ? 400 : Math.round((400 * rw) / rh);
  const H = rh >= rw ? 400 : Math.round((400 * rh) / rw);
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='hsl(${h1},65%,58%)'/><stop offset='1' stop-color='hsl(${h2},55%,40%)'/>` +
    `</linearGradient></defs>` +
    `<rect width='${W}' height='${H}' fill='url(#g)'/>` +
    `<text x='${W / 2}' y='${H / 2 + 12}' font-size='36' fill='rgba(255,255,255,0.85)' text-anchor='middle' font-family='sans-serif'>${(seed % 99) + 1}</text>` +
    `</svg>`;
  // data:image/svg+xml,（标准形式，encodeURIComponent 百分号编码；不带非标的 ;utf8 以保最大兼容）。
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** 相册比例池（横/方/竖，贴近真实手机拍照比例）；seeded 随机选 → 驱动 layoutAlbum 行式排版验证。 */
const RATIOS: ReadonlyArray<[number, number]> = [
  [16, 9],
  [4, 3],
  [1, 1],
  [3, 4],
  [9, 16],
];

/**
 * 生成【恰好 count 条】聊天记录（确定性 seeded）：每轮产 1 条 msg（文本 / 单图 IMAGE），凑满 count 即止。
 * **镜像生产**：相册 = 多条连续单图 IMAGE msg（同 creator，时间相邻），由内核 mergeItems 合并成一个相册 item
 *  （与生产 rawToItems「每条 IMAGE 单图」+ mergeItems 合并同构；不再「单 msg 多图」）。
 * 跨天：每 step 条换一天（只让 createdAtMs 跨天分布；date 分隔由前端 createItem 派生，不在此产生）。
 * 随机切换发送者；高度天然随机（文本长短/相册张数不同）。item.id === data.msgId（id-N），稳定可寻址。
 */
function buildItems(count: number): VsItem<ChatItemData>[] {
  const rand = mulberry32(count * 2654435761); // seed 取 count（Knuth 乘数打散）
  const items: VsItem<ChatItemData>[] = [];
  let lastCreator: number | null = null;
  let minutes = 9 * 60;
  let day = 0;
  let imgSeed = 0;
  let msgSinceDay = 0; // 当天已产 msg 数；达 step 换新一天（让 createdAtMs 跨天分布 → 前端跨日判定才有效）

  const startMs = new Date(2025, 0, 1).getTime();
  const targetDays = Math.max(1, Math.round((Date.now() - startMs) / 86_400_000));
  const step = Math.max(1, Math.round(count / targetDays));

  while (items.length < count) {
    // 每 step 条 msg 换新一天：date 分隔不再由 source 产生，这里只让 msg 的 createdAtMs 跨天分布，
    // 前端 createItem 工厂按跨日判定渲染 date pill（见 message-cards/date-format.ts）。
    if (items.length > 0 && msgSinceDay >= step) {
      day++; msgSinceDay = 0; lastCreator = null;
    }
    let creator: number;
    if (lastCreator === null) creator = rand() < 0.5 ? 1 : 2;
    else if (rand() < 0.35) creator = lastCreator === 1 ? 2 : 1;
    else creator = lastCreator;
    lastCreator = creator;

    if (rand() < 0.12) {
      // 相册：n 条连续单图 IMAGE msg（同 creator），内核 mergeItems 合并成一个相册 item。
      const n = 1 + Math.floor(rand() * 6);
      for (let k = 0; k < n && items.length < count; k++) {
        minutes += 1 + Math.floor(rand() * 4);
        if (minutes >= 24 * 60) minutes -= 24 * 60;
        msgSinceDay++;
        const date = new Date(startMs + day * 86_400_000 + minutes * 60_000);
        const [rw, rh] = RATIOS[Math.floor(rand() * RATIOS.length)];
        const id = `id-${items.length}`;
        const imgs: AlbumImage[] = [{ src: placeholderImage(imgSeed++, rw, rh), w: rw * 100, h: rh * 100, msgId: id }];
        items.push({ id, data: makeSeedMsg(creator, '', 'IMAGE', imgs, date, id) });
      }
    } else {
      minutes += 1 + Math.floor(rand() * 4);
      if (minutes >= 24 * 60) minutes -= 24 * 60;
      msgSinceDay++;
      const date = new Date(startMs + day * 86_400_000 + minutes * 60_000);
      let text = PHRASES[(items.length * 7) % PHRASES.length];
      if (rand() < 0.3) text = `${PHRASES[(items.length * 7) % PHRASES.length]}，${PHRASES[(items.length * 7 + 3) % PHRASES.length]}`;
      const id = `id-${items.length}`;
      items.push({ id, data: makeSeedMsg(creator, text, 'PURE_TEXT', null, date, id) });
    }
  }
  return items;
}

function makeSeedMsg(creator: number, text: string, contentType: ChatMsgData['contentType'], images: AlbumImage[] | null, date: Date, id: string): ChatMsgData {
  // 原始 msg：不带 name/isSelf（占位），由 MockItemSource.shape 按 creator 从 profiles 查填——镜像生产 toMsgData。
  return {
    type: 'msg',
    msgId: id,
    creator,
    isSelf: false,
    name: '',
    text,
    time: formatTime(date),
    contentType,
    images,
    createdAtMs: date.getTime(),
  };
}
