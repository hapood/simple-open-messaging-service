import {
  Component, ElementRef, OnDestroy, inject, isDevMode,
  signal, viewChild, effect, ChangeDetectionStrategy, ViewEncapsulation,
  EnvironmentInjector,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { VirtualScroller, ScrollerApi, VsElement, VsItem, VsConfig, VsOptions, VsScrollInfo, VsDebugStats } from '../../lib/virtual-scroll/virtual-scroller';
import { VirtualScrollerAnchor } from '../../lib/virtual-scroll/virtual-scroller-anchor';
import { ActivatedRoute } from '@angular/router';
import { classifyGroupFlags, GroupCtx } from '../../lib/virtual-scroll/group-logic';
import { LayoutService } from '../../services/layout.service';
import { createMsgVsElement, createGhostVsElement } from '../../components/message-cards/create-item';
import { mergeAlbumItems } from '../../components/message-cards/merge-items';
import { shouldShowDateSeparator, formatDateSeparator } from '../../components/message-cards/date-format';
import type { AlbumImage, ChatItemData, ChatMsgData } from '../../components/message-cards/chat-item';
import { MockItemSource, MockUserService } from './mock-chat-api';
import { UserAvatarComponent } from '../../components/user-avatar/user-avatar.component';

// Angular 生产 AOT 把全局 ngDevMode 置 falsy 并据此做死代码消除（与虚拟滚动内核同模式）。
// 用它守卫「调试角标注入」——生产构建不创建角标 DOM、零开销。非 Angular 环境该全局 undefined 同样关闭。
declare const ngDevMode: boolean | null | undefined;

// 内核调参默认值（与内核 DEFAULTS 同步：virtual-scroller.ts / anchor.ts）。mountPx 已删（array 内核死参数）。
const VS_DEFAULTS: Required<VsConfig> = { edge: 1000, mountItem: 50, thresholdFloor: 6000, vhExtra: 2000, initBatch: 100 };

/**
 * 虚拟滚动实验场。
 *
 * 渲染与真实聊天完全一致——createItem 调 createMsgVsElement（真实 message-cards 组件），
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
  selector: 'app-virtual-scroll-playground',
  imports: [FormsModule, UserAvatarComponent],
  templateUrl: './virtual-scroll-playground.component.html',
  styleUrl: './virtual-scroll-playground.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
})
export class VirtualScrollPlaygroundComponent implements OnDestroy {
  private readonly layout = inject(LayoutService);
  private readonly route = inject(ActivatedRoute);
  /** 动态创建消息组件（zoneless 下 createComponent + detectChanges 驱动渲染）。 */
  private readonly envInjector = inject(EnvironmentInjector);
  /** 方案 A（借浏览器锚定）由路由 data.useNativeAnchor 决定：-a 路由为 true，-b（默认）走方案 B（手动补偿）。 */
  readonly useNativeAnchor = (this.route.snapshot.data as { useNativeAnchor?: boolean }).useNativeAnchor === true;
  /** 桌面级视口(宽屏+精确指针)：true=常驻侧栏；false=移动抽屉+FAB。 */
  readonly isDesktop = this.layout.isDesktop;
  /** 移动端控制面板抽屉开关。 */
  readonly panelOpen = signal(false);
  /** 输入栏为避让软键盘上移的像素（visualViewport 计算，iOS 兜底）。 */
  readonly keyboardOffset = signal(0);

  /** mock 数据源（实现 VsSource；buildItems 生成器分页）。setup 时按 count 创建。 */
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
  private readonly draftInput = viewChild<ElementRef<HTMLTextAreaElement>>('draftInput');
  private readonly inputBarRef = viewChild<ElementRef<HTMLFormElement>>('inputBar');
  private readonly attachInput = viewChild<ElementRef<HTMLInputElement>>('attachInput');
  private readonly jumpInput = viewChild<ElementRef<HTMLInputElement>>('jumpInput');

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
  /** 内核调参（VsConfig）。setup 传给内核；编辑弹窗改 → applyConfig 重建生效。 */
  readonly config = signal<Required<VsConfig>>({ ...VS_DEFAULTS });
  /** 参数编辑弹窗开关 + 草稿（确认才 apply，避免改一个字段就重建）。 */
  readonly configModalOpen = signal(false);
  readonly configDraft = signal<Required<VsConfig>>({ ...VS_DEFAULTS });
  /** Telegram 式粘性日期：当前视口顶所属日期标签（滚动实时更新；null=不显浮层）。 */
  readonly stickyDate = signal<string | null>(null);
  /** 主题：light / dark。默认跟随系统 prefers-color-scheme，可手动 toggle 临时覆盖（系统变化时再跟随）。 */
  readonly theme = signal<'light' | 'dark'>('light');
  private themeMqCleanup: (() => void) | null = null;
  toggleTheme() { this.theme.update(t => t === 'light' ? 'dark' : 'light'); }

  // 控件
  readonly count = signal(5000);
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
      const Ctor: new (opts: VsOptions<ChatItemData>) => ScrollerApi<ChatItemData> =
        this.useNativeAnchor ? VirtualScrollerAnchor : VirtualScroller;
      this.scroller = new Ctor({
        viewport, content, source: this.source,
        config: this.config(),
        hooks: { createItem: (item, prev) => this.createItemEl(item, prev), mergeItems: mergeAlbumItems },
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

  /** 打开参数编辑弹窗（草稿 = 当前 config 副本）。 */
  openConfigModal(): void {
    this.configDraft.set({ ...this.config() });
    this.configModalOpen.set(true);
  }
  cancelConfigModal(): void { this.configModalOpen.set(false); }
  /** 弹窗编辑：改 draft 某字段（确认才 apply）。模板内不直接调 signal.update —— strict 模板类型检查对模板内 signal 方法绑定推断不出签名 → TS2345 整编译失败、新代码全不进 bundle。 */
  setConfigDraft(field: keyof VsConfig, value: number): void {
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

  private createItemEl(item: VsItem<ChatItemData>, prev: VsItem<ChatItemData> | null): VsElement<ChatItemData> {
    // 骨架占位：最顶条（prev=null 且未到全局最老）不渲真实组件，固定高度 shimmer（见 createGhostVsElement）。
    // prev=null ⟺ 被 prepend 成新 oldest；boundary!=='oldest' 排除全局最老（那条 noOlder、非 ghost、须真实渲）。
    if (prev === null && item.boundary !== 'oldest') return createGhostVsElement();
    // 分组判定 + date 分隔均按【更老邻居 prev】算（内核传入；抽象 id+1）：追加新条时原末条高度不变、无需重渲。
    let isShowHead = true, isGroupStart = false;
    let dateLabel: string | null = null;
    if (item.data.type === 'msg') {
      const msg = item.data;
      const prevMsg = prev?.data.type === 'msg' ? prev.data : null;
      const curCtx: GroupCtx = { creator: msg.creator };
      const prevCtx: GroupCtx | null = prevMsg ? { creator: prevMsg.creator } : null;
      isShowHead = classifyGroupFlags(prevCtx, curCtx, null).isShowHead;
      isGroupStart = isShowHead && !!prevMsg;
      // date 分隔：前端按窗口内前一条 prev 跨日判定（date 已从 source 移出）。oldest 上方固定显 date；
      // trim 重挂 prev==null 非 oldest 不显（防闪烁，见 date-format.shouldShowDateSeparator）。
      dateLabel = shouldShowDateSeparator(prevMsg?.createdAtMs ?? null, msg.createdAtMs, item.boundary === 'oldest')
        ? formatDateSeparator(msg.createdAtMs) : null;
    }
    const vs = createMsgVsElement(item, isShowHead, isGroupStart, dateLabel, this.envInjector);
    // 调试角标（首/续 + 消息 id）：playground 动态注入到行内，ngDevMode 守卫 → 生产 AOT 不创建。
    if (ngDevMode) this.attachDevBadge(vs.el, item, isShowHead);
    return vs;
  }

  /** 注入调试角标到 .pg-msg-row：首(绿)/续(橙) + 消息 id。仅 dev（ngDevMode）；destroy 随组件卸载。 */
  private attachDevBadge(host: HTMLElement, item: VsItem<ChatItemData>, isHead: boolean): void {
    const d = item.data;
    if (d.type !== 'msg') return; // 仅消息行（date 行无分组概念）
    const row = host.querySelector('.pg-msg-row');
    if (!row) return;
    const badge = document.createElement('span');
    badge.className = 'pg-dev-badge' + (isHead ? ' pg-dev-badge--head' : ' pg-dev-badge--body');
    badge.textContent = this.devIdLabel(d);
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
    return d.msgId;
  }

  /** balance 诊断 → console.debug（调试模式 + 仅有挂载/卸载活动 + 节流，避免空闲刷屏）。 */
  private onBalanceDebug(s: VsDebugStats) {
    if (!this.debugMode()) return;
    if (s.mount + s.unmount === 0) return;
    const now = performance.now();
    if (now - this.lastDebugLog < 200) return;
    this.lastDebugLog = now;
    console.debug('[vs balance]', s);
  }

  private onScroll(info: VsScrollInfo) {
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
    // 顶部 ghost 加载 spinner（.vs-ghost-loading，居中）显形时与居中日期浮层重叠 →
    // spinner 出现在视口顶（bottom 越过视口顶）时不显浮层让位（spinner 走后自然恢复；行内 date 仍在）。
    const ghost = ct.querySelector('.vs-ghost-loading');
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
    if (!/^-?\d+$/.test(s)) { this.showToast('跳转仅支持 id 数字'); return; }
    const n = parseInt(s, 10);
    if (n < 0) { this.showToast('id 须非负'); return; }
    scroller.scrollToIndex(`id-${n}`, 'center', true);
    if (input) input.value = '';
  }

  private showToast(msg: string): void {
    this.toast.set(msg);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(null), 1800);
  }

  toTop() { this.scroller?.scrollToTop(); }
  toBottom() { this.scroller?.scrollToBottom(); }

  // 输入栏：Enter 发送、Shift+Enter 换行
  onInputKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void this.send();
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
    if (this.draft().trim()) void this.send();
    else this.onAttachClick();
  }

  onAttachClick() { this.attachInput()?.nativeElement.click(); }

  onAttachChange(e: Event) {
    const input = e.target as HTMLInputElement;
    void this.sendMediaFromFile(input.files);
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

  /** mock 发送文本：构造一条 self 的 PURE_TEXT，appendLive（内核分配负抽象 id + 贴底跟随）。 */
  async send(): Promise<void> {
    const text = this.draft().trim();
    const scroller = this.scroller;
    if (!text || !scroller) return;
    scroller.appendLive([this.makeMockItem(text, true, 'PURE_TEXT', null)]);
    this.draft.set('');
    this.autoGrow();
    // 模拟对方延迟回复（验证收消息 appendLive + 贴底跟随）
    setTimeout(() => { void this.receiveReply(); }, 600 + Math.floor(Math.random() * 1200));
  }

  /** 模拟对方回复（WS）：appendLive；内核按当时是否贴底决定跟随滚到底。 */
  private async receiveReply(): Promise<void> {
    const scroller = this.scroller;
    if (!scroller) return;
    const phrase = REPLY_PHRASES[Math.floor(Math.random() * REPLY_PHRASES.length)];
    scroller.appendLive([this.makeMockItem(phrase, false, 'PURE_TEXT', null)]);
  }

  /**
   * mock 发送图片：本地读图为 dataURL + 真实尺寸 → appendLive（多图合并一条相册，与真实语义一致）。
   * 真实流程的 uploadMedia/sendMessage 在 mock 下省略（数据本就在前端）。
   */
  async sendMediaFromFile(files: FileList | null): Promise<void> {
    const scroller = this.scroller;
    if (!files || files.length === 0 || !scroller) return;
    const list = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (list.length === 0) return;
    const imgs = await readImages(list);
    if (imgs.length === 0) return;
    scroller.appendLive([this.makeMockItem('', true, 'IMAGE', imgs)]);
  }

  /** 构造一条 mock ChatMsgData 并包成 VsItem（id 占位，appendLive 内由 source 覆盖为抽象 id）。 */
  private makeMockItem(text: string, isSelf: boolean, contentType: ChatMsgData['contentType'], images: AlbumImage[] | null): VsItem<ChatItemData> {
    const now = new Date();
    const data: ChatMsgData = {
      type: 'msg',
      msgId: `${isSelf ? 'mock' : 'recv'}-${this.sendSeq++}`,
      creator: isSelf ? 1 : 2,
      isSelf: false, name: '',  // 占位：source.appendLive 的 shape 按 creator 从 profiles 查填（镜像生产 toMsgData）
      text,
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      contentType, images, createdAtMs: now.getTime(),
    };
    return { id: data.msgId, data };
  }
  private sendSeq = 0;
}

/** 对方回复候选（mock）。 */
const REPLY_PHRASES = ['在吗？', '收到', '哈哈', '好的', '虚拟滚动稳吗？', '看看挂载数'];

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
