import {
  Component, ElementRef, OnDestroy, inject, isDevMode,
  signal, viewChild, effect, ChangeDetectionStrategy, ViewEncapsulation,
  EnvironmentInjector,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatBoxScroller, ScrollerApi, CbElement, CbItem, CbConfig, CbOptions, CbScrollInfo, CbDebugStats } from '../../lib/chat-box/chat-box-scroller';
import { ChatBoxScrollerAnchor } from '../../lib/chat-box/chat-box-scroller-anchor';
import { ActivatedRoute } from '@angular/router';
import { LayoutService } from '../../services/layout.service';
import { createMsgCbElement, createGhostCbElement, computeRowFlags } from '../../components/message-cards/create-item';
import { mergeAlbumItems, absorbAlbumTail } from '../../components/message-cards/merge-items';
import { GalleryViewerService } from '../../components/gallery-viewer/gallery-viewer.service';
import type { AlbumImage, ChatItemData, ChatMsgData, FileInfo } from '../../components/message-cards/chat-item';
import { MockItemSource, MockUserService } from './http-item-source.mock';
import { UserAvatarComponent } from '../../components/user-avatar/user-avatar.component';
import { ChatMember } from '../../components/chat-editor/chat-editor.component';
import { ChatInputComponent, ChatSendIntent } from '../../lib/chat-input/chat-input.component';

// Angular 生产 AOT 把全局 ngDevMode 置 falsy 并据此做死代码消除（与虚拟滚动内核同模式）。
// 用它守卫「调试角标注入」——生产构建不创建角标 DOM、零开销。非 Angular 环境该全局 undefined 同样关闭。
declare const ngDevMode: boolean | null | undefined;

// 内核调参默认值（与内核 DEFAULTS 同步：chat-box-scroller.ts / anchor.ts）。mountPx 已删（array 内核死参数）。
const CB_DEFAULTS: Required<CbConfig> = { edge: 1000, mountItem: 50, thresholdFloor: 6000, vhExtra: 2000, initBatch: 100 };

/**
 * 虚拟滚动实验场。
 *
 * 渲染与真实聊天完全一致——createItem 调 createMsgCbElement（真实 message-cards 组件），
 * 数据/行为全 mock（不发 HTTP、不依赖登录/后端）：经 {@link MockChatApi} 生成器一次性产 n 条
 * 稳定记录，发送/上传/对方回复均走 mock 接口，入参/出参打到 console。
 *
 * 数据全量载入（generate → setItems → scrollToBottom），不传 onLoadMore——balance 自然挂载
 * 更早 item，无需历史加载。跳转到指定 id 经内核 scrollToIndex（A/B 双内核均支持）。
 *
 * 【样式边界】本组件 ViewEncapsulation.None（全局 pg-），但**绝不写作用于聊天内容内部的 CSS**
 *（.pg-msg-row/.pg-bubble 等由 message-cards 组件的 _row-base 自治）——否则全局规则会改消息行
 * 实测高度、干扰内核 offsetHeight 判断。本文件只管外壳：stage/header/viewport 容器/面板/输入栏/FAB。
 */
@Component({
  selector: 'app-chatbox-playground',
  imports: [FormsModule, UserAvatarComponent, ChatInputComponent],
  templateUrl: './chatbox-playground.component.html',
  styleUrl: './chatbox-playground.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
})
export class ChatboxPlaygroundComponent implements OnDestroy {
  private readonly layout = inject(LayoutService);
  private readonly route = inject(ActivatedRoute);
  /** 动态创建消息组件（zoneless 下 createComponent + detectChanges 驱动渲染）。 */
  private readonly envInjector = inject(EnvironmentInjector);
  /** Album click → fullscreen gallery viewer (CDK Overlay, service-hosted; no per-host template mounting needed). */
  private readonly galleryViewer = inject(GalleryViewerService);
  /** 方案 A（借浏览器锚定）由路由 data.useNativeAnchor 决定：-a 路由为 true，-b（默认）走方案 B（手动补偿）。 */
  readonly useNativeAnchor = (this.route.snapshot.data as { useNativeAnchor?: boolean }).useNativeAnchor === true;
  /** 桌面级视口(宽屏+精确指针)：true=常驻侧栏；false=移动抽屉+FAB。 */
  readonly isDesktop = this.layout.isDesktop;
  /** 移动端控制面板抽屉开关。 */
  readonly panelOpen = signal(false);
  /** 输入栏为避让软键盘上移的像素（visualViewport 计算，iOS 兜底）。 */
  readonly keyboardOffset = signal(0);

  /** mock 数据源（实现 CbSource；buildItems 生成器分页）。setup 时按 count 创建。 */
  private source?: MockItemSource;
  /** 生成器加载中（禁用数据量按钮，防重入）。 */
  readonly loading = signal(false);
  /** 短暂提示（跳转未命中等），自动清除。 */
  readonly toast = signal<string | null>(null);
  private toastTimer?: ReturnType<typeof setTimeout>;

