/**
 * HttpItemSource —— 生产数据源，实现 VsSource<ChatItemData>（吸收旧 ChatThreadController）。
 *
 * 拥有 DB 游标分页（oldestMsgId/newestMsgId）+ WS。**只给原始 msg**（不合并相册、不分配展示用
 *  连续抽象 id）——相册合并是展示决策，由内核 `mergeItems` hook 做（per-batch，createItem 前）。
 *  date 分隔也由 createItem 渲染层按相邻消息跨日判定派生（见 message-cards/date-format.ts）。
 *
 * 【游标】getOlder(cursorId,count) 用 lastId 游标向更老分页（desc→升序）、getNewer 向更新（asc 已升序）。
 *  cursorId = 内核窗口边界 item 的 msgId。返回升序原始 msg（VsItem.id = msgId）。
 * 【边界】到 DB 最老（hasMore=false）→ out[0]（升序首位=最老）标 'oldest'；锚点=最新 → out[last] 标 'newest'。
 *  内核 absorbBoundary 读 boundary 设内核 noOlder/noNewer。
 * 【去重】knownMsgIds 防 WS 与分页重复（IO 层，留 source）。
 * 【WS】onWsEvent 收 NEW_MESSAGE → rawToItems → onLive 回调 → 组件调 kernel.appendLive（→ source.appendLive 标 newest）。
 */
import { firstValueFrom, type Subscription } from 'rxjs';
import dayjs from 'dayjs';
import { MsgService } from '../../services/message.service';
import { UserService } from '../../services/user.service';
import { WebsocketService } from '../../services/websocket.service';
import type { StandardMessage } from '../../services/websocket.service';
import type { Message, UserMessageThread } from '../../services/model';
import type { VsItem } from '../../lib/chat-box/chat-box-scroller';
import type { VsSource, VsSourceInitOpts } from '../../lib/chat-box/source';
import type { AlbumImage, ChatItemData, ChatMsgData } from '../message-cards/chat-item';

/** SSE 重连后一次性补拉的最大条数（断线期间漏掉的消息）。超过则需用户滚动加载更早分页。 */
const RECONNECT_REFILL_BATCH = 100;

export interface HttpItemSourceLiveOpts {
  /** WS 新消息回调（组件据此调 kernel.appendLive）。 */
  onLive: (items: VsItem<ChatItemData>[]) => void;
}

export class HttpItemSource implements VsSource<ChatItemData> {
  /** DB 游标（最旧/最新已加载 msgId）。 */
  private oldestMsgId: string | null = null;
  private newestMsgId: string | null = null;
  private noOlder = false;
  private noNewer = true; // 锚点=最新，恒 true（WS 单向推）

  private readonly profiles = new Map<number, { name: string; isSelf: boolean }>();
  private readonly knownMsgIds = new Set<string>();
  private wsSub?: Subscription;
  private reconnectSub?: Subscription;
  private readonly onLive: (items: VsItem<ChatItemData>[]) => void;

  constructor(
    private readonly userMsgTrd: UserMessageThread,
    private readonly msgService: MsgService,
    private readonly userService: UserService,
    wsService: WebsocketService,
    live: HttpItemSourceLiveOpts,
  ) {
    this.onLive = live.onLive;
    this.wsSub = wsService.eventSubject.subscribe((msg) => this.onWsEvent(msg));
    // SSE 重连成功 → 用 newestMsgId 游标补拉断线期间漏掉的消息（SSE 流本身不回放历史）。
    this.reconnectSub = wsService.reconnect$.subscribe(() => { void this.refillNewer(); });
  }

