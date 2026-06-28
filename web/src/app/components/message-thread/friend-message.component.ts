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
  VirtualScroller,
  type ScrollerApi,
  type VsElement,
  type VsItem,
  type VsScrollInfo,
} from '../../lib/virtual-scroll/virtual-scroller';
import { classifyGroupFlags, type GroupCtx } from '../../lib/virtual-scroll/group-logic';
import { ChatThreadController, formatDateSeparator } from './chat-thread-controller';
import { createMsgVsElement } from '../message-cards/create-item';
import type { ChatItemData, ChatMsgData } from '../message-cards/chat-item';
import { MessageHeaderComponent } from '../message-header/message-header.component';
import { MsgInputBarComponent } from '../message-cards/input-bar/msg-input-bar.component';
import { MsgService } from '../../services/message.service';
import { UserService } from '../../services/user.service';
import { WebsocketService } from '../../services/websocket.service';
import type { UserMessageThread } from '../../services/model';

const TOP_LOAD_TRIGGER = 200; // 滚到距顶 200px 内 + 已挂载到顶 → 触发历史加载

/**
 * 消息线程容器（桌面 chat-pane 内联 + 移动 root-popup 弹窗共用本组件）。
 *
 * 渲染核心已替换为虚拟滚动内核 B（VirtualScroller 手动补偿）：
 *  - 数据层委托 ChatThreadController（游标分页 / WS / 资料 / 分组）。
 *  - 历史加载由 onScroll 检测「已挂载到顶 + 贴顶」触发 controller.fetchOlder，
 *    完成后回调 scroller.prependItems（异步 HTTP，不用内核同步 onLoadMore）。
 *  - createItem 用 classifyGroupFlags 按上一条算 isShowHead（append 不重渲旧末条）。
 *  - 性能模式：不传 onDebug（生产 ngDevMode DCE 零开销）。
 *
 * zoneless：viewChild 用 effect 初始化（ngAfterViewInit 可能不触发，见 zoneless-viewchild-init-effect 记忆）。
 * 切会话（同组件 input 变）：teardown 旧 scroller/controller + 重建（chat-pane @if 不销毁同实例）。
 */
@Component({
  selector: 'app-message-thread',
  standalone: true,
  imports: [MessageHeaderComponent, MsgInputBarComponent],
  templateUrl: './friend-message.component.html',
  styleUrl: './friend-message.component.scss',
})
export class MessageThreadComponent implements OnDestroy {
  readonly userThreadId = input<number>();
  readonly startMsgId = input<string>();
  readonly userMsgTrd = input<UserMessageThread>();

  private readonly viewportRef = viewChild<ElementRef<HTMLDivElement>>('viewport');
  private readonly contentRef = viewChild<ElementRef<HTMLDivElement>>('content');
  private readonly topSentinelRef = viewChild<ElementRef<HTMLDivElement>>('topSentinel');
  private readonly envInjector = inject(EnvironmentInjector);
  private readonly msgService = inject(MsgService);
  private readonly userService = inject(UserService);
  private readonly wsService = inject(WebsocketService);

  private scroller?: ScrollerApi<ChatItemData>;
  private controller?: ChatThreadController;
  private currentTrdId: number | null = null;

  readonly atBottom = signal(true);
  readonly stickyDate = signal<string | null>(null);

  constructor() {
    // viewChild signal 解析后初始化（首次）；userMsgTrd 变化（切会话）时 teardown + 重建。
    effect(() => {
      const vp = this.viewportRef();
      const ct = this.contentRef();
      const ts = this.topSentinelRef();
      const trd = this.userMsgTrd();
      if (!vp || !ct || !ts || !trd) return;
      if (this.currentTrdId === trd.id) return; // 同会话已初始化
      this.teardown();
      this.initScroller(vp.nativeElement, ct.nativeElement, ts.nativeElement, trd);
      this.currentTrdId = trd.id;
    });
  }