  private readonly viewportRef = viewChild<ElementRef<HTMLDivElement>>('viewport');
  private readonly contentRef = viewChild<ElementRef<HTMLDivElement>>('content');
  private readonly fabRef = viewChild<ElementRef<HTMLButtonElement>>('fab');
  private readonly pgStageRef = viewChild<ElementRef<HTMLDivElement>>('pgStage');
  private readonly jumpInput = viewChild<ElementRef<HTMLInputElement>>('jumpInput');
  private readonly insertInput = viewChild<ElementRef<HTMLInputElement>>('insertInput');
  private readonly removeInput = viewChild<ElementRef<HTMLInputElement>>('removeInput');

  private scroller?: ScrollerApi<ChatItemData>;

  /** 视口上方剩余 height（= scrollTop，向上可滚到窗口顶的余量；调试）。 */
  readonly viewportAbove = signal(0);
  /** 视口下方剩余 height（= scrollHeight - vh - scrollTop，向下可滚到窗口底的余量；调试）。 */
  readonly viewportBelow = signal(0);
  /** 是否贴底（收到新消息时决定是否跟随滚动）。 */
  readonly atBottom = signal(true);
  /** 调试模式：开 FAB 角标 + balance 诊断 console；性能模式全关。 */
  readonly debugMode = signal(true);
  /** 调试：关闭挂载检查点（balance 不触发 loadOlder/loadNewer）。默认 false（检查点正常加载）。仅 dev 有效（内核 ngDevMode 守卫，生产 AOT 移除）。 */
  readonly closeCheckpoint = signal(false);
  /** source get 延迟（ms，模拟 IO 慢加载）。默认 200，可调 0/1s/5s 测加载/补偿体验。 */
  readonly sourceLatency = signal(200);
  /** Mock server-echo delay (ms): how long an optimistic bubble stays 'sending' before confirm flips it to 'sent'. Default 800. */
  readonly confirmDelay = signal(800);
  /** Mock WS reply delay (ms): time after confirm before the other party's message is pushed via appendLive. Default 1500. */
  readonly replyDelay = signal(1500);
  /** Mock WS push-signal delay (ms): time after the server caches the confirmed message before the WS signal delivers
   *  it (onMessageSignal → reconcile). Models broadcast latency — during it the optimistic bubble keeps showing the
   *  'sending' spinner. Default 0 (reconcile on the next tick, as before). */
  readonly pushSignalDelay = signal(0);
  /** Opponent-interleave scenario: on each send, deliver an opponent message in the same confirm batch, ordered
   *  BEFORE the sent message (it mounts above the optimistic bubble). Reproduces the "a reply lands above my sent
   *  message" race for testing the kernel's optimistic-tail mount ordering. Default off (chronological below-reply). */
  readonly opponentInterleave = signal(false);
  /** How many opponent (incoming) messages are pushed after each send. 0 = none — only your self-sent message confirms
   *  (the optimistic-send → check-fade flow in isolation, with no replies cluttering the chat). N > 0 = N opponent
   *  messages arrive per send. Does NOT affect the confirm reconcile itself (the server echo of your own message still
   *  arrives via onMessageSignal); only the "incoming reply" side of the mock WS. Default 1 (one below-reply). */
  readonly opponentPushCount = signal(1);
  /** Persistent setting: when on, EVERY send's confirm fails (network/timeout model) — the optimistic bubble is rebuilt
   *  as a failed bubble (retry glyph) instead of confirming. Stays on until toggled off, so the failure/retry flow can be
   *  exercised repeatedly without re-arming. To test "fail then succeed": turn on → send → turn off → click retry. */
  readonly mockSendError = signal(false);
  /** 内核调参（CbConfig）。setup 传给内核；编辑弹窗改 → applyConfig 重建生效。 */
  readonly config = signal<Required<CbConfig>>({ ...CB_DEFAULTS });
  /** 参数编辑弹窗开关 + 草稿（确认才 apply，避免改一个字段就重建）。 */
  readonly configModalOpen = signal(false);
  readonly configDraft = signal<Required<CbConfig>>({ ...CB_DEFAULTS });
  /** Telegram 式粘性日期：当前视口顶所属日期标签（滚动实时更新；null=不显浮层）。 */
  readonly stickyDate = signal<string | null>(null);
  /** 主题：light / dark。默认跟随系统 prefers-color-scheme，可手动 toggle 临时覆盖（系统变化时再跟随）。 */
  readonly theme = signal<'light' | 'dark'>('light');
  private themeMqCleanup: (() => void) | null = null;
  toggleTheme() { this.theme.update(t => t === 'light' ? 'dark' : 'light'); }

  // 控件
  readonly count = signal(5000);
  /** @mention candidates (mock group members; production swaps in GroupService.getMembers()). */
  readonly members = signal<ChatMember[]>(MOCK_MEMBERS);
  /** Measured input-bar height (auto-grow; refilled by ChatInputComponent's heightChange). Drives .pg-viewport
   *   `bottom` so the list sits flush above the bar and a multi-line draft never covers it. */
  readonly inputBarHeight = signal(63);

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
  private lastDebugLog = 0;

  // FAB 拖动状态
  private fabDragging = false;
  private fabMoved = false;
  private fabStartX = 0;
  private fabStartY = 0;
  private fabStartLeft = 0;
  private fabStartTop = 0;

