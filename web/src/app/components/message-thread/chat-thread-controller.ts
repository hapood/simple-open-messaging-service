import { firstValueFrom, type Subscription } from 'rxjs';
import dayjs from 'dayjs';
import { MsgService } from '../../services/message.service';
import { UserService } from '../../services/user.service';
import { WebsocketService } from '../../services/websocket.service';
import type { StandardMessage } from '../../services/websocket.service';
import type { Message, UserMessageThread } from '../../services/model';
import type { VsItem } from '../../lib/virtual-scroll/virtual-scroller';
import type {
  AlbumImage,
  ChatDateData,
  ChatItemData,
  ChatMsgData,
} from '../message-cards/chat-item';

const INITIAL_TAKE = 30;
const PAGE_TAKE = 20;

/** Controller → 组件的变更通知（组件据此调 scroller.setItems/prependItems/appendItems）。 */
export interface ChatThreadCallbacks {
  /** 首屏数据就绪：组件 scroller.setItems(items) + scrollToBottom。 */
  onReady: (items: VsItem<ChatItemData>[]) => void;
  /** 历史加载完成（更旧一页 prepend）：组件 scroller.prependItems(newItems)。 */
  onPrepended: (newItems: VsItem<ChatItemData>[]) => void;
  /** 新消息 append：组件 scroller.appendItems(newItems)（贴底则 scrollToBottom）。 */
  onAppended: (newItems: VsItem<ChatItemData>[]) => void;
}

/**
 * 单个会话的消息数据层（每会话一个实例，随 MessageThreadComponent 销毁重建；非 root service）。
 *
 * 重写自旧 MsgGroupFactory——不复用其状态机/离屏测量，改为适配虚拟滚动内核：
 *  - 历史加载由组件 onScroll 触发 fetchOlder（异步 HTTP + 回调让组件 prependItems），
 *    不用内核 onLoadMore（同步签名 + 返回 [] 判到头与异步 HTTP 冲突，见计划修正1）。
 *  - WS NEW_MESSAGE 直接用后端推送的完整消息体（serializeBody 后 BigInt→string/Date→ms），
 *    无需二次 query；knownMsgIds 去重（重复推送 / 自发消息 WS 也回推）。
 *  - toItems 不预烤 isShowHead（createItem 渲染时按 prev 算，append 零 reflow）。
 *  - 相邻同发送者 IMAGE 合并为相册；跨天插 date 分隔行。
 *
 * 修复旧组件两 bug：WS 订阅在构造时同步建立（无 constructor 引用未赋值字段的 NPE）；
 * destroy 退订 WS（旧 ngOnDestroy 漏退订 → 切会话泄漏订阅）。
 */
export class ChatThreadController {
  /** 唯一真相：供 scroller 消费 + 组件 createItem 查 prev。 */
  items: VsItem<ChatItemData>[] = [];
  /** 是否还有更早历史（组件 createItem 算首条幽灵 prev 用）。 */
  get hasOlder(): boolean {
    return !this.noOlder;
  }
  /** 已到更早历史尽头。 */
  private noOlder = false;

  private readonly profiles = new Map<number, { name: string; isSelf: boolean }>();
  private readonly knownMsgIds = new Set<string>();
  private oldestMsgId: string | null = null;
  private newestMsgId: string | null = null;
  private loadingOlder = false;
  private wsSub?: Subscription;

  constructor(
    private readonly userMsgTrd: UserMessageThread,
    private readonly msgService: MsgService,
    private readonly userService: UserService,
    wsService: WebsocketService,
    private readonly callbacks: ChatThreadCallbacks,
  ) {
    // 构造时同步订阅（旧组件在 constructor 订阅却引用 ngOnInit 才赋值的 grpFactory → WS 早到 NPE）。
    this.wsSub = wsService.eventSubject.subscribe((msg) => this.onWsEvent(msg));
  }