  /**
   * 初始化 / 重锚：
   *  - anchorId === -1：取最新 olderCount 条（desc→升序），锚点=最新（noNewer=true，WS 单向推）。
   *  - 其他（真实 msgId）：双向取——older（desc, skip:0, 含 anchorId）+ newer（asc, skip:1, 不含 anchorId），
   *    合并升序；按各自 hasMore 设 noOlder/noNewer（中段两者皆 false → 向上/下加载可达全局边界）。
   * 返回升序原始 msg，全局最旧/最新带 boundary。
   */
  async init(anchorId: string | number, olderCount: number, newerCount: number, _opts?: VsSourceInitOpts): Promise<VsItem<ChatItemData>[]> {
    if (anchorId === -1) {
      const res = await firstValueFrom(
        this.msgService.queryMessageLog({ userThreadId: this.userMsgTrd.id, skip: 0, take: olderCount, orderBy: 'desc' }),
      );
      if (res.code !== 0 || !res.data) return [];
      const list = [...res.data].reverse(); // desc → 升序（旧→新）
      this.noOlder = !res.hasMore || list.length < olderCount;
      this.noNewer = true; // 锚点=最新
      await this.ensureProfiles(list);
      const items = this.rawToItems(list);
      if (items.length > 0) {
        if (this.noOlder) items[0] = { ...items[0], boundary: 'oldest' };
        items[items.length - 1] = { ...items[items.length - 1], boundary: 'newest' };
        this.oldestMsgId = firstMsgId(items);
        this.newestMsgId = lastMsgId(items);
      }
      return items;
    }
    // 真实 msgId：双向取（跳转到指定消息 / 从通知打开会话）
    const [olderRes, newerRes] = await Promise.all([
      firstValueFrom(this.msgService.queryMessageLog({ userThreadId: this.userMsgTrd.id, skip: 0, take: olderCount, lastId: String(anchorId), orderBy: 'desc' })),
      firstValueFrom(this.msgService.queryMessageLog({ userThreadId: this.userMsgTrd.id, skip: 1, take: newerCount, lastId: String(anchorId), orderBy: 'asc' })),
    ]);
    if (olderRes.code !== 0 || !olderRes.data || olderRes.data.length === 0) return []; // 目标 msgId 不存在
    const older = [...olderRes.data].reverse(); // desc→升序：[older..anchorId]（含 anchorId）
    const newer = newerRes.code === 0 && newerRes.data ? newerRes.data : []; // asc 已升序：(anchorId..newer]
    const list = [...older, ...newer];
    this.noOlder = !olderRes.hasMore;
    this.noNewer = !newerRes.hasMore;
    await this.ensureProfiles(list);
    const items = this.rawToItems(list);
    if (items.length > 0) {
      if (this.noOlder) items[0] = { ...items[0], boundary: 'oldest' };
      if (this.noNewer) items[items.length - 1] = { ...items[items.length - 1], boundary: 'newest' };
      this.oldestMsgId = firstMsgId(items);
      this.newestMsgId = lastMsgId(items);
    }
    return items;
  }

  /** 从 cursorId（msgId）向更老取 count 条（desc→升序）。到 DB 最老 → out[0] 标 'oldest'。 */
  async getOlder(cursorId: string | number, count: number): Promise<VsItem<ChatItemData>[]> {
    if (this.noOlder) return [];
    const res = await firstValueFrom(
      this.msgService.queryMessageLog({ userThreadId: this.userMsgTrd.id, skip: 1, take: count, lastId: String(cursorId), orderBy: 'desc' }),
    );
    if (res.code !== 0 || !res.data || res.data.length === 0) { this.noOlder = true; return []; }
    const list = [...res.data].reverse(); // desc → 升序
    if (!res.hasMore || list.length < count) this.noOlder = true;
    await this.ensureProfiles(list);
    const items = this.rawToItems(list);
    if (items.length === 0) return [];
    if (this.noOlder) items[0] = { ...items[0], boundary: 'oldest' };
    this.oldestMsgId = firstMsgId(items) ?? this.oldestMsgId;
    return items;
  }

  /** 从 cursorId（msgId）向更新取 count 条（asc 已升序）。到 DB 最新 → out[last] 标 'newest'。
   *  生产锚点=最新时 noNewer=true，内核不调；实现以备未来「从中间加载」。 */
  async getNewer(cursorId: string | number, count: number): Promise<VsItem<ChatItemData>[]> {
    if (this.noNewer) return [];
    const res = await firstValueFrom(
      this.msgService.queryMessageLog({ userThreadId: this.userMsgTrd.id, skip: 1, take: count, lastId: String(cursorId), orderBy: 'asc' }),
    );
    if (res.code !== 0 || !res.data || res.data.length === 0) { this.noNewer = true; return []; }
    const list = [...res.data]; // asc 已升序（旧→新）
    if (!res.hasMore || list.length < count) this.noNewer = true;
    await this.ensureProfiles(list);
    const items = this.rawToItems(list);
    if (items.length === 0) return [];
    if (this.noNewer) items[items.length - 1] = { ...items[items.length - 1], boundary: 'newest' };
    this.newestMsgId = lastMsgId(items) ?? this.newestMsgId;
    return items;
  }

  /** WS 新消息：rawToItems 整形后 onLive 通知组件（组件调 kernel.appendLive → source.appendLive 标 newest）。 */
  private onWsEvent(msg: StandardMessage): void {
    if (msg.event !== 'NEW_MESSAGE' || msg.status !== 0 || !msg.data) return;
    const data = msg.data as Message & { threadId: number };
    if (data.threadId !== this.userMsgTrd.threadId) return;
    const id = String(data.id);
    if (this.knownMsgIds.has(id)) return; // 去重
    data.id = id;
    this.ensureProfiles([data]).then(() => {
      const items = this.rawToItems([data]);
      if (items.length > 0) this.onLive(items);
    });
  }

  /** kernel.appendLive 调：给 items 标 boundary:'newest'（id 已是 msgId，由调用方给）。不去重（WS 路径 rawToItems 已去重）。 */
  appendLive(rawItems: VsItem<ChatItemData>[]): VsItem<ChatItemData>[] {
    const out: VsItem<ChatItemData>[] = [];
    for (const raw of rawItems) {
      const id = raw.data.type === 'msg' ? raw.data.msgId : String(raw.id);
      out.push({ ...raw, id, boundary: 'newest' });
    }
    if (out.length > 0) this.newestMsgId = lastMsgId(out) ?? this.newestMsgId;
    return out;
  }

