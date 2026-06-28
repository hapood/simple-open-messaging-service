import {
  Component, ElementRef, OnDestroy, inject, isDevMode,
  signal, viewChild, effect, ChangeDetectionStrategy, ViewEncapsulation,
  EnvironmentInjector,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { VirtualScroller, ScrollerApi, VsElement, VsItem, VsOptions, VsScrollInfo, VsDebugStats } from '../../lib/virtual-scroll/virtual-scroller';
import { VirtualScrollerAnchor } from '../../lib/virtual-scroll/virtual-scroller-anchor';
import { ActivatedRoute } from '@angular/router';
import { classifyGroupFlags, GroupCtx } from '../../lib/virtual-scroll/group-logic';
import { LayoutService } from '../../services/layout.service';
import { createMsgVsElement } from '../../components/message-cards/create-item';
import type { AlbumImage, ChatItemData, ChatMsgData } from '../../components/message-cards/chat-item';

type HeightMode = 'uniform' | 'random' | 'extreme';

/**
 * 虚拟滚动实验场。
 *
 * 渲染与真实聊天完全一致——createItem 调 createMsgVsElement（真实 message-cards 组件），
 * 数据/行为全 mock（不发 HTTP、不依赖登录/后端）：发消息、对方回复、附件发图、历史加载
 * 均用本地假数据。用于验收内核手感、虚拟化稳定性、高度变化与真实组件的契合。
 *
 * 数据类型用真实 ChatItemData（与 ChatThreadController 同构），保证 mock 与生产行为一致。
 */
@Component({
  selector: 'app-virtual-scroll-playground',
  imports: [FormsModule],
  templateUrl: './virtual-scroll-playground.component.html',
  styleUrl: './virtual-scroll-playground.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // 容器/面板/输入栏样式仍全局 pg-（None）；消息行样式由真实组件 _row-base（Emulated scoped）提供。
  encapsulation: ViewEncapsulation.None,
})
export class VirtualScrollPlaygroundComponent implements OnDestroy {
  private readonly layout = inject(LayoutService);
  private readonly route = inject(ActivatedRoute);
  /** 动态创建消息组件（zoneless 下 createComponent + detectChanges 驱动渲染）。 */
  private readonly envInjector = inject(EnvironmentInjector);
  /** 方案 A（借浏览器锚定）由路由 data.useNativeAnchor 决定：-b 路由为 true，其余走方案 B（手动补偿）。 */
  readonly useNativeAnchor = (this.route.snapshot.data as { useNativeAnchor?: boolean }).useNativeAnchor === true;
  /** 桌面级视口(宽屏+精确指针)：true=常驻侧栏；false=移动抽屉+FAB。 */
  readonly isDesktop = this.layout.isDesktop;
  /** 移动端控制面板抽屉开关。 */
  readonly panelOpen = signal(false);
  /** 输入栏为避让软键盘上移的像素（visualViewport 计算，iOS 兜底）。 */
  readonly keyboardOffset = signal(0);

  private readonly viewportRef = viewChild<ElementRef<HTMLDivElement>>('viewport');
  private readonly contentRef = viewChild<ElementRef<HTMLDivElement>>('content');
  private readonly topSentinelRef = viewChild<ElementRef<HTMLDivElement>>('topSentinel');
  private readonly fabRef = viewChild<ElementRef<HTMLButtonElement>>('fab');
  private readonly pgStageRef = viewChild<ElementRef<HTMLDivElement>>('pgStage');
  private readonly draftInput = viewChild<ElementRef<HTMLTextAreaElement>>('draftInput');
  private readonly inputBarRef = viewChild<ElementRef<HTMLFormElement>>('inputBar');
  private readonly attachInput = viewChild<ElementRef<HTMLInputElement>>('attachInput');

  private scroller?: ScrollerApi<ChatItemData>;

  // 状态读数（节流更新）
  readonly scrollTop = signal(0);
  readonly totalHeight = signal(0);
  readonly mountedCount = signal(0);
  readonly mountedFirst = signal(-1);
  readonly mountedLast = signal(-1);
  readonly atTop = signal(true);
  readonly atBottom = signal(true); // 是否贴底（收到新消息时决定是否跟随滚动）
  readonly cacheCount = signal(0);
  /** 调试模式：开读数/角标/日志；性能模式全关。dev 页面默认开调试（验收手感时手动切性能）。 */
  readonly debugMode = signal(true);
  /** 最近一帧 balance 诊断（onDebug 上报，渲染到侧栏读数）。 */
  readonly balanceStats = signal<VsDebugStats | null>(null);
  /** Telegram 式粘性日期：当前视口顶所属日期标签（滚动实时更新；null=不显浮层）。 */
  readonly stickyDate = signal<string | null>(null);
  /** 主题：light / dark。默认跟随系统 prefers-color-scheme，可手动 toggle 临时覆盖（系统变化时再跟随）。 */
  readonly theme = signal<'light' | 'dark'>('light');
  private themeMqCleanup: (() => void) | null = null;
  toggleTheme() { this.theme.update(t => t === 'light' ? 'dark' : 'light'); }

  // 控件
  readonly count = signal(5000);
  readonly mode = signal<HeightMode>('random');
  readonly draft = signal(''); // 输入栏草稿
  readonly emojiOpen = signal(false); // emoji 面板开关
  /** 输入栏实测高度（auto-grow 后更新），驱动 .pg-viewport bottom 紧贴输入栏上沿（多行不遮挡）。 */
  readonly inputBarHeight = signal(63);
  /** emoji 面板候选（模板访问，故为实例属性）。 */
  readonly EMOJIS = ['😀','😂','🥰','😎','😭','😡','👍','🙏','👏','🔥','🎉','❤️','💯','🤔','😴','🤯','😅','🥳','😱','🤗','😇','🙃','😋','😘','🤩','😜','🤪','😏','😬','🤤','😪','🥱'];

  constructor() {
    // 跟随系统深浅色：初始化 + 监听变化（matchMedia）。手动 toggle 仍可临时覆盖。
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (mq) {
      const apply = () => this.theme.set(mq.matches ? 'dark' : 'light');
      apply();
      mq.addEventListener('change', apply);
      this.themeMqCleanup = () => mq.removeEventListener('change', apply);
    }
  }

  togglePanel() { this.panelOpen.update(v => !v); }
  closePanel() { this.panelOpen.set(false); }

  // FAB：拖动重定位，松手吸附最近水平边缘；未越过阈值则视为点击开关面板。
  onFabDown(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // 鼠标非左键不处理
    const fab = this.fabRef()?.nativeElement;
    if (!fab) return;
    e.preventDefault();
    const rect = fab.getBoundingClientRect();
    this.fabStartX = e.clientX;
    this.fabStartY = e.clientY;
    this.fabStartLeft = rect.left;
    this.fabStartTop = rect.top;
    this.fabMoved = false;
    // 由 right/bottom 切到 left/top，以便自由定位
    fab.style.left = `${rect.left}px`;
    fab.style.top = `${rect.top}px`;
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
    fab.classList.add('pg-fab-dragging');
    this.fabDragging = true;
    window.addEventListener('pointermove', this.onFabMove);
    window.addEventListener('pointerup', this.onFabUp);
  }

  private onFabMove = (e: PointerEvent) => {
    if (!this.fabDragging) return;
    const fab = this.fabRef()?.nativeElement;
    if (!fab) return;
    const dx = e.clientX - this.fabStartX;
    const dy = e.clientY - this.fabStartY;
    if (!this.fabMoved && Math.hypot(dx, dy) < 5) return; // 起判阈值，保护点击
    this.fabMoved = true;
    const w = fab.offsetWidth, h = fab.offsetHeight;
    // 边界 clamp：整个按钮留在视口内，留 8px 边距
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, this.fabStartLeft + dx));
    const top = Math.max(8, Math.min(window.innerHeight - h - 8, this.fabStartTop + dy));
    fab.style.left = `${left}px`;
    fab.style.top = `${top}px`;
  };

  private onFabUp = (e: PointerEvent) => {
    window.removeEventListener('pointermove', this.onFabMove);
    window.removeEventListener('pointerup', this.onFabUp);
    const fab = this.fabRef()?.nativeElement;
    fab?.classList.remove('pg-fab-dragging');
    const wasMoved = this.fabMoved;
    this.fabDragging = false;
    this.fabMoved = false;
    if (!wasMoved) { this.togglePanel(); return; } // 点击 → 开关面板
    // 拖动结束：吸附到最近水平边缘（垂直位置保持）
    if (fab) {
      const targetLeft = e.clientX < window.innerWidth / 2 ? 16 : window.innerWidth - fab.offsetWidth - 16;
      fab.style.left = `${targetLeft}px`;
    }
  };

  private lastEmit = 0;
  private items: VsItem<ChatItemData>[] = []; // 当前列表（发送时向末尾追加）
  /** 是否还有更早历史。false=已到尽头，items[0] 是真·第一条对话（无需 ghost 判组首）。 */
  private hasOlder = true;
  /** items[0] 的前一条 creator（幽灵 prev）：hasOlder=true 时用于判 items[0] 是否组首；尽头时 null。 */
  private topGhostCreator: number | null = null;
  private histSeq = 0; // 下拉加载历史时的 id 序号，避免与现有 id 冲突
  private histLoads = 0; // onLoadMore 已加载批数（封顶后返回 null，模拟"无更早历史"）
  /** 自发消息 id 序号（send/reply/media 各自独立，避免与 buildItems 的数字 id 冲突）。 */
  private sendSeq = 0;

  // FAB 拖动状态
  private fabDragging = false;
  private fabMoved = false;
  private fabStartX = 0;
  private fabStartY = 0;
  private fabStartLeft = 0;
  private fabStartTop = 0;

  private static readonly PHRASES = [
    '在吗？',
    '虚拟滚动内核跑起来了',
    '你那边列表卡不卡',
    '我把容器改成了恒定高度',
    'Telegram 那套确实稳',
    '气泡用的是项目设计 token',
    '晚上一起复盘下手感',
    '收到',
    '滚轮惯性还得再调调',
    '这消息列表能扛几万条了',
    '你看右边「已挂载节点」',
    '切数据量它不会涨',
  ];
  /** 周几中文（getDay: 0=周日）。日期分隔「本周」分级用。 */
  private static readonly WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  // zoneless + signal viewChild：ngAfterViewInit 可能不触发，改用 effect——
  // viewChild signal 解析后 effect 必跑，初始化 scroller（只一次）。
  private readonly initScroller = effect(() => {
    const vp = this.viewportRef();
    const ct = this.contentRef();
    const ts = this.topSentinelRef();
    if (!vp || !ct || this.scroller) return;
    try {
      // 据路由 data 选内核实现：方案 A（借浏览器锚定）或方案 B（手动补偿），两者同构 ScrollerApi。
      const Ctor: new (opts: VsOptions<ChatItemData>) => ScrollerApi<ChatItemData> =
        this.useNativeAnchor ? VirtualScrollerAnchor : VirtualScroller;
      const scroller = new Ctor({
        viewport: vp.nativeElement,
        content: ct.nativeElement,
        topSentinel: ts?.nativeElement,
        hooks: {
          createItem: (item, index) => this.createItemEl(item, index),
        },
        onLoadMore: () => this.fetchOlder(),
        onScroll: (info) => this.onScroll(info),
        onDebug: isDevMode() ? (s) => this.onBalanceDebug(s) : undefined,
      });
      this.scroller = scroller;
      this.regenerate();
      scroller.refresh();
      scroller.scrollToBottom(); // 聊天默认贴底（看最新消息）
    } catch (e) {
      console.error('[playground] scroller init failed:', e);
    }
  });

  ngOnDestroy() {
    this.scroller?.destroy();
    this.themeMqCleanup?.();
    window.removeEventListener('pointermove', this.onFabMove);
    window.removeEventListener('pointerup', this.onFabUp);
  }

  // 移动端键盘贴合（业界 Telegram 式）：用 visualViewport 算键盘遮挡高度，把输入栏上移。
  private readonly trackKeyboard = effect((onCleanup) => {
    const stage = this.pgStageRef();
    const vv = window.visualViewport;
    if (!stage || this.isDesktop() || !vv) { this.keyboardOffset.set(0); return; }
    const el = stage.nativeElement;
    const update = () => this.keyboardOffset.set(Math.max(0, el.clientHeight - vv.height - vv.offsetTop));
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    onCleanup(() => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); });
  });

  // --- 内核 hooks ---

  private createItemEl(item: VsItem<ChatItemData>, index: number): VsElement<ChatItemData> {
    // 分组判定在渲染时按【上一条】算（不预烤进 data）：间距/圆角只依赖"是否组首"，
    // 与下一条无关 → 追加新条时原末条高度不变、无需重渲（0 reflow）。
    // 用真实组件渲染（createMsgVsElement），与生产 MessageThreadComponent 完全一致。
    let isShowHead = true, isGroupStart = false;
    if (item.data.type === 'msg') {
      const curCtx: GroupCtx = { creator: item.data.creator };
      const prevItem = index > 0 ? this.items[index - 1] : null;
      const prevMsg = prevItem?.data.type === 'msg' ? prevItem.data : null;
      let prevCtx: GroupCtx | null;
      if (prevMsg) {
        prevCtx = { creator: prevMsg.creator };
      } else if (index === 0 && this.hasOlder && this.topGhostCreator !== null) {
        prevCtx = { creator: this.topGhostCreator };
      } else {
        prevCtx = null;
      }
      isShowHead = classifyGroupFlags(prevCtx, curCtx, null).isShowHead;
      isGroupStart = isShowHead && !!prevMsg;
    }
    return createMsgVsElement(item, isShowHead, isGroupStart, this.envInjector);
  }

  /** onDebug 回调：更新 balanceStats（渲染到侧栏读数）。 */
  private onBalanceDebug(s: VsDebugStats) {
    this.balanceStats.set(s);
  }

  private onScroll(info: VsScrollInfo) {
    this.atBottom.set(info.atBottom);
    this.updateStickyDate();
    if (!isDevMode() || !this.debugMode()) return;
    const now = performance.now();
    if (now - this.lastEmit < 100) return; // 读数节流
    this.lastEmit = now;
    this.scrollTop.set(info.scrollTop);
    this.totalHeight.set(info.scrollHeight);
    this.mountedCount.set(info.mounted);
    this.mountedFirst.set(info.mountedStart);
    this.mountedLast.set(info.mountedEnd - 1);
    this.atTop.set(info.atTop);
    this.cacheCount.set(info.total);
  }

  /**
   * Telegram 式粘性日期：取视口顶之上最后一个 date 分隔行的文本。
   * 浮层独立于 content、不受虚拟滚动回收——视口顶附近的 date 必落在挂载窗口内。
   * date 行现由真实 DateRowComponent 渲染（.pg-date class 仍在），querySelectorAll 仍可查。
   */
  private updateStickyDate() {
    const vp = this.viewportRef()?.nativeElement;
    const ct = this.contentRef()?.nativeElement;
    if (!vp || !ct) { this.stickyDate.set(null); return; }
    const vTop = vp.getBoundingClientRect().top;
    const fadeHi = vTop + 60;
    const fadeLo = vTop + 14;
    const rects = Array.from(ct.querySelectorAll<HTMLElement>('.pg-date'))
      .map(d => ({ d, top: d.getBoundingClientRect().top }));
    let current: string | null = null;
    for (const { d, top } of rects) {
      if (top <= fadeLo) current = d.textContent?.trim() ?? null;
    }
    this.stickyDate.set(current);
    const hasFloat = current !== null;
    for (const { d, top } of rects) {
      const op = hasFloat && top <= fadeHi
        ? Math.max(0, Math.min(1, (top - fadeLo) / (fadeHi - fadeLo)))
        : 1;
      d.style.opacity = op.toFixed(2);
    }
  }

  // --- 控件 ---

  setCount(n: number) { this.count.set(n); this.regenerate(); }
  setMode(m: HeightMode) { this.mode.set(m); this.regenerate(); }

  regenerate() {
    this.items = this.buildItems(this.count(), this.mode());
    this.histLoads = 0;
    this.hasOlder = true;
    this.topGhostCreator = this.randomCreator();
    this.scroller?.setItems(this.items);
  }

  /**
   * onLoadMore 回调：生成更早的假历史。兑现幽灵衔接不变量（批次末条 creator=旧 topGhost），
   * 使 prepend 后旧 items[0] 分组不变 → 内核无需重渲。封顶批预置尽头（hasOlder=false/topGhost=null）。
   */
  private fetchOlder(): VsItem<ChatItemData>[] | null {
    if (!this.hasOlder) return null;
    this.histLoads++;
    const more = this.buildItems(50, this.mode());
    this.forceLastCreator(more, this.topGhostCreator);
    const seq = this.histSeq++;
    more.forEach((it, i) => { it.id = `hist-${seq}-${i}`; });
    if (this.histLoads >= 20) {
      this.hasOlder = false;
      this.topGhostCreator = null;
    } else {
      this.topGhostCreator = this.randomCreator();
    }
    return more;
  }

  /** 随机一个 creator（1=self / 2=other），用作幽灵 prev 的预言值。 */
  private randomCreator(): number { return Math.random() < 0.5 ? 1 : 2; }

  /** 强制批次【末条】消息 creator 匹配（1=self/2=other），兑现幽灵衔接不变量。 */
  private forceLastCreator(items: VsItem<ChatItemData>[], creator: number | null) {
    if (creator == null) return;
    for (let i = items.length - 1; i >= 0; i--) {
      const d = items[i].data;
      if (d.type === 'msg') { d.creator = creator; d.isSelf = creator === 1; return; }
    }
  }

  /** 模拟下拉加载：在头部插入历史消息，验证 prepend 的锚点保持（视觉不跳）。 */
  loadMoreHistory() {
    if (!this.scroller) return;
    const more = this.buildItems(100, this.mode());
    const seq = this.histSeq++;
    more.forEach((it, i) => { it.id = `hist-${seq}-${i}`; });
    this.items = [...more, ...this.items];
    this.scroller.prependItems(more);
  }

  toTop() { this.scroller?.scrollToTop(); }
  toBottom() { this.scroller?.scrollToBottom(); }

  // 输入栏：Enter 发送、Shift+Enter 换行
  onInputKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.send();
    }
  }

  toggleEmoji() { this.emojiOpen.update(v => !v); }

  /** emoji 插入到 textarea 光标处（无光标则追加），并恢复光标到插入点之后。 */
  insertEmoji(e: string) {
    const ta = this.draftInput()?.nativeElement;
    const cur = this.draft();
    const start = ta?.selectionStart ?? cur.length;
    const end = ta?.selectionEnd ?? cur.length;
    this.draft.set(cur.slice(0, start) + e + cur.slice(end));
    this.autoGrow();
    Promise.resolve().then(() => {
      const t = this.draftInput()?.nativeElement;
      if (t) { t.focus(); const pos = start + e.length; t.setSelectionRange(pos, pos); }
    });
  }

  onDraftChange(v: string) { this.draft.set(v); this.autoGrow(); }

  /** 发送键：有文字 → 发文字；无文字 → 唤起附件选图（WhatsApp 相机入口同义）。 */
  onSendClick() {
    if (this.draft().trim()) this.send();
    else this.onAttachClick();
  }

  onAttachClick() { this.attachInput()?.nativeElement.click(); }

  onAttachChange(e: Event) {
    const input = e.target as HTMLInputElement;
    this.sendMediaFromFile(input.files);
    input.value = '';
  }

  /** textarea auto-grow：1~6 行自适应撑高，超过内部滚动；同步输入栏高度给 viewport bottom。 */
  private autoGrow() {
    const ta = this.draftInput()?.nativeElement;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
    }
    requestAnimationFrame(() => {
      const bar = this.inputBarRef()?.nativeElement;
      if (bar) this.inputBarHeight.set(bar.offsetHeight);
    });
  }

  /** mock 发送文本：构造一条 self 的 PURE_TEXT 消息 append 到末尾并贴底（不发 HTTP）。 */
  send() {
    const text = this.draft().trim();
    if (!text || !this.scroller) return;
    const item = this.mockMsg(text, true);
    this.items.push(item);
    this.scroller.appendItems([item]);
    this.scroller.scrollToBottom();
    this.draft.set('');
    this.autoGrow();
    // 模拟对方延迟回复（验证收消息 appendItems + 贴底跟随）
    setTimeout(() => this.receiveReply(), 600 + Math.floor(Math.random() * 1200));
  }

  /** 模拟对方回复：阿黄随机回一条；用户当时贴底则跟随滚到底，否则不打扰。 */
  private receiveReply() {
    const scroller = this.scroller;
    if (!scroller) return;
    const wasAtBottom = this.atBottom();
    const phrases = VirtualScrollPlaygroundComponent.PHRASES;
    const text = phrases[Math.floor(Math.random() * phrases.length)];
    const item = this.mockMsg(text, false);
    this.items.push(item);
    scroller.appendItems([item]);
    if (wasAtBottom) scroller.scrollToBottom();
  }

  /** 构造一条 mock ChatMsgData（PURE_TEXT）。creator：self=1 / other=2（与真实 controller 同构）。 */
  private mockMsg(text: string, isSelf: boolean): VsItem<ChatItemData> {
    const now = new Date();
    const data: ChatMsgData = {
      type: 'msg',
      msgId: `mock-${this.sendSeq++}`,
      creator: isSelf ? 1 : 2,
      isSelf,
      name: isSelf ? '我' : '阿黄',
      text,
      time: this.formatTime(now),
      contentType: 'PURE_TEXT',
      images: null,
      createdAtMs: now.getTime(),
    };
    return { id: data.msgId, data };
  }

  /**
   * mock 发送图片：本地读图为 dataURL + 真实尺寸，构造一条 self 的 IMAGE 相册 append（不发 upload/sendMessage）。
   * 多图合并为一条相册（Telegram album），与真实 sendImage 的「连续 IMAGE 前端合并」语义一致。
   */
  sendMediaFromFile(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (list.length === 0) return;
    const imgs: AlbumImage[] = [];
    let pending = list.length;
    const done = () => {
      if (--pending === 0) this.appendAlbum(imgs);
    };
    for (const f of list) {
      const reader = new FileReader();
      reader.onload = () => {
        const src = typeof reader.result === 'string' ? reader.result : '';
        if (!src) { done(); return; }
        const probe = new Image();
        probe.onload = () => { imgs.push({ src, w: probe.naturalWidth || 400, h: probe.naturalHeight || 300 }); done(); };
        probe.onerror = () => { imgs.push({ src, w: 400, h: 300 }); done(); };
        probe.src = src;
      };
      reader.readAsDataURL(f);
    }
  }

  /** 把一批图作为 self 的 IMAGE 相册 append 并贴底。 */
  private appendAlbum(imgs: AlbumImage[]) {
    const scroller = this.scroller;
    if (!scroller || imgs.length === 0) return;
    const now = new Date();
    const msgId = `media-${this.sendSeq++}`;
    const data: ChatMsgData = {
      type: 'msg',
      msgId,
      creator: 1,
      isSelf: true,
      name: '我',
      text: '',
      time: this.formatTime(now),
      contentType: 'IMAGE',
      images: imgs,
      createdAtMs: now.getTime(),
    };
    const item: VsItem<ChatItemData> = { id: msgId, data };
    this.items.push(item);
    scroller.appendItems([item]);
    scroller.scrollToBottom();
  }

  // —— 时间 / 日期格式化（与真实 chat-thread-controller 同口径）——
  private formatTime(d: Date): string {
    return `${this.pad2(d.getHours())}:${this.pad2(d.getMinutes())}`;
  }
  private formatDateSeparator(d: Date, now: Date): string {
    const dayMs = 86_400_000;
    const diff = Math.floor(this.midnight(now) / dayMs) - Math.floor(this.midnight(d) / dayMs);
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff >= 2 && diff <= 6) return `周${VirtualScrollPlaygroundComponent.WEEK[d.getDay()]}`;
    const md = `${d.getMonth() + 1}月${d.getDate()}日`;
    return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`;
  }
  private midnight(d: Date): number {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  private pad2(n: number): string { return String(n).padStart(2, '0'); }

  private buildItems(n: number, mode: HeightMode): VsItem<ChatItemData>[] {
    type Raw =
      | { kind: 'msg'; isSelf: boolean; text: string; day: number; minutes: number }
      | { kind: 'media'; isSelf: boolean; day: number; minutes: number }
      | { kind: 'date'; day: number };
    const phrases = VirtualScrollPlaygroundComponent.PHRASES;
    const raw: Raw[] = [];
    let lastSelf: boolean | null = null;
    let minutes = 9 * 60;
    let day = 0;
    let mediaBatch = 0;

    const startMs = new Date(2025, 0, 1).getTime();
    const now = new Date();
    const targetDays = Math.max(1, Math.round((now.getTime() - startMs) / 86_400_000));
    const step = Math.max(1, Math.round(n / targetDays));

    for (let i = 0; i < n; i++) {
      if (i > 0 && i % step === 0) {
        day++;
        raw.push({ kind: 'date', day });
        lastSelf = null;
        mediaBatch = 0;
      }
      let isSelf: boolean;
      if (lastSelf === null) isSelf = Math.random() < 0.5;
      else if (Math.random() < 0.35) isSelf = !lastSelf;
      else isSelf = lastSelf;
      lastSelf = isSelf;

      minutes += 1 + Math.floor(Math.random() * 4);
      if (minutes >= 24 * 60) minutes -= 24 * 60;

      if (mediaBatch > 0) {
        raw.push({ kind: 'media', isSelf, day, minutes });
        mediaBatch--;
        continue;
      }
      if (Math.random() < 0.12) {
        mediaBatch = 1 + Math.floor(Math.random() * 5);
        raw.push({ kind: 'media', isSelf, day, minutes });
        continue;
      }

      let text = phrases[(i * 7) % phrases.length];
      if (mode === 'extreme' && Math.random() < 0.08) {
        text = Array.from({ length: 6 + Math.floor(Math.random() * 8) },
          (_, k) => phrases[(i + k) % phrases.length]).join('，');
      } else if (mode === 'random' && Math.random() < 0.3) {
        text = `${phrases[(i * 7) % phrases.length]}，${phrases[(i * 7 + 3) % phrases.length]}`;
      }
      raw.push({ kind: 'msg', isSelf, text, day, minutes });
    }

    // 第二遍：连续同发送者 media 聚合为一个相册；msg → ChatMsgData。分组不预烤（渲染时算）。
    const items: VsItem<ChatItemData>[] = [];
    let imgSeed = 0;
    let r = 0;
    while (r < raw.length) {
      const it = raw[r];
      if (it.kind === 'date') {
        const d = new Date(startMs + it.day * 86_400_000);
        items.push({
          id: `date-${items.length}`,
          data: { type: 'date', label: this.formatDateSeparator(d, now), dayKey: `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` },
        });
        r++;
        continue;
      }
      if (it.kind === 'media') {
        const isSelf = it.isSelf;
        const imgs: AlbumImage[] = [];
        while (r < raw.length) {
          const cur = raw[r];
          if (cur.kind !== 'media' || cur.isSelf !== isSelf) break;
          imgs.push({ src: this.placeholderImage(imgSeed++), w: 400, h: 300 });
          r++;
        }
        const date = new Date(startMs + it.day * 86_400_000 + it.minutes * 60_000);
        items.push({ id: items.length, data: this.mockMediaData(isSelf, imgs, date) });
        continue;
      }
      const date = new Date(startMs + it.day * 86_400_000 + it.minutes * 60_000);
      items.push({ id: items.length, data: this.mockTextData(it.isSelf, it.text, date) });
      r++;
    }
    return items;
  }

  private mockTextData(isSelf: boolean, text: string, date: Date): ChatMsgData {
    return {
      type: 'msg',
      msgId: `seed-${this.sendSeq++}`,
      creator: isSelf ? 1 : 2,
      isSelf,
      name: isSelf ? '我' : '阿黄',
      text,
      time: this.formatTime(date),
      contentType: 'PURE_TEXT',
      images: null,
      createdAtMs: date.getTime(),
    };
  }

  private mockMediaData(isSelf: boolean, imgs: AlbumImage[], date: Date): ChatMsgData {
    return {
      type: 'msg',
      msgId: `seed-${this.sendSeq++}`,
      creator: isSelf ? 1 : 2,
      isSelf,
      name: isSelf ? '我' : '阿黄',
      text: '',
      time: this.formatTime(date),
      contentType: 'IMAGE',
      images: imgs,
      createdAtMs: date.getTime(),
    };
  }

  /** 假数据占位图：基于 seed 生成不同色调的渐变 SVG（dataURL），离线稳定、不依赖图床。 */
  private placeholderImage(seed: number): string {
    const h1 = (seed * 53) % 360;
    const h2 = (h1 + 80) % 360;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='300'>` +
      `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
      `<stop offset='0' stop-color='hsl(${h1},65%,58%)'/><stop offset='1' stop-color='hsl(${h2},55%,40%)'/>` +
      `</linearGradient></defs>` +
      `<rect width='400' height='300' fill='url(#g)'/>` +
      `<text x='200' y='172' font-size='36' fill='rgba(255,255,255,0.85)' text-anchor='middle' font-family='sans-serif'>${(seed % 99) + 1}</text>` +
      `</svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }
}