  /** 首屏：拉最近 INITIAL_TAKE 条（desc），反转为正序，贴底。 */
  async loadInitial(): Promise<void> {
    const res = await firstValueFrom(
      this.msgService.queryMessageLog({
        userThreadId: this.userMsgTrd.id,
        skip: 0,
        take: INITIAL_TAKE,
        orderBy: 'desc',
      }),
    );
    if (res.code !== 0 || !res.data) return;
    const list = [...res.data].reverse(); // desc（新→旧）→ 时间正序（旧→新）
    if (!res.hasMore || list.length < INITIAL_TAKE) this.noOlder = true;
    await this.ensureProfiles(list);
    this.items = this.toItems(list, 'append');
    this.refreshCursors();
    this.callbacks.onReady(this.items);
  }

  /** 历史加载（组件 onScroll 触发）：拉更旧一页（游标 lastId=最旧），prepend。 */
  async fetchOlder(): Promise<void> {
    if (this.noOlder || this.loadingOlder || this.oldestMsgId === null) return;
    this.loadingOlder = true;
    const res = await firstValueFrom(
      this.msgService.queryMessageLog({
        userThreadId: this.userMsgTrd.id,
        skip: 1, // 跳过 cursor 自身（Prisma 游标分页标准写法）
        take: PAGE_TAKE,
        lastId: this.oldestMsgId,
        orderBy: 'desc',
      }),
    );
    this.loadingOlder = false;
    if (res.code !== 0 || !res.data) return;
    const list = [...res.data].reverse();
    if (!res.hasMore || list.length < PAGE_TAKE) this.noOlder = true;
    if (list.length === 0) {
      this.noOlder = true;
      return;
    }
    await this.ensureProfiles(list);
    const newItems = this.toItems(list, 'prepend');
    if (newItems.length === 0) return;
    this.items = [...newItems, ...this.items];
    this.oldestMsgId = firstMsgId(this.items); // 游标前移到新最旧
    this.callbacks.onPrepended(newItems);
  }

  /** WS 事件：仅当前会话 + 未去重 → 直接用完整消息体 append。 */
  private onWsEvent(msg: StandardMessage): void {
    if (msg.event !== 'NEW_MESSAGE' || msg.status !== 0 || !msg.data) return;
    const data = msg.data as Message & { threadId: number };
    if (data.threadId !== this.userMsgTrd.threadId) return;
    const id = String(data.id);
    if (this.knownMsgIds.has(id)) return; // 去重
    data.id = id;
    this.ensureProfiles([data]).then(() => {
      const newItems = this.toItems([data], 'append');
      if (newItems.length === 0) return;
      this.items = [...this.items, ...newItems];
      this.newestMsgId = lastMsgId(this.items);
      this.callbacks.onAppended(newItems);
    });
  }

  /** 收集缺失 creator 批量查 profile（复用现有 user/query 批量接口），填缓存。 */
  private async ensureProfiles(msgs: Message[]): Promise<void> {
    const missing = new Set<number>();
    for (const m of msgs) {
      if (!this.profiles.has(m.creator)) missing.add(m.creator);
    }
    if (missing.size === 0) return;
    const res = await firstValueFrom(
      this.userService.queryUserInfo({ userIds: [...missing] }),
    );
    if (res.code === 0 && res.data) {
      for (const u of res.data) {
        this.profiles.set(u.id, {
          name: u.uniqName,
          isSelf: u.id === this.userMsgTrd.userId,
        });
      }
    }
  }