  private initScroller(
    viewport: HTMLDivElement,
    content: HTMLDivElement,
    topSentinel: HTMLDivElement,
    trd: UserMessageThread,
  ): void {
    const controller = new ChatThreadController(
      trd,
      this.msgService,
      this.userService,
      this.wsService,
      {
        onReady: (items) => {
          this.scroller!.setItems(items);
          this.scroller!.scrollToBottom();
          this.updateStickyDate();
        },
        onPrepended: (newItems) => {
          this.scroller!.prependItems(newItems);
        },
        onAppended: (newItems) => {
          // appendItems 内核已按 wasAtBottom 决定挂载；贴底再 scrollToBottom 保险。
          this.scroller!.appendItems(newItems);
          if (this.atBottom()) this.scroller!.scrollToBottom();
        },
      },
    );
    this.controller = controller;
    // 内核 B（手动补偿）。不传 onLoadMore（异步 HTTP 走 onScroll）、不传 onDebug（性能模式）。
    this.scroller = new VirtualScroller<ChatItemData>({
      viewport,
      content,
      topSentinel,
      hooks: { createItem: (item, index) => this.createItem(item, index) },
      onScroll: (info) => this.onScroll(info),
    });
    controller.loadInitial();
  }

  /** 内核 createItem 钩子：按上一条算分组标，调 createMsgVsElement 包装组件。 */
  private createItem(item: VsItem<ChatItemData>, index: number): VsElement<ChatItemData> {
    let isShowHead = true;
    let isGroupStart = false;
    const data = item.data;
    if (data.type === 'msg') {
      const curCtx: GroupCtx = { creator: data.creator };
      const prevItem = index > 0 ? this.controller!.items[index - 1] : null;
      const prevMsg =
        prevItem?.data.type === 'msg' ? (prevItem.data as ChatMsgData) : null;
      let prevCtx: GroupCtx | null;
      if (prevMsg) {
        prevCtx = { creator: prevMsg.creator };
      } else if (index === 0 && this.controller!.hasOlder) {
        // 幽灵 prev：还有更早历史 → 假设更早末条与本条同 sender（暂不显头像，prepend 后修正）。
        prevCtx = { creator: data.creator };
      } else {
        prevCtx = null; // 真·首条 → 显头像
      }
      isShowHead = classifyGroupFlags(prevCtx, curCtx, null).isShowHead;
      isGroupStart = isShowHead && !!prevMsg; // 换发送者的新组首加组间留白
    }
    return createMsgVsElement(item, isShowHead, isGroupStart, this.envInjector);
  }

  private onScroll(info: VsScrollInfo): void {
    this.atBottom.set(info.atBottom);
    // 历史加载：已挂载到顶（mountedStart===0）+ 滚到顶附近 → 异步拉更旧（完成后 controller 回调 prependItems）。
    if (info.mountedStart === 0 && info.scrollTop < TOP_LOAD_TRIGGER) {
      this.controller?.fetchOlder();
    }
    this.updateStickyDate();
  }

  /** 粘性日期浮层：取挂载区间首条 msg 的天（近似视口顶部日期）。 */
  private updateStickyDate(): void {
    if (!this.scroller || !this.controller) return;
    const info = this.scroller.getInfo();
    const items = this.controller.items;
    for (let i = info.mountedStart; i < info.mountedEnd && i < items.length; i++) {
      const d = items[i].data;
      if (d.type === 'msg') {
        this.stickyDate.set(formatDateSeparator(d.createdAtMs));
        return;
      }
    }
  }

  /** 输入栏发送后回调：WS 会推新消息（自发消息也回推）→ onAppended 处理贴底，无需主动拉。 */
  onAfterSent(): void {}

  private teardown(): void {
    this.scroller?.destroy();
    this.scroller = undefined;
    this.controller?.destroy();
    this.controller = undefined;
  }

  ngOnDestroy(): void {
    this.teardown();
  }
}
