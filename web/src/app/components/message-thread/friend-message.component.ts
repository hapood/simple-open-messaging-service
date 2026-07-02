import {
  Component,
  effect,
  ElementRef,
  EnvironmentInjector,
  inject,
  input,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import {
  ChatBoxScroller,
  type ScrollerApi,
  type CbElement,
  type CbItem,
  type CbScrollInfo,
} from '../../lib/chat-box/chat-box-scroller';
import { HttpItemSource } from './http-item-source';
import { createMsgCbElement, createGhostCbElement, computeRowFlags } from '../message-cards/create-item';
import { mergeAlbumItems } from '../message-cards/merge-items';
import type { ChatItemData } from '../message-cards/chat-item';
import { MessageHeaderComponent } from '../message-header/message-header.component';
import { MsgInputBarComponent } from '../message-cards/input-bar/msg-input-bar.component';
import { MsgService } from '../../services/message.service';
import { UserService } from '../../services/user.service';
import { WebsocketService } from '../../services/websocket.service';
import type { ConversationItem } from '../../services/model';

/**
 * 消息线程容器（桌面 chat-pane 内联 + 移动 root-popup 弹窗共用本组件）。
 *
 * 渲染核心：虚拟滚动内核 B（ChatBoxScroller 手动补偿，array index）+ HttpItemSource 数据层（msgId 游标 + HTTP 分页 + WS）。
 *  - 内核驱动加载（检查点 getOlder/getNewer），不再组件 onScroll 手动 fetchOlder。
 *  - WS：HttpItemSource 收 NEW_MESSAGE → onLive 回调 → 本组件 scroller.appendLive（→ source 标 newest + 挂载）。
 *  - mergeItems：相册合并在内核（连续同 creator IMAGE），source 只给原始单图 msg。
 *  - createItem(item, prev)：内核传更老邻居 prev，按它算 isShowHead（append 不重渲旧末条）。
 *  - 性能模式：不传 onDebug（生产 ngDevMode DCE 零开销）。
 *
 * zoneless：viewChild 用 effect 初始化（见 zoneless-viewchild-init-effect 记忆）。
 * 切会话（同组件 input 变）：teardown 旧 scroller + 重建。
 */
@Component({
  selector: 'app-message-thread',
  standalone: true,
  imports: [MessageHeaderComponent, MsgInputBarComponent],
  templateUrl: './friend-message.component.html',
  styleUrl: './friend-message.component.scss',
})
export class MessageThreadComponent implements OnDestroy {
  readonly threadId = input<number>();
  readonly startMsgId = input<string>();
  readonly userMsgTrd = input<ConversationItem>();

  private readonly viewportRef = viewChild<ElementRef<HTMLDivElement>>('viewport');
  private readonly contentRef = viewChild<ElementRef<HTMLDivElement>>('content');
  private readonly envInjector = inject(EnvironmentInjector);
  private readonly msgService = inject(MsgService);
  private readonly userService = inject(UserService);
  private readonly wsService = inject(WebsocketService);

  private scroller?: ScrollerApi<ChatItemData>;
  private currentTrdId: number | null = null;
  /** 已以此 id 为锚初始化/跳转过（去重，防 init 锚点又被跳转 effect 重跳）。 */
  private lastJumpId: string | number | null = null;

  readonly atBottom = signal(true);
  readonly stickyDate = signal<string | null>(null);

  constructor() {
    effect(() => {
      const vp = this.viewportRef();
      const ct = this.contentRef();
      const trd = this.userMsgTrd();
      if (!vp || !ct || !trd) return;
      if (this.currentTrdId === trd.id) return;
      this.teardown();
      this.initScroller(vp.nativeElement, ct.nativeElement, trd);
      this.currentTrdId = trd.id;
    });
    // 会话已开后 startMsgId 变化（同 thread，如搜索结果点跳）→ 跳转到该消息（未挂载则内核 re-seed）。
    effect(() => {
      const startId = this.startMsgId();
      const trd = this.userMsgTrd();
      if (!trd || startId === undefined || this.currentTrdId !== trd.id) return;
      if (startId === this.lastJumpId) return; // 已是 init 锚点 / 已跳过
      this.lastJumpId = startId;
      this.scroller?.scrollToIndex(startId, 'center', true);
    });
  }

  private initScroller(viewport: HTMLDivElement, content: HTMLDivElement, trd: ConversationItem): void {
    const startId = this.startMsgId() ?? null; // 开会话时若已带 startMsgId → 开在该消息（重锚）
    this.lastJumpId = startId;
    const source = new HttpItemSource(
      trd, this.userService.sessionProfile()?.id ?? 0, this.msgService, this.userService, this.wsService,
      { onLive: (items) => this.scroller?.appendLive(items) },
    );
    this.scroller = new ChatBoxScroller<ChatItemData>({
      viewport,
      content,
      source,
      hooks: { createItem: (item, prev) => this.createItem(item, prev), mergeItems: mergeAlbumItems },
      onScroll: (info) => this.onScroll(info),
    });
    void this.scroller.init(startId !== null ? { startMsgId: startId, anchor: 'center', highlight: true } : undefined);
  }

  /** 内核 createItem 钩子：内核传更老邻居 prev，按它算分组标，调 createMsgCbElement 包装组件。 */
  private createItem(item: CbItem<ChatItemData>, prev: CbItem<ChatItemData> | null): CbElement<ChatItemData> {
    // 骨架占位：最顶条（prev=null 且未到全局最老）不渲真实组件，固定高度 shimmer（见 createGhostCbElement）。
    if (prev === null && item.boundary !== 'oldest') return createGhostCbElement();
    // 分组标 + date 按 prev 算（computeRowFlags，与 CbElement.update 共用——重排序后 update 按新 prev 重算分组）。
    const { isShowHead, isGroupStart, dateLabel } = computeRowFlags(item, prev);
    return createMsgCbElement(item, isShowHead, isGroupStart, dateLabel, this.envInjector);
  }

  private onScroll(info: CbScrollInfo): void {
    this.atBottom.set(info.atBottom);
    this.updateStickyDate();
  }

  /** Telegram 式粘性日期浮层：取视口顶之上最后一个 date 分隔行文本（DOM 查询，与 playground 同法）。 */
  private updateStickyDate(): void {
    const vp = this.viewportRef()?.nativeElement;
    const ct = this.contentRef()?.nativeElement;
    if (!vp || !ct) { this.stickyDate.set(null); return; }
    const vTop = vp.getBoundingClientRect().top;
    let current: string | null = null;
    for (const d of Array.from(ct.querySelectorAll<HTMLElement>('.pg-date'))) {
      if (d.getBoundingClientRect().top <= vTop + 14) current = d.textContent?.trim() ?? null;
    }
    this.stickyDate.set(current);
  }

  /** 输入栏发送后回调：WS 会推新消息（自发也回推）→ onLive → appendLive 贴底，无需主动拉。 */
  onAfterSent(): void {}

  private teardown(): void {
    this.scroller?.destroy(); // destroy 内部调 source.destroy()（退订 WS）
    this.scroller = undefined;
  }

  ngOnDestroy(): void {
    this.teardown();
  }
}