  /**
   * Message[] → VsItem<ChatItemData>[]：
   *  ① 相邻同发送者 IMAGE 合并为一条相册（Telegram album）；
   *  ② 跨天（相对衔接天）插 date 分隔行；
   *  ③ knownMsgIds 去重；不打 isShowHead（渲染时算）。
   */
  private toItems(msgs: Message[], dir: 'prepend' | 'append'): VsItem<ChatItemData>[] {
    const out: VsItem<ChatItemData>[] = [];
    let prevDayKey = this.refDayKey(dir);
    let i = 0;
    while (i < msgs.length) {
      const m = msgs[i];
      const dayKey = dayjs(m.createdAt).format('YYYY-MM-DD');
      if (dayKey !== prevDayKey) {
        out.push({
          id: `date-${dayKey}`,
          data: { type: 'date', label: formatDateSeparator(m.createdAt), dayKey },
        });
        prevDayKey = dayKey;
      }
      const id = String(m.id);
      if (this.knownMsgIds.has(id)) {
        i++;
        continue;
      }
      this.knownMsgIds.add(id);

      if (m.contentType === 'IMAGE') {
        // 合并后续相邻同发送者 IMAGE → 一个相册 item（用首条 id 作 item id）。
        const images: AlbumImage[] = [parseImageContent(m.content)];
        let j = i + 1;
        while (
          j < msgs.length &&
          msgs[j].contentType === 'IMAGE' &&
          msgs[j].creator === m.creator
        ) {
          const jid = String(msgs[j].id);
          if (this.knownMsgIds.has(jid)) break;
          this.knownMsgIds.add(jid);
          images.push(parseImageContent(msgs[j].content));
          j++;
        }
        out.push({ id, data: this.toMsgData(m, images) });
        i = j;
      } else {
        out.push({ id, data: this.toMsgData(m, null) });
        i++;
      }
    }
    return out;
  }

  private toMsgData(m: Message, images: AlbumImage[] | null): ChatMsgData {
    const p = this.profiles.get(m.creator);
    return {
      type: 'msg',
      msgId: String(m.id),
      creator: m.creator,
      isSelf: p?.isSelf ?? m.creator === this.userMsgTrd.userId,
      name: p?.name ?? '未知',
      text: m.content,
      time: dayjs(m.createdAt).format('HH:mm'),
      contentType: m.contentType,
      images,
      createdAtMs: m.createdAt,
    };
  }

  /** 衔接天：prepend 取旧 items 首条 msg 天，append 取末条 msg 天（避免边界 date 重复/缺失）。 */
  private refDayKey(dir: 'prepend' | 'append'): string | null {
    if (this.items.length === 0) return null;
    const seq = dir === 'prepend' ? this.items : [...this.items].reverse();
    for (const it of seq) {
      if (it.data.type === 'msg') {
        return dayjs(it.data.createdAtMs).format('YYYY-MM-DD');
      }
    }
    return null;
  }

  private refreshCursors(): void {
    this.oldestMsgId = firstMsgId(this.items);
    this.newestMsgId = lastMsgId(this.items);
  }

  destroy(): void {
    this.wsSub?.unsubscribe();
    this.wsSub = undefined;
  }
}

// ---------- 模块级 helper ----------

/** IMAGE 消息 content 约定存 JSON {url, w, h} → 解析为 AlbumImage {src, w, h}。 */
function parseImageContent(content: string): AlbumImage {
  try {
    const o = JSON.parse(content);
    return { src: String(o.url ?? ''), w: Number(o.w) || 0, h: Number(o.h) || 0 };
  } catch {
    return { src: '', w: 0, h: 0 };
  }
}

function firstMsgId(items: VsItem<ChatItemData>[]): string | null {
  for (const it of items) if (it.data.type === 'msg') return it.data.msgId;
  return null;
}
function lastMsgId(items: VsItem<ChatItemData>[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].data.type === 'msg') return (items[i].data as ChatMsgData).msgId;
  }
  return null;
}

/** 日期分隔行文案：今天/昨天/周X/M月D日/YYYY年M月D日。 */
export function formatDateSeparator(ms: number): string {
  const d = dayjs(ms);
  const now = dayjs();
  if (d.isSame(now, 'day')) return '今天';
  if (d.isSame(now.subtract(1, 'day'), 'day')) return '昨天';
  if (d.isAfter(now.subtract(7, 'day'))) return '周' + '日一二三四五六'[d.day()];
  if (d.isSame(now, 'year')) return d.format('M月D日');
  return d.format('YYYY年M月D日');
}