  destroy(): void {
    this.wsSub?.unsubscribe();
    this.wsSub = undefined;
    this.reconnectSub?.unsubscribe();
    this.reconnectSub = undefined;
  }

  /**
   * SSE 重连后补拉：从 newestMsgId 游标向更新取一批（asc），填补断线期间漏掉的消息。
   * 直连 query（绕过 getNewer 的 noNewer 守卫——那是滚动游标态，与一次性补拉无关），
   * 复用 rawToItems 去重 + ensureProfiles + onLive，与 WS 实时路径同口径。
   * 未加载初始消息（newestMsgId==null）时跳过。
   */
  private async refillNewer(): Promise<void> {
    if (this.newestMsgId == null) return;
    const res = await firstValueFrom(
      this.msgService.queryMessageLog({ userThreadId: this.userMsgTrd.id, skip: 1, take: RECONNECT_REFILL_BATCH, lastId: this.newestMsgId, orderBy: 'asc' }),
    );
    if (res.code !== 0 || !res.data || res.data.length === 0) return;
    const list = res.data; // asc 已升序（旧→新）
    if (!res.hasMore) this.noNewer = true; // 追到 DB 最新
    await this.ensureProfiles(list);
    const items = this.rawToItems(list);
    if (items.length > 0) {
      this.newestMsgId = lastMsgId(items) ?? this.newestMsgId;
      this.onLive(items);
    }
  }

  // ---------- rawToItems（原始 msg 整形：去重 + 单 msg 解析；不合并相册——合并归内核 mergeItems） ----------

  private rawToItems(msgs: Message[]): VsItem<ChatItemData>[] {
    const out: VsItem<ChatItemData>[] = [];
    for (const m of msgs) {
      const id = String(m.id);
      if (this.knownMsgIds.has(id)) continue; // IO 去重（防 WS/分页重复）
      this.knownMsgIds.add(id);
      // 每条 IMAGE msg → 单元素 images（自带 msgId）；连续同 creator 的多张由内核 mergeItems 合成相册。
      const images: AlbumImage[] | null = m.contentType === 'IMAGE'
        ? [{ ...parseImageContent(m.content), msgId: id }]
        : null;
      out.push({ id, data: this.toMsgData(m, images) });
    }
    return out;
  }

  private toMsgData(m: Message, images: AlbumImage[] | null): ChatMsgData {
    const p = this.profiles.get(m.creator);
    return {
      type: 'msg', msgId: String(m.id), creator: m.creator,
      isSelf: p?.isSelf ?? m.creator === this.userMsgTrd.userId,
      name: p?.name ?? '未知', text: m.content, time: dayjs(m.createdAt).format('HH:mm'),
      contentType: m.contentType, images, createdAtMs: m.createdAt,
    };
  }

  private async ensureProfiles(msgs: Message[]): Promise<void> {
    const missing = new Set<number>();
    for (const m of msgs) if (!this.profiles.has(m.creator)) missing.add(m.creator);
    if (missing.size === 0) return;
    const res = await firstValueFrom(this.userService.queryUserInfo({ userIds: [...missing] }));
    if (res.code === 0 && res.data) {
      for (const u of res.data) this.profiles.set(u.id, { name: u.uniqName, isSelf: u.id === this.userMsgTrd.userId });
    }
  }
}

// ---------- helper ----------

function parseImageContent(content: string): AlbumImage {
  // w/h 由前端 createImageBitmap 读后随消息存入 content（msg-input-bar 发 JSON{url,w,h}、后端 writeMsgToThread
  // 原样存），生产一定合法 → 删 ||0 让违约显性化。layoutAlbum 的 ratio() 仍对 NaN/0 兜底 4:3（防坏数据毒化 totalH）。
  try {
    const o = JSON.parse(content);
    return { src: String(o.url ?? ''), w: Number(o.w), h: Number(o.h) };
  } catch {
    // malformed JSON 隔离（防单条坏消息崩整个 rawToItems）；w/h=0 由 layoutAlbum fallback 4:3。
    return { src: '', w: 0, h: 0 };
  }
}

/** 区间首个 msg 的 id（source 只返回 msg，首项即首个 msg；守卫防御 + TS narrowing）。 */
function firstMsgId(items: VsItem<ChatItemData>[]): string | null {
  const first = items[0];
  return first && first.data.type === 'msg' ? first.data.msgId : null;
}
/** 区间末个 msg 的 id。 */
function lastMsgId(items: VsItem<ChatItemData>[]): string | null {
  const last = items[items.length - 1];
  return last && last.data.type === 'msg' ? last.data.msgId : null;
}