  // zoneless + signal viewChild：ngAfterViewInit 可能不触发，改用 effect——
  // viewChild signal 解析后 effect 必跑，初始化 scroller（只一次）。
  private readonly initScroller = effect(() => {
    const vp = this.viewportRef();
    const ct = this.contentRef();
    if (!vp || !ct || this.scroller) return;
    this.setup(vp.nativeElement, ct.nativeElement);
  });

  /** 建 source + 内核 + init。setCount 切数据量时 teardown 重建。 */
  private setup(viewport: HTMLDivElement, content: HTMLDivElement): void {
    try {
      this.scroller?.destroy();
      this.source = new MockItemSource(this.count(), this.sourceLatency(), new MockUserService(), 1);
      // 据路由 data 选内核实现：方案 A（借浏览器锚定）或方案 B（手动补偿），两者同构 ScrollerApi。
      const Ctor: new (opts: CbOptions<ChatItemData>) => ScrollerApi<ChatItemData> =
        this.useNativeAnchor ? ChatBoxScrollerAnchor : ChatBoxScroller;
      this.scroller = new Ctor({
        viewport, content, source: this.source,
        config: this.config(),
        hooks: { createItem: (item, prev) => this.createItemEl(item, prev), mergeItems: mergeAlbumItems, absorbTail: absorbAlbumTail },
        onScroll: (info) => this.onScroll(info),
        onDebug: isDevMode() ? (s) => this.onBalanceDebug(s) : undefined,
      });
      this.applyCloseCheckpoint();
      void this.load();
    } catch (e) {
      console.error('[playground] scroller init failed:', e);
    }
  }

  /** 应用 closeCheckpoint 开关到内核（cast 设 closeCheckpoint 字段；setCount 重建后 setup 末尾重应用）。 */
  applyCloseCheckpoint(): void {
    const s = this.scroller as unknown as { closeCheckpoint?: boolean } | undefined;
    if (s) s.closeCheckpoint = this.closeCheckpoint();
  }

  /** 设 source get 延迟（动态改 MockItemSource.latency，无需重建 source）。 */
  setSourceLatency(ms: number): void {
    this.sourceLatency.set(ms);
    if (this.source) this.source.latency = ms;
  }
  /** Set the mock server-echo delay (read live by the confirm timer — no rebuild needed). */
  setConfirmDelay(ms: number): void { this.confirmDelay.set(ms); }
  /** Set the mock WS reply delay (read live by the reply timer — no rebuild needed). */
  setReplyDelay(ms: number): void { this.replyDelay.set(ms); }
  /** Set the mock WS push-signal delay (read live by the confirm timer — no rebuild needed). */
  setPushSignalDelay(ms: number): void { this.pushSignalDelay.set(ms); }
  /** Toggle the opponent-interleave-before-mine scenario. */
  toggleOpponentInterleave(): void { this.opponentInterleave.update(v => !v); }
  /** Set how many opponent messages are pushed per send (read live by the confirm path — no rebuild needed). */
  setOpponentPushCount(n: number): void { this.opponentPushCount.set(n); }
  /** Toggle the persistent "mock send error" setting (every send fails while on). */
  toggleMockSendError(): void { this.mockSendError.update(v => !v); }

  /** 打开参数编辑弹窗（草稿 = 当前 config 副本）。 */
  openConfigModal(): void {
    this.configDraft.set({ ...this.config() });
    this.configModalOpen.set(true);
  }
  cancelConfigModal(): void { this.configModalOpen.set(false); }
  /** 弹窗编辑：改 draft 某字段（确认才 apply）。模板内不直接调 signal.update —— strict 模板类型检查对模板内 signal 方法绑定推断不出签名 → TS2345 整编译失败、新代码全不进 bundle。 */
  setConfigDraft(field: keyof CbConfig, value: number): void {
    this.configDraft.update(d => ({ ...d, [field]: value }));
  }
  /** 确认编辑：config ← draft + setup 重建（新参数生效）+ 关闭。 */
  applyConfig(): void {
    this.config.set({ ...this.configDraft() });
    this.configModalOpen.set(false);
    const vp = this.viewportRef()?.nativeElement;
    const ct = this.contentRef()?.nativeElement;
    if (vp && ct) this.setup(vp, ct);
  }

  ngOnDestroy() {
    this.scroller?.destroy();
    this.themeMqCleanup?.();
    clearTimeout(this.toastTimer);
    for (const t of this.confirmTimers) clearTimeout(t);
    this.confirmTimers.length = 0;
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

  // --- 数据载入 ---

  /** init：内核经 source 分批加载到阈值 + 贴底（数据全量在 source，内核按需 get）。 */
  private async load(): Promise<void> {
    const scroller = this.scroller;
    if (!scroller) return;
    this.loading.set(true);
    try {
      await scroller.init();
      this.updateStickyDate();
    } finally {
      this.loading.set(false);
    }
  }

  // --- 内核 hooks ---

  private createItemEl(item: CbItem<ChatItemData>, prev: CbItem<ChatItemData> | null): CbElement<ChatItemData> {
    // 骨架占位：最顶条（prev=null 且未到全局最老）不渲真实组件，固定高度 shimmer（见 createGhostCbElement）。
    // prev=null ⟺ 被 prepend 成新 oldest；boundary!=='oldest' 排除全局最老（那条 noOlder、非 ghost、须真实渲）。
    if (prev === null && item.boundary !== 'oldest') return createGhostCbElement();
    // 分组判定 + date 分隔按【更老邻居 prev】算（computeRowFlags，与 CbElement.update 共用同一逻辑——重排序后
    // update 须按新 prev 重算分组，mount 与 in-place update 派生同款 flags）。
    const { isShowHead, isGroupStart, dateLabel } = computeRowFlags(item, prev);
    const vs = createMsgCbElement(
      item, isShowHead, isGroupStart, dateLabel, this.envInjector,
      id => this.retrySend(id),
      (images, index) => this.galleryViewer.open(images, index),
    );
    // 调试角标（首/续 + 消息 id）：playground 动态注入到行内，ngDevMode 守卫 → 生产 AOT 不创建。
    if (ngDevMode) this.attachDevBadge(vs.el, item, isShowHead);
    return vs;
  }

  /** 注入调试角标到 .pg-msg-row：首(绿)/续(橙) + 消息 id（+ PENDING/FAKE tag when kind is set）。仅 dev（ngDevMode）；destroy 随组件卸载。 */
  private attachDevBadge(host: HTMLElement, item: CbItem<ChatItemData>, isHead: boolean): void {
    const d = item.data;
    if (d.type !== 'msg') return; // 仅消息行（date 行无分组概念）
    const row = host.querySelector('.pg-msg-row');
    if (!row) return;
    const badge = document.createElement('span');
    badge.className = 'pg-dev-badge' + (isHead ? ' pg-dev-badge--head' : ' pg-dev-badge--body');
    const label = this.devIdLabel(d);
    badge.textContent = d.kind ? `${label}·${d.kind.toUpperCase()}` : label;
    row.appendChild(badge);
  }

  /**
   * 角标 id 文本：相册聚合多 msg 时显范围 `[min-max]`（各图带原 msgId），否则单 id。
   * mock 相册单 msg → 单 id；生产相册跨多 msg（toItems 合并）→ 范围，避免聚合后只显首条丢其余。
   */
  private devIdLabel(d: ChatMsgData): string {
    if (d.contentType === 'IMAGE' && d.images) {
      const ids = [...new Set(d.images.map(i => i.msgId).filter((x): x is string => !!x))];
      if (ids.length > 1) {
        const nums = ids.map(Number);
        if (nums.every(n => !Number.isNaN(n))) { nums.sort((a, b) => a - b); return `[${nums[0]}-${nums[nums.length - 1]}]`; }
        return `[${ids[0]}..${ids[ids.length - 1]}]`;
      }
      if (ids.length === 1) return ids[0];
    }
    return shortId(d.msgId);
  }

  /** balance 诊断 → console.debug（调试模式 + 仅有挂载/卸载活动 + 节流，避免空闲刷屏）。 */
  private onBalanceDebug(s: CbDebugStats) {
    if (!this.debugMode()) return;
    if (s.mount + s.unmount === 0) return;
    const now = performance.now();
    if (now - this.lastDebugLog < 200) return;
    this.lastDebugLog = now;
    console.debug('[vs balance]', s);
  }

  private onScroll(info: CbScrollInfo) {
    // Drain optimistic sends queued while the newer end was trimmed: noNewer means the mounted tail IS the global
    // newest, so tailAnchorId() is now safe to anchor on. (scrollToBottom's follow chain emits noNewer on the batch
    // that reaches the global newest.) Runs before the throttle below so the insert is prompt, not delayed by 100ms.
    if (info.noNewer && this.pendingOptimistic.length > 0) {
      const queue = this.pendingOptimistic;
      this.pendingOptimistic = [];
      for (const item of queue) this.insertMsg('PENDING_POST_MSG', this.tailAnchorId(), item);
    }
    this.atBottom.set(info.atBottom);
    this.updateStickyDate();
    if (!isDevMode()) return;
    const now = performance.now();
    if (now - this.lastEmit < 100) return; // 节流：避免滚动高频刷 signal（100ms 一次足够）
    this.lastEmit = now;
    // 视口在 content（= mounted 窗口）内的位置：上方/下方剩余 height（< edge=1000 触发对应方向加载）。
    this.viewportAbove.set(Math.round(info.scrollTop));
    this.viewportBelow.set(Math.max(0, Math.round(info.scrollHeight - info.viewportHeight - info.scrollTop)));
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
    // 顶部 ghost 加载 spinner（.cb-ghost-loading，居中）显形时与居中日期浮层重叠 →
    // spinner 出现在视口顶（bottom 越过视口顶）时不显浮层让位（spinner 走后自然恢复；行内 date 仍在）。
    const ghost = ct.querySelector('.cb-ghost-loading');
    if (ghost && ghost.getBoundingClientRect().bottom > vTop) current = null;
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

  setCount(n: number) {
    this.count.set(n);
    const vp = this.viewportRef()?.nativeElement;
    const ct = this.contentRef()?.nativeElement;
    if (vp && ct) this.setup(vp, ct); // 切数据量：teardown + 重建 source(count) + 内核 + init
  }

  /**
   * 跳转到 msgId 序号（mock 'id-N'）：已挂载则直接定位；未挂载则内核重置窗口围绕该 id（re-seed）再定位。
   * anchor='center' 居中（best-effort：近最新/最旧时 clamp 到顶/底）+ 高亮闪烁。id 不存在时 source 返回空 → 内核静默 no-op。
   */
  jumpToId(v: string): void {
    const scroller = this.scroller;
    const input = this.jumpInput()?.nativeElement;
    const s = (v ?? '').trim();
    if (!s || !scroller) return;
    if (!/^-?\d+$/.test(s)) { this.showToast('Jump supports id numbers only'); return; }
    const n = parseInt(s, 10);
    if (n < 0) { this.showToast('id must be non-negative'); return; }
    scroller.scrollToIndex(`id-${n}`, 'center', true);
    if (input) input.value = '';
  }

  /**
   * 在已挂载的 msgId 之后插入一条新消息（mock 'id-N'）：已挂载则内核 insertAfter（不触发 balance，仅滚动高度补偿）；
   * 未挂载则内核忽略（返回 false）→ toast 提示。插入项 creator 交替 self/other，以演练后继项分组 rebuild。
   * 与 appendLive 不同：这是视口级插入，不入 source（transient）；滚出窗口被 trim 后即消失，by design。
   */
  insertAfterId(v: string): void {
    const scroller = this.scroller;
    const input = this.insertInput()?.nativeElement;
    const s = (v ?? '').trim();
    if (!s || !scroller) return;
    if (!/^-?\d+$/.test(s)) { this.showToast('Insert supports id numbers only'); return; }
    const n = parseInt(s, 10);
    if (n < 0) { this.showToast('id must be non-negative'); return; }
    const afterId = `id-${n}`;
    const item = this.makeInsertItem();
    const ok = this.insertMsg('FAKE_MSG', afterId, item);
    if (input) input.value = '';
    this.showToast(ok ? `Inserted ${item.id} (after ${afterId})` : `${afterId} not mounted, insert ignored`);
  }

  /**
   * Remove mounted message(s) by id — one id or a comma/whitespace-separated list. Accepts a plain history seq
   * (`450` -> `id-450`) or a literal id (`pending-3`, `insert-0`, `id-450`); a fake/pending/real id or any album-member
   * id all resolve to the same entry. Plays a cb-leave exit animation (balance paused while it runs); not-mounted ids
   * are ignored. Toasts the count removed.
   */
  removeById(v: string): void {
    const scroller = this.scroller;
    const input = this.removeInput()?.nativeElement;
    const parts = (v ?? '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    if (parts.length === 0 || !scroller) return;
    const ids = parts.map(p => (/^\d+$/.test(p) ? `id-${p}` : p)); // plain number -> history 'id-N'; else literal id
    const removed = scroller.removeItem(ids);
    if (input) input.value = '';
    this.showToast(removed > 0 ? `Removed ${removed} item(s)` : 'Not mounted, ignored');
  }

  /** Build a mock debug-insert message (creator alternates 1=me/isSelf / 2=阿黄; name/isSelf filled directly since
   *  insertAfter bypasses source.shape). kind:'fake' tags it in the dev badge; no status (debug inserts are not "sent"). */
  private makeInsertItem(): CbItem<ChatItemData> {
    const now = new Date();
    const seq = this.insertSeq++;
    const creator = seq % 2 === 0 ? 1 : 2;
    const data: ChatMsgData = {
      type: 'msg',
      msgId: `insert-${seq}`,
      creator,
      isSelf: creator === 1,
      name: creator === 1 ? 'Me' : 'Alice',
      text: `[Insert ${seq}] inserted after the specified message`,
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      contentType: 'PURE_TEXT',
      images: null,
      file: null,
      createdAtMs: now.getTime(),
      kind: 'fake',
    };
    return { id: data.msgId, data };
  }

  private showToast(msg: string): void {
    this.toast.set(msg);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(null), 1800);
  }

  toTop() { this.scroller?.scrollToTop(); }
  toBottom() { this.scroller?.scrollToBottom(); }

  /**
   * ChatInputComponent send intent → dispatch. The composer owns presentation only; this switches on the
   * structured intent and routes to the mock optimistic-send paths. Text is plain (editor.getText()); the
   * editor is cleared inside the composer before this fires.
   */
  onSendIntent(intent: ChatSendIntent): void {
    switch (intent.kind) {
      case 'text': void this.sendText(intent.text); return;
      case 'image': void this.sendMediaFromFile(intent.files); return;
      case 'file': void this.sendFileFromFile(intent.files); return;
    }
  }

  /**
   * Optimistic text send: show a "sending" bubble right after the newest mounted item (insertAfter, transient),
   * register it with the source's pending area, and schedule a mock confirm. The optimistic item shares the real
   * (server-echoed) id, so on confirm the kernel settles the transient in place (clock -> check) instead of
   * mounting a duplicate. Stacks naturally: each insert anchors on the current tail (a prior fake or the real newest).
   */
  private async sendText(text: string): Promise<void> {
    const scroller = this.scroller;
    if (!text || !scroller) return;
    const item = this.makeOptimisticItem(text, 'PURE_TEXT', null, null);
    this.dispatchPending(item);
  }

  /** Mock WS incoming batch (the other party): cache `count` live messages in one shot and signal the kernel once —
   *  loadNewer pulls them via getNewer (shaping name/isSelf from profiles) and mounts them at the tail; the kernel
   *  follows to the bottom if pinned. A single pushLive + signal keeps the batch atomic (one loadNewer pass). */
  private async receiveMany(count: number): Promise<void> {
    const scroller = this.scroller;
    if (!scroller || count <= 0) return;
    const items = Array.from({ length: count }, () => {
      const phrase = REPLY_PHRASES[Math.floor(Math.random() * REPLY_PHRASES.length)];
      return this.makeMockItem(phrase, false, 'PURE_TEXT', null);
    });
    this.source?.pushLive(items);
    void scroller.onMessageSignal();
  }

  /**
   * Optimistic image send: read images locally -> show a "sending" album bubble (insertAfter, transient) -> mock confirm.
   * The real uploadMedia/sendMessage is skipped under mock (the bytes are already client-side).
   */
  async sendMediaFromFile(files: FileList | null): Promise<void> {
    const scroller = this.scroller;
    if (!files || files.length === 0 || !scroller) return;
    const list = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (list.length === 0) return;
    const imgs = await readImages(list);
    if (imgs.length === 0) return;
    const item = this.makeOptimisticItem('', 'IMAGE', imgs);
    this.dispatchPending(item);
  }

  /**
   * Optimistic file send: the playground is mock-only (no real backend round-trip), so the picked file is
   * exposed via a client object URL — the FileRow download anchor then genuinely downloads the real bytes,
   * making the card fully functional in the sandbox. (Production uses MsgService.uploadFile → POST /upload/file
   * and stores the returned /uploads/<name> url; the optimistic card here is the same shape with a blob url.)
   */
  async sendFileFromFile(files: FileList | null): Promise<void> {
    const scroller = this.scroller;
    if (!files || files.length === 0 || !scroller) return;
    for (const f of Array.from(files)) {
      const url = URL.createObjectURL(f);
      const file: FileInfo = {
        url,
        name: f.name,
        size: f.size,
        mimeType: f.type || 'application/octet-stream',
      };
      this.dispatchPending(this.makeOptimisticItem('', 'FILE', null, file));
    }
  }

  /** The id to anchor a newest-end insert after: the current tail (a prior fake/pending, or the real newest). '' if empty. */
  private tailAnchorId(): string {
    const id = this.scroller?.getInfo().newestId ?? null;
    return id != null ? String(id) : '';
  }

  /** Optimistic sends queued while the newer end was trimmed; drained in onScroll once noNewer is reported. */
  private pendingOptimistic: CbItem<ChatItemData>[] = [];

  /**
   * Route an optimistic send so it anchors on the GLOBAL newest only once that end is mounted. When pinned (noNewer,
   * the common case) this is synchronous: anchor and insert now. When the newer end is trimmed (scrolled into history),
   * queue the item and scrollToBottom() — the follow chain mounts the newest and onScroll drains the queue, inserting
   * each item on the now-correct tail. So tailAnchorId() never anchors on a mid-list item. A prior in-flight pending
   * bubble counts as "the newest" (it IS the mounted tail once noNewer), so rapid-fire sends still stack in order.
   */
  private dispatchPending(item: CbItem<ChatItemData>): void {
    const scroller = this.scroller;
    if (!scroller) return;
    if (scroller.getInfo().noNewer) {
      this.insertMsg('PENDING_POST_MSG', this.tailAnchorId(), item);
    } else {
      this.pendingOptimistic.push(item);
      scroller.scrollToBottom();
    }
  }

  /**
   * Domain-layer insert orchestrator: the `type` discriminator lives HERE (the kernel stays generic — it only knows the
   * viewport-level `transient` flag, never 'PENDING_POST_MSG'/'FAKE_MSG'). Both shapes route through kernel.insertAfter;
   * PENDING_POST_MSG additionally registers with the source pending area, ensures the newest end is mounted, and schedules
   * a mock confirm; FAKE_MSG is a pure viewport insert (the 插入消息 debug action).
   */
  private insertMsg(type: 'PENDING_POST_MSG' | 'FAKE_MSG', afterId: string, item: CbItem<ChatItemData>): boolean {
    const scroller = this.scroller;
    if (!scroller) return false;
    // afterId is '' on the first send into an empty thread (tailAnchorId() = '' when nothing is mounted); the kernel's
    // insertAfter treats an empty window as "insert as the sole entry", so do NOT bail on an empty id here. FAKE_MSG
    // always carries a real id — insertAfterId guards empty input before calling — so this only relaxes PENDING_POST_MSG.
    if (type === 'PENDING_POST_MSG') {
      // Register with the source pending area so the confirm echo (appendLive with a matching id) reconciles it.
      this.source?.addPending(item);
      // No pre-scroll: afterId IS the mounted tail (tailAnchorId → getInfo().newestId = mounted[last].id), so
      // insertAfter always finds its anchor — there is nothing to mount first. The follow that reveals the bubble
      // runs AFTER insertAfter (below) and is synchronous when pinned (noNewer → pinToBottom only, no source I/O).
    }
    const ok = scroller.insertAfter(afterId, item, { optimistic: type === 'PENDING_POST_MSG' });
    if (ok && type === 'PENDING_POST_MSG') {
      // insertAfter is viewport-stable (it only compensates scrollTop for above-viewport growth), so a sent message —
      // which lands at the newer end, below the fold when pinned — must be explicitly pinned to reveal the optimistic
      // bubble. Mirrors appendLive/loadNewer's wasAtBottom follow. (A send always means "show my message".)
      scroller.scrollToBottom();
      const optimistic = item;
      const t = setTimeout(() => this.confirmPending(optimistic), this.confirmDelay());
      this.confirmTimers.push(t);
    }
    return ok;
  }

  /**
   * Mock server confirm: allocate a fresh server msgId for the confirmed real (autoincrement, mirrors production
   * Message.id) and cache it with the SAME clientMessageId as the optimistic (the reconcile key — the kernel pairs them
   * by clientMessageId, not id, since the real's id is brand-new). After the push-signal delay, fire the WS signal so
   * loadNewer reconciles the pending entry and reconcileOptimistic removes the optimistic bubble and tags the real
   * cb-confirmed (status 'sending' → 'sent'; the check then fades out via CSS — see _row-base.scss). If the transient
   * was unmounted meanwhile (e.g. a jump during pending), the real mounts at the tail normally.
   *
   * Opponent pushes per send are controlled by opponentPushCount: 0 = no incoming messages at all (only your confirm);
   * N > 0 = N opponent messages. When opponentInterleave is on, ONE of those N is cached BEFORE the real so the source's
   * ascending order is [opponent, mine] and mountNewerReals inserts it ABOVE the optimistic tail (the "reply lands above
   * my sent message" race); the remaining N−1 arrive as a below batch after replyDelay. When interleave is off, all N
   * arrive below.
   */
  private confirmPending(optimistic: CbItem<ChatItemData>): void {
    const scroller = this.scroller;
    if (!scroller || !this.source) return;
    // Mock send error (persistent setting): the confirm "times out / errors" — the optimistic bubble is rebuilt as a
    // failed bubble (retry glyph) instead of confirming. The real is NOT pushed (no confirm). Stays on until toggled off.
    if (this.mockSendError()) {
      this.failPending(optimistic);
      return;
    }
    const realMsgId = this.source.allocateMsgId();
    const realItem: CbItem<ChatItemData> = {
      id: realMsgId,
      data: { ...optimistic.data, msgId: realMsgId, status: 'sent', kind: undefined },
      clientMessageId: optimistic.clientMessageId,
    };

    // Opponent budget for this send: 0 means no incoming messages at all (only the self-sent confirm below).
    const count = this.opponentPushCount();

    // Opponent-interleave: cache ONE opponent message BEFORE the real → ascending order [opponent, mine] → opponent
    // mounts above the optimistic bubble. Consumes one slot of the budget; the rest go to the below batch.
    let above = 0;
    if (count > 0 && this.opponentInterleave()) {
      const phrase = REPLY_PHRASES[Math.floor(Math.random() * REPLY_PHRASES.length)];
      this.source?.pushLive([this.makeMockItem(phrase, false, 'PURE_TEXT', null)]);
      above = 1;
    }
    this.source?.pushLive([realItem]);

    // WS push delivery, optionally delayed to model broadcast latency. On a non-zero delay the optimistic bubble keeps
    // showing the 'sending' spinner until the signal arrives and reconcile reveals the real (check → CSS fade).
    const signalTimer = setTimeout(() => { void scroller.onMessageSignal(); }, this.pushSignalDelay());
    this.confirmTimers.push(signalTimer);

    // Remaining opponent budget delivered as one below-batch after replyDelay (atomic pushLive + single signal).
    const below = count - above;
    if (below > 0) {
      const replyTimer = setTimeout(() => { void this.receiveMany(below); }, this.replyDelay());
      this.confirmTimers.push(replyTimer);
    }
  }

  /**
   * Failure path: the message stays the SAME entity (stable clientMessageId). The source owns the mutation — it flips
   * the pending entry's status to 'failed' and sinks it to the END of the pending queue — then reconcilePending morphs
   * the bubble IN PLACE (sending→failed, same DOM node) and FLIP-animates the slide to the tail. No removeItem /
   * insertAfter, no fabricated failed-N id: the failure is durable (the entry stays in source.pending) and the kernel
   * stays synced with the source's pending order.
   */
  private async failPending(optimistic: CbItem<ChatItemData>): Promise<void> {
    const scroller = this.scroller;
    if (!scroller || !this.source || optimistic.clientMessageId === undefined) return;
    this.source.failPending(optimistic.clientMessageId);
    await scroller.reconcilePending();
  }

  /**
   * Retry a failed send (the row's retry output → createMsgCbElement onRetry → here, emitting `data.msgId` = the stable
   * clientMessageId). Flip the SAME entry back to 'sending' at its current position (the end) via the source, then
   * reconcilePending morphs it in place (failed→sending) — stable identity, no fresh clientMessageId, no remount — and
   * re-arm the confirm timer for a normal confirm. No-op if the id is no longer pending (e.g. unmounted meanwhile).
   */
  async retrySend(msgId: string): Promise<void> {
    const scroller = this.scroller;
    if (!scroller || !this.source) return;
    const item = this.source.retryPending(msgId);
    if (!item) return;
    await scroller.reconcilePending();
    const t = setTimeout(() => this.confirmPending(item), this.confirmDelay());
    this.confirmTimers.push(t);
  }

  /** Build a fully-shaped optimistic self message (creator 1, name 'Me', status 'sending', kind 'pending'). Generates a
   *  client idempotency UUID (clientMessageId) that doubles as the bubble's tracking id until the server confirms —
   *  mirrors production SendMessageDto.clientMessageId. insertAfter bypasses source.shape, so name/isSelf are filled
   *  directly (mirrors MockItemSource.shape for creator 1). */
  private makeOptimisticItem(text: string, contentType: ChatMsgData['contentType'], images: AlbumImage[] | null, file: FileInfo | null = null, rich = false): CbItem<ChatItemData> {
    const now = new Date();
    const clientMessageId = newClientMessageId();
    const data: ChatMsgData = {
      type: 'msg',
      msgId: clientMessageId, // no server id yet — the client tracks the bubble by its clientMessageId (truncated in the dev badge)
      creator: 1,
      isSelf: true,
      name: 'Me',
      text,
      rich,
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      contentType, images, file, createdAtMs: now.getTime(),
      status: 'sending',
      kind: 'pending',
    };
    return { id: clientMessageId, data, clientMessageId };
  }

  /** Build a mock received/sent ChatMsgData wrapped as a CbItem. The id is allocated from the source's autoincrement
   *  counter — the same path a confirmed self-send takes (`source.allocateMsgId()` → `id-N`), mirroring a server-assigned
   *  Message.id — so incoming messages carry a real id, not a synthetic placeholder. The `mock-N`/`recv-N` form is a
   *  fallback only for the impossible case where the source is unbound while the scroller is live. appendLive caches it. */
  private makeMockItem(text: string, isSelf: boolean, contentType: ChatMsgData['contentType'], images: AlbumImage[] | null, file: FileInfo | null = null): CbItem<ChatItemData> {
    const now = new Date();
    const data: ChatMsgData = {
      type: 'msg',
      msgId: this.source?.allocateMsgId() ?? `${isSelf ? 'mock' : 'recv'}-${this.sendSeq++}`,
      creator: isSelf ? 1 : 2,
      isSelf: false, name: '',  // placeholder: source.appendLive's shape fills name from profiles by creator (mirrors production toMsgData)
      text,
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      contentType, images, file, createdAtMs: now.getTime(),
    };
    return { id: data.msgId, data };
  }
  private sendSeq = 0;
  /** 插入消息序号（msgId = `insert-N`，稳定唯一，不与 source 的 id-N / mock-N / recv-N 冲突）。 */
  private insertSeq = 0;
  /** In-flight mock confirm timers (cleared on teardown so no settle fires after destroy). */
  private readonly confirmTimers: ReturnType<typeof setTimeout>[] = [];
}

/** 对方回复候选（mock）。 */
const REPLY_PHRASES = ['You there?', 'Got it', 'Haha', 'OK', 'Is virtual scroll stable?', 'Check the mount count'];

/** @mention 候选成员（mock；生产替换为 GroupService.getMembers() 返回的 GroupMember[]）。 */
const MOCK_MEMBERS: ChatMember[] = [
  { id: '2', label: 'Alice' },
  { id: '3', label: 'Bob' },
  { id: '4', label: 'Carol' },
  { id: '5', label: 'David' },
  { id: '6', label: 'Eve' },
  { id: '7', label: 'Frank' },
  { id: '8', label: 'Grace' },
  { id: '9', label: 'Heidi' },
];

/** Generate a client-side idempotency UUID for an optimistic send (mirrors production SendMessageDto.clientMessageId —
 *  the correlation key between the in-flight bubble and the server-confirmed real). crypto.randomUUID is available in
 *  secure contexts (localhost / https); the fallback preserves uniqueness elsewhere. */
function newClientMessageId(): string {
  return crypto.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

/** Truncate a clientMessageId UUID to its first 8 hex chars for the dev badge (a full 36-char uuid would dominate the
 *  row). Non-uuid ids (id-N, recv-N, insert-N, …) pass through unchanged, so the uuid→real-msgId transition is visible. */
function shortId(id: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(id) ? id.slice(0, 8) : id;
}

/** 本地读取图片为 AlbumImage（dataURL + 真实尺寸；读失败用 400×300 兜底）。 */
function readImages(files: File[]): Promise<AlbumImage[]> {
  return Promise.all(files.map(f => new Promise<AlbumImage>(resolve => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = typeof reader.result === 'string' ? reader.result : '';
      if (!src) { resolve({ src: '', w: 400, h: 300 }); return; }
      const probe = new Image();
      probe.onload = () => resolve({ src, w: probe.naturalWidth || 400, h: probe.naturalHeight || 300 });
      probe.onerror = () => resolve({ src, w: 400, h: 300 });
      probe.src = src;
    };
    reader.onerror = () => resolve({ src: '', w: 400, h: 300 });
    reader.readAsDataURL(f);
  })));
}
