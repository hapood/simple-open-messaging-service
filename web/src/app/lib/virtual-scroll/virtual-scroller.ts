/**
 * VirtualScroller —— 相对滚动 + sentinel 的虚拟列表（聊天流式追加范式）。
 *
 * 【设计】区别于「绝对定位 + 全局前缀和」的旧内核：
 * - 不维护全局 tops/heights 前缀和。聊天是流式追加、贴底为主、不跳任意 index、滚动条
 *   全平台隐藏，故无需「未挂载 item 的精确位置」——只管已挂载区域（见 docs 设计文档
 *   「滚动架构」章节）。砍掉这套后，scrollToIndex 到未挂载任意位置不再支持（用不到）。
 * - content 用普通文档流（元素 block 堆叠，非绝对定位）；native scroll 直接滚文档流，
 *   享受合成器线程 120Hz + 移动端 fling。
 * - 元素通过 {@link VsElement} 接口自报高度：estimateHeight() 给挂载瞬间/实测前的占位，
 *   onHeightChange() 上报真实变动。内核只缓存「已挂载」元素的高度（用于锚点补偿），
 *   绝不为未挂载 item 估算——那是绝对定位架构才需要的。
 * - 双向回收（balance）：视口上下各保留 buffer 像素。
 *     · 上方挂载不足（向上滚看更早）→ 挂载更早 item 到顶部 + scrollTop += 其高（锚点补偿）。
 *     · 上方余量过多 → 卸载顶部远端 + scrollTop -= 其高（锚点补偿，视觉不跳）。
 *     · 下方挂载不足 → 挂载后续 item 到底部（DOM append）。
 *     · 下方余量过多 → 卸载底部远端（不动 scrollTop，底部不影响上方锚点）。
 * - 框架无关：不 import Angular。元素可是 ng 组件或手写 DOM，只要实现 VsElement。
 *
 * 【锚点补偿原理】content 是普通文档流，视口上方元素的高度变化/增删都会让下方内容位移。
 *   凡是「发生在视口顶之上」的高度变化，都要给 scrollTop 加上等量 delta，使视口内元素
 *   相对位置不变（视觉不跳）。视口内/下方的变化则不补偿（内容自然重排）。
 */

/**
 * Angular 生产 AOT 会把全局 ngDevMode 置为 falsy 并据此做死代码消除。
 * 内核用它守卫所有诊断采集（balance 测时 / 挂载卸载计数 / onDebug 回调），
 * 使生产 bundle 不含任何诊断代码、热路径零开销；非 Angular 环境该全局 undefined 同样关闭。
 * 仅声明全局、不 import @angular/core，保持内核框架无关。
 */
declare const ngDevMode: boolean | null | undefined;

export interface VsItem<T = unknown> {
  id: string | number;
  data: T;
}

/**
 * 已挂载元素的句柄——内核只通过它操作元素，框架无关。
 * createItem 返回它；ng 组件（phase-4）与手写 DOM（playground）各自实现。
 *
 * 两个高度方法都只在「元素已挂载或正在挂载」时被调用，故作为实例方法自洽，
 * 不触碰「未挂载 item 需估算」这个禁区（那是绝对定位架构的事，本内核已废弃）。
 */
export interface VsElement<T = unknown> {
  /** 挂到 content 的根 DOM 节点（内核负责插入/移除）。 */
  readonly el: HTMLElement;
  /**
   * 高度估算：挂载瞬间、实测上来前的占位高度。
   * 用途：(1) 首帧定位/prepend 预补偿——避免挂载那一帧到实测上来之间的跳变；
   *       (2) balance 计算卸载/挂载量的初值。返回 >0。
   */
  estimateHeight(): number;
  /**
   * 订阅真实高度变动。元素内可用 ResizeObserver / ngAfterViewInit / img load 等。
   * 内核挂载时订阅，卸载时调用返回的取消订阅函数。
   */
  onHeightChange(cb: (height: number) => void): () => void;
  /** 内核卸载元素时调用：销毁 ng view / 断开 observer / 清理（el 已从 DOM 移除）。 */
  destroy(): void;
}

export interface VsHooks<T = unknown> {
  /** 创建并返回一个已就绪的元素句柄。index 为该 item 在 items 数组中的下标（宿主可据此按邻居算分组等）。 */
  createItem: (item: VsItem<T>, index: number) => VsElement<T>;
}

export interface VsOptions<T = unknown> {
  /** overflow:auto 的滚动容器（原生滚动）。 */
  viewport: HTMLElement;
  /** 内容层：普通文档流，子节点由内核挂载（item block 堆叠）。 */
  content: HTMLElement;
  hooks: VsHooks<T>;
  /**
   * 顶部哨兵节点：位于 content 最前。提供 onLoadMore 时，内核用 IntersectionObserver
   * 观察它——进入视口即触发向上加载历史。哨兵本身不占布局（height:0/1px）。
   */
  topSentinel?: HTMLElement;
  /**
   * 像素 buffer：首批挂载（setItems/scrollToBottom）时视口外预渲染的像素量，也是 sentinel 提前触发的
   * rootMargin。默认 3×viewportHeight（随屏高缩放，取代固定 1500）。
   */
  buffer?: number;
  /**
   * 向上滚到当前挂载顶（无更早已加载数据）时回调，返回新历史 item 或 null（无更多）。
   * 提供它才启用 sentinel 自动加载；不提供则只能由宿主手动调 prepend。
   */
  onLoadMore?: () => VsItem<T>[] | null;
  /** 滚动/挂载状态变化回调（RAF 频率，balance 后触发）。 */
  onScroll?: (info: VsScrollInfo) => void;
  /**
   * 调试：每帧 balance 后回调单帧统计（耗时 / 挂载卸载数 / scrollTop）。
   * 提供它才采集诊断（接调试 UI 排查卡顿）；不提供则零开销。
   */
  onDebug?: (stats: VsDebugStats) => void;
  /**
   * balance 条数缓冲阈值（窗口回收/挂载判定）：缓冲 <mount 才挂载、>recycle 才回收、维持 target 条。
   * 默认 { mount: 20, recycle: 80, target: 40 }；scrollToBottom 上方 buffer 也用 target（口径一致）。
   */
  balance?: { mount: number; recycle: number; target: number };
}

export interface VsScrollInfo {
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  /** 已挂载区间 [mountedStart, mountedEnd)。 */
  mountedStart: number;
  mountedEnd: number;
  mounted: number;
  total: number;
  atTop: boolean;
  atBottom: boolean;
}

/** 单帧 balance 诊断（onDebug 回调载荷，仅供调试 UI 消费）。 */
export interface VsDebugStats {
  /** 本帧 balance 耗时（ms）。 */
  ms: number;
  /** 本帧新增挂载元素数。 */
  mount: number;
  /** 本帧卸载元素数。 */
  unmount: number;
  /** 本帧结束 scrollTop（px）。 */
  scrollTop: number;
  /** 本帧结束挂载区间 [mountedStart, mountedEnd)。 */
  mountedStart: number;
  mountedEnd: number;
  /** 本帧 scrollTop 变化量（补偿幅度；正=补增、负=补减）。fling 期间持续非 0 = 每帧都在写 scrollTop 与合成器对冲。 */
  dScroll?: number;
  /** 本帧结束后视口顶/底 item index。 */
  topIdx?: number;
  botIdx?: number;
  /** 视口上方/下方挂载条数（缓冲厚度；上方降到 bufItems 触发顶部挂载，下方超 bufItems 触发底部回收）。 */
  aboveN?: number;
  belowN?: number;
  /** 视口上方/下方内容像素（= 还能向上/向下滚多少才触发挂载或回收）。 */
  abovePx?: number;
  belowPx?: number;
  /** 本帧上方(顶部)挂载/回收的 item index。 */
  topMounted?: number[];
  topUnmounted?: number[];
  /** 本帧下方(底部)挂载/回收的 item index。 */
  botMounted?: number[];
  botUnmounted?: number[];
}

/**
 * 内核对外公共能力。方案 A（{@link VirtualScrollerAnchor}，借浏览器锚定）与方案 B（{@link VirtualScroller}，
 * 手动补偿）都满足此契约；playground 据路由 data 选其一实例化。两套硬分叉、互不改对方代码，便于 a/b 对比。
 */
export interface ScrollerApi<T = unknown> {
  setItems(items: VsItem<T>[]): void;
  appendItems(newItems: VsItem<T>[]): void;
  prependItems(newItems: VsItem<T>[]): void;
  scrollToBottom(): void;
  scrollToTop(): void;
  /** 跳到指定 index（anchor 决定该 item 落在视口顶/中/底）。两套内核都支持。 */
  scrollToIndex(index: number, anchor?: 'top' | 'center' | 'bottom'): void;
  getInfo(): VsScrollInfo;
  refresh(): void;
  destroy(): void;
}

const DEFAULT_BUFFER = 1500;

export class VirtualScroller<T = unknown> implements ScrollerApi<T> {
  private readonly viewport: HTMLElement;
  private readonly content: HTMLElement;
  private readonly topSentinel?: HTMLElement;
  private readonly hooks: VsHooks<T>;
  private readonly onLoadMore?: () => VsItem<T>[] | null;
  private readonly onScroll?: (info: VsScrollInfo) => void;
  private readonly buffer: number;
  /** balance 条数缓冲阈值（来自 opts.balance，默认 20/80/40）。 */
  private readonly bMount: number;
  private readonly bRecycle: number;
  private readonly bTarget: number;
  /** 待批量首测的已挂载 index（mount 加入、measurePending 消费）。延迟首测：mount 不读 offsetHeight。 */
  private pendingMeasure: number[] = [];
  /** measurePending 进行中：屏蔽 onElHeight 的补偿/scheduleBalance 重入（balance 统一补偿）。 */
  private measuring = false;

  private items: VsItem<T>[] = [];
  private mountedStart = 0;
  private mountedEnd = 0;
  /** 已挂载 index -> 元素句柄。 */
  private elements = new Map<number, VsElement<T>>();
  /** 已挂载 index -> 缓存高度（mount 时存 estimateHeight，onHeightChange 更新）。 */
  private heights = new Map<number, number>();
  /** 已挂载 index -> onHeightChange 取消订阅函数。 */
  private unsubs = new Map<number, () => void>();

  private viewportHeight = 0;
  private shifting = false; // 程序化改 scrollTop 中，忽略由此引发的 scroll 事件防递归
  private mounting = false; // mount 内首次 onHeightChange 上报：跳过补偿/balance，防重入
  private loadingMore = false; // onLoadMore 进行中，防 sentinel 重复触发
  private noMoreHistory = false; // onLoadMore 已返回 null，不再自动加载
  private destroyed = false;

  private rafId = 0;
  private dirty = false;
  private readonly sentinelObs?: IntersectionObserver;
  private readonly viewportObs: ResizeObserver;
  /** 调试回调（opts.onDebug）：提供则每帧 balance 上报单帧统计。 */
  private readonly onDebug?: (stats: VsDebugStats) => void;
  private mountTick = 0;   // 累计 mount 次数（balance 取差算单帧挂载量）
  private unmountTick = 0; // 累计 unmount 次数

  constructor(opts: VsOptions<T>) {
    this.viewport = opts.viewport;
    this.content = opts.content;
    this.topSentinel = opts.topSentinel;
    this.hooks = opts.hooks;
    this.onLoadMore = opts.onLoadMore;
    this.onScroll = opts.onScroll;
    this.onDebug = opts.onDebug;

    this.viewportObs = new ResizeObserver(() => { this.measureViewport(); this.scheduleBalance(); });
    this.measureViewport();
    this.viewportObs.observe(this.viewport);
    // 像素 buffer 默认 3×vh（随屏高，DEFAULT_BUFFER 作 vh=0 下限）；条数 buffer 默认 20/80/40。
    // measureViewport 先行，确保 viewportHeight 已知。
    this.buffer = opts.buffer ?? Math.max(DEFAULT_BUFFER, this.viewportHeight * 3);
    const bal = opts.balance ?? { mount: 20, recycle: 80, target: 40 };
    this.bMount = bal.mount;
    this.bRecycle = bal.recycle;
    this.bTarget = bal.target;
    this.viewport.addEventListener('scroll', this.onNativeScroll, { passive: true });

    if (this.topSentinel && this.onLoadMore) {
      // rootMargin 让哨兵在「距视口顶 buffer 之内」就提前触发，留出加载时间。
      this.sentinelObs = new IntersectionObserver(entries => {
        if (entries.some(e => e.isIntersecting)) this.maybeLoadMore();
      }, { root: this.viewport, rootMargin: `${this.buffer}px 0px ${this.buffer}px 0px` });
      this.sentinelObs.observe(this.topSentinel);
    }
  }

  // ---------- 公共 API ----------

  /** 装入/替换全部数据。从顶部开始挂载首批（填满视口 + buffer）。 */
  setItems(items: VsItem<T>[]) {
    this.unmountAll();
    this.items = items;
    this.mountedStart = 0;
    this.mountedEnd = 0;
    this.noMoreHistory = false;
    this.mountInitialForward(); // 从 0 向底挂载首批
    this.shifting = true;
    this.viewport.scrollTop = 0;
    this.shifting = false;
    this.emit();
  }

  /** 追加若干 item 到末尾。当时贴底则挂载并跟随到新底部。 */
  appendItems(newItems: VsItem<T>[]) {
    if (this.destroyed || newItems.length === 0) return;
    const wasAtBottom = this.isAtBottom();
    for (const it of newItems) this.items.push(it);
    if (wasAtBottom) {
      // 贴底：挂载新元素到底部，再钉到底。
      this.shifting = true;
      for (let i = this.mountedEnd; i < this.items.length; i++) {
        this.mount(i);
        this.mountedEnd = i + 1;
      }
      this.measurePending();
      this.viewport.scrollTop = this.content.scrollHeight - this.viewportHeight;
      this.shifting = false;
    }
    // 不贴底则不主动挂载——用户滚下/底部 balance 时自然挂上。
    this.emit();
  }

  /** 在头部插入若干 item（下拉加载历史）。scrollTop += 新增高度，视觉不动。 */
  prependItems(newItems: VsItem<T>[]) {
    if (this.destroyed || newItems.length === 0) return;
    const len = newItems.length;
    this.noMoreHistory = false;
    // 1. 现有挂载元素的 index 整体后移 len（平移三个 Map 的 key）。
    this.shiftKeys(len);
    // 2. 数据 unshift。
    this.items.unshift(...newItems);
    this.mountedStart += len;
    this.mountedEnd += len;
    // 3. 挂载新元素 0..len-1 到顶部（DOM 插到最前），累加其高度做锚点补偿。
    this.shifting = true;
    for (let i = len - 1; i >= 0; i--) {
      this.mount(i); // 从后往前 mount，邻居查找正确串成顺序
    }
    // 不重渲原首条（现 index=len）：它的 prev 从 null 变成 prepend 末条，分组本应重算——
    // 但宿主用"幽灵 prev"（prepend 末条.creator 即旧 items[0] prev 的 creator）保证分组不变，
    // 故无需重渲、零 reflow。见 playground fetchOlder 的衔接不变量。
    this.measurePending(); // 测新挂历史元素的真实高度，再算补偿（量小，单次 reflow 可接受）
    let added = 0;
    for (let i = 0; i < len; i++) added += this.heightOf(i);
    this.viewport.scrollTop += added; // 新元素加在视口上方 → scrollTop += 其总高，视口内容不动
    this.shifting = false;
    this.emit();
  }

  /** 滚到底部：卸载全部，从末尾往前挂载一批（填满视口 + balance.target 条上方 buffer），钉到底。 */
  scrollToBottom() {
    if (this.destroyed) return;
    this.unmountAll();
    this.mountedEnd = this.items.length;
    this.mountedStart = this.items.length;
    // 从末尾往前挂载：先挂满视口，再多挂 bTarget 条上方 buffer——与 balance target 口径一致（默认 40）。
    // 旧实现用像素 buffer 建宽窗口，首帧 balance 要把多出条数一次性回收 + 大补偿，与下滑手势对冲 → 鬼畜。
    // 口径一致后首帧无多余窗口、无大补偿。
    this.shifting = true;
    while (this.mountedStart > 0 && this.totalMountedHeight() < this.viewportHeight) {
      this.mountedStart--;
      this.mount(this.mountedStart);
    }
    for (let i = 0; i < this.bTarget && this.mountedStart > 0; i++) {
      this.mountedStart--;
      this.mount(this.mountedStart);
    }
    this.measurePending();
    this.fillBackward(); // 防御兜底：预估偏大致上方挂载不足时，按真实内容高补满视口+buffer
    this.viewport.scrollTop = this.content.scrollHeight - this.viewportHeight;
    this.shifting = false;
    this.ensureFilled(); // 内容不足一屏则加载更早历史填满（首次加载/数据稀少）
    this.emit();
  }

  /**
   * 内容不足一屏时持续加载更早历史直到填满视口或无更多。sentinel IO 不会因哨兵持续可见而重复触发
   *（intersection 无变化），故此处显式循环；加载后若内容已超过视口，重新钉到底（之前 scrollTop 被 clamp 在 0）。
   */
  private ensureFilled() {
    if (!this.onLoadMore) return;
    let guard = 0;
    while (!this.noMoreHistory && this.content.scrollHeight < this.viewportHeight && guard++ < 100) {
      const more = this.onLoadMore();
      if (!more || !more.length) { this.noMoreHistory = true; break; }
      this.prependItems(more);
    }
    if (this.content.scrollHeight >= this.viewportHeight) {
      this.shifting = true;
      this.viewport.scrollTop = this.content.scrollHeight - this.viewportHeight;
      this.shifting = false;
    }
  }

  /**
   * 防御兜底：预估高度偏大致 {@link scrollToBottom} 的向上挂载不足（content 未覆盖视口+buffer）时，
   * 按【真实】content.scrollHeight 继续向上挂载补满。常态（bTarget 缓冲已足）下首条判定即不满足、
   * 循环零执行、零开销；仅预估明显偏大或元素极矮时补几条。补完由调用方据新内容高钉底。
   * dev（ngDevMode）下若实际补挂了条数，console.warn 提示——预估偏差的可见信号。
   */
  private fillBackward() {
    const startBefore = this.mountedStart;
    const hBefore = this.content.scrollHeight;
    while (this.mountedStart > 0 && this.content.scrollHeight - this.viewportHeight < this.buffer) {
      this.mountedStart--;
      this.mount(this.mountedStart);
    }
    this.measurePending();
    if (ngDevMode && this.mountedStart !== startBefore) {
      console.warn('%c[vs-fillBackward] 预估偏大，首帧挂载不足已兜底补挂', 'color:#e91e63;font-weight:700', {
        补挂条数: startBefore - this.mountedStart,
        内容高: `${hBefore} → ${this.content.scrollHeight}`,
        视口: this.viewportHeight,
        buffer: this.buffer,
      });
    }
  }

  /** 滚到顶部：卸载全部，从 0 向底挂载首批，钉到顶。 */
  scrollToTop() {
    if (this.destroyed) return;
    this.unmountAll();
    this.mountedStart = 0;
    this.mountedEnd = 0;
    this.mountInitialForward();
    this.shifting = true;
    this.viewport.scrollTop = 0;
    this.shifting = false;
    this.emit();
  }

  /**
   * 跳到指定 index（anchor 决定该 item 落在视口顶/中/底）。卸载全部后挂载目标周围窗口
   * （向下填满视口+buffer、向上 bTarget 条 buffer），再据【已挂载】高度算 scrollTop。
   * 所需 index 在写 scrollTop 前都已挂载（缓存有高），无需为未挂载 item 估算——不破坏
   * 「不估算未挂载」原则。方案 A（{@link VirtualScrollerAnchor}）同构实现。
   */
  scrollToIndex(index: number, anchor: 'top' | 'center' | 'bottom' = 'top') {
    if (this.destroyed || this.items.length === 0) return;
    const idx = Math.max(0, Math.min(index, this.items.length - 1));
    this.unmountAll();
    this.mountedStart = idx;
    this.mountedEnd = idx;
    this.shifting = true;
    // 向下挂载直到填满视口 + buffer（同 mountInitialForward 口径）。
    while (this.mountedEnd < this.items.length
           && this.content.scrollHeight - this.viewportHeight < this.buffer) {
      this.mount(this.mountedEnd);
      this.mountedEnd++;
    }
    // 向上 bTarget 条 buffer（与 scrollToBottom 上方 buffer 同口径）。
    for (let i = 0; i < this.bTarget && this.mountedStart > 0; i++) {
      this.mountedStart--;
      this.mount(this.mountedStart);
    }
    this.measurePending();
    // scrollTop = 目标 item 顶端距 content 顶（topOf 累加已挂载高度）+ anchor 偏移，clamp 到可滚区间。
    let st = this.topOf(idx);
    const h = this.heightOf(idx);
    if (anchor === 'center') st += h / 2 - this.viewportHeight / 2;
    else if (anchor === 'bottom') st += h - this.viewportHeight;
    const max = this.content.scrollHeight - this.viewportHeight;
    this.viewport.scrollTop = Math.max(0, Math.min(st, max));
    this.shifting = false;
    this.emit();
  }

  getInfo(): VsScrollInfo {
    return {
      scrollTop: Math.round(this.viewport.scrollTop),
      scrollHeight: Math.round(this.content.scrollHeight),
      viewportHeight: this.viewportHeight,
      mountedStart: this.mountedStart,
      mountedEnd: this.mountedEnd,
      mounted: this.elements.size,
      total: this.items.length,
      atTop: this.mountedStart === 0 && this.viewport.scrollTop <= 0,
      atBottom: this.mountedEnd === this.items.length && this.isAtBottom(),
    };
  }

  /** 强制重测视口并重平衡（外部布局变化、dvh 稳定后调用）。 */
  refresh() {
    this.measureViewport();
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    this.dirty = false;
    this.balance();
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.rafId);
    this.sentinelObs?.disconnect();
    this.viewportObs.disconnect();
    this.viewport.removeEventListener('scroll', this.onNativeScroll);
    this.unmountAll();
  }

  // ---------- 挂载 / 卸载 ----------

  /** 挂载 index i：创建元素句柄、按邻居插入 DOM（维持 DOM 顺序 = 索引顺序）、订阅高度。 */
  private mount(i: number) {
    if (this.elements.has(i)) return;
    if (ngDevMode) this.mountTick++;
    const vs = this.hooks.createItem(this.items[i], i);
    const el = vs.el;
    el.dataset['vsIdx'] = String(i);
    // 邻居插入：i-1 已挂载→插其后；否则 i+1 已挂载→插其前；否则 append（首个，落在哨兵后）。
    const prev = this.elements.get(i - 1)?.el;
    const next = this.elements.get(i + 1)?.el;
    if (prev) prev.after(el);
    else if (next) this.content.insertBefore(el, next);
    else this.content.appendChild(el);
    this.elements.set(i, vs);
    this.heights.set(i, vs.estimateHeight()); // 初值；measurePending 批量测真实（延迟首测，避免每 mount 一次 reflow）
    el.classList.add('vs-pending');            // 占位隐藏：测好前不可见，消除 estimate→真实的高度跳变 flicker
    this.pendingMeasure.push(i);               // 待批量测高
    // mounting：mount 内首次上报只更新缓存，不做补偿/balance——否则会在
    // mountInitialForward/scrollToBottom 挂载途中重入 balance（mountedEnd 未推进 → 重复挂载）。
    this.mounting = true;
    const stop = vs.onHeightChange(h => this.onElHeight(i, h));
    this.mounting = false;
    this.unsubs.set(i, stop);
  }

  /** 卸载 index i：取消订阅、移除 DOM、销毁句柄、清缓存。 */
  private unmount(i: number) {
    const vs = this.elements.get(i);
    if (!vs) return;
    if (ngDevMode) this.unmountTick++;
    this.unsubs.get(i)?.();
    if (vs.el.parentNode === this.content) this.content.removeChild(vs.el);
    vs.destroy();
    this.elements.delete(i);
    this.heights.delete(i);
    this.unsubs.delete(i);
  }

  private unmountAll() {
    for (const [, vs] of this.elements) {
      if (vs.el.parentNode === this.content) this.content.removeChild(vs.el);
      vs.destroy();
    }
    this.elements.clear();
    this.heights.clear();
    this.unsubs.clear();
  }

  /** 从 mountedStart 起向底挂载，直到视口下方有 buffer 余量。 */
  private mountInitialForward() {
    while (this.mountedEnd < this.items.length
           && this.content.scrollHeight - this.viewportHeight < this.buffer) {
      this.mount(this.mountedEnd);
      this.mountedEnd++;
    }
    this.measurePending();
  }

  // ---------- balance：双向回收 ----------

  private onNativeScroll = () => {
    if (this.shifting || this.destroyed) return;
    this.scheduleBalance();
  };

  private scheduleBalance() {
    if (this.dirty || this.destroyed) return;
    this.dirty = true;
    this.rafId = requestAnimationFrame(() => {
      this.dirty = false;
      this.balance();
    });
  }

  /**
   * 重平衡挂载窗口，使视口上下各保留 bufferItems 条。顺序：
   * 1. 底部挂载（视口底下不足 bufferItems 条→挂载后续）
   * 2. 底部回收（视口底下过多→卸载，不动 scrollTop）
   * 3. 顶部挂载（视口顶之上不足→挂载更早，锚点补偿）
   * 4. 顶部回收（视口顶之上过多→卸载，锚点补偿）
   * 3/4 互斥（向上滚→挂载、向下滚→回收）。挂载走延迟首测（vs-pending），末尾 measurePending 批量测高（1 reflow）。
   */
  private balance() {
    if (this.destroyed) return;
    // 缓冲阈值（宽滞后）：缓冲 <MOUNT_BELOW 才挂载到 TARGET、>RECYCLE_ABOVE 才回收到 TARGET。
    // 中间 [10,40) 死区不动——避免补偿/浏览器让 topIdx 越界触发 mount↔recycle 自激振荡。
    const MOUNT_BELOW = this.bMount, RECYCLE_ABOVE = this.bRecycle, TARGET = this.bTarget;
    // 记录本帧各方向挂载/回收的 item index（诊断"反复增删同一条"用）
    const topMounted: number[] = [];
    const topUnmounted: number[] = [];
    const botMounted: number[] = [];
    const botUnmounted: number[] = [];
    const t0 = ngDevMode ? performance.now() : 0;
    const m0 = this.mountTick, u0 = this.unmountTick;

    // 视口顶/底对应的 item index（用已挂载 heights 累加；条数 buffer 判定基准）。
    const topIdx = this.viewportTopIndex();
    const botIdx = this.viewportBottomIndex();

    // 1/2. 底部挂载/回收（互斥，宽滞后）：下方缓冲 <10 挂到 20、>40 回收到 20，中间死区不动。
    const below = (this.mountedEnd - 1) - botIdx;
    if (below < MOUNT_BELOW) {
      while (this.mountedEnd < this.items.length && (this.mountedEnd - 1) - botIdx < TARGET) {
        botMounted.push(this.mountedEnd);
        this.mount(this.mountedEnd);
        this.mountedEnd++;
      }
    } else if (below > RECYCLE_ABOVE) {
      while (this.mountedEnd - 1 > this.mountedStart && (this.mountedEnd - 1) - botIdx > TARGET) {
        botUnmounted.push(this.mountedEnd - 1);
        this.unmount(this.mountedEnd - 1);
        this.mountedEnd--;
      }
    }

    // 3/4. 顶部挂载或回收（互斥）。B 写 scrollTop 做锚点补偿。
    this.shifting = true;
    const topMountedStart = this.mountedStart;
    let recycleH = 0;
    // 3/4. 顶部挂载/回收（互斥，宽滞后）：上方缓冲 <10 挂到 20、>40 回收到 20，中间死区不动。
    const above = topIdx - this.mountedStart;
    if (above < MOUNT_BELOW) {
      // 3. 顶部挂载：上方缓冲不足 → 挂更早 item 到 TARGET（延迟首测）
      while (this.mountedStart > 0 && topIdx - this.mountedStart < TARGET) {
        this.mountedStart--;
        topMounted.push(this.mountedStart);
        this.mount(this.mountedStart);
      }
    } else if (above > RECYCLE_ABOVE) {
      // 4. 顶部回收：上方缓冲过多 → 卸远端到 TARGET（已测元素，累加高度待补偿）
      while (this.mountedStart < this.mountedEnd && topIdx - this.mountedStart > TARGET) {
        recycleH += this.heightOf(this.mountedStart);
        topUnmounted.push(this.mountedStart);
        this.unmount(this.mountedStart);
        this.mountedStart++;
      }
    }

    // 批量首测：测本批新挂载（步骤1 底部 + 步骤3 顶部）真实高度——循环内只写 DOM 不读布局，
    // 末尾一次性读 N 个 offsetHeight（同一 layout pass，1 次 reflow）。低端机快速 fling 收益最大。
    this.measurePending();

    // 顶部锚点补偿：步骤3 新挂载用已测真实高度累加 +；步骤4 回收 -recycleH。视觉不跳。
    let st = this.viewport.scrollTop;
    const scrollBefore = st; // 补偿前 scrollTop（算本帧 dScroll 用）
    for (let k = this.mountedStart; k < topMountedStart; k++) st += this.heightOf(k);
    st -= recycleH;
    this.viewport.scrollTop = st;
    this.shifting = false;

    this.emit();

    if (ngDevMode && this.onDebug) {
      // 后置视口界线与缓冲厚度（用补偿后 scrollTop 重算，反映本帧结束后的真实状态）。
      // dScroll≠0 = 本帧写了 scrollTop 补偿——fling 期间持续非 0 即每帧与合成器对冲的写（抖动来源）。
      const tIdx = this.viewportTopIndex();
      const bIdx = this.viewportBottomIndex();
      let abovePx = 0;
      for (let k = this.mountedStart; k < tIdx; k++) abovePx += this.heightOf(k);
      let belowPx = 0;
      for (let k = bIdx + 1; k < this.mountedEnd; k++) belowPx += this.heightOf(k);
      this.onDebug({
        ms: performance.now() - t0,
        mount: this.mountTick - m0,
        unmount: this.unmountTick - u0,
        scrollTop: Math.round(st),
        dScroll: Math.round(st - scrollBefore),
        mountedStart: this.mountedStart,
        mountedEnd: this.mountedEnd,
        topIdx: tIdx,
        botIdx: bIdx,
        aboveN: tIdx - this.mountedStart,
        belowN: (this.mountedEnd - 1) - bIdx,
        abovePx: Math.round(abovePx),
        belowPx: Math.round(belowPx),
        topMounted,
        topUnmounted,
        botMounted,
        botUnmounted,
      });
    }
  }

  // ---------- 高度 / 锚点补偿 ----------

  /** 已挂载元素 i 的缓存高度（mount 时已存 estimateHeight，必有值）。 */
  private heightOf(i: number): number {
    return this.heights.get(i) ?? this.elements.get(i)?.estimateHeight() ?? 0;
  }

  /** 元素 i 顶端距 content 顶的像素（累加 mountedStart..i-1 的高度）。 */
  private topOf(i: number): number {
    let acc = 0;
    for (let k = this.mountedStart; k < i; k++) acc += this.heightOf(k);
    return acc;
  }

  /** 已挂载元素总高（用于 scrollToBottom 判定挂载批量）。 */
  private totalMountedHeight(): number {
    let acc = 0;
    for (let k = this.mountedStart; k < this.mountedEnd; k++) acc += this.heightOf(k);
    return acc;
  }

  /**
   * 批量首测：对本批 pendingMeasure 的元素一次性读 offsetHeight（同一 layout pass = 1 次 reflow），
   * 更新 heights（经 onElHeight，measuring 标志屏蔽补偿/scheduleBalance 重入），再集中移 vs-pending。
   * 取代旧「mount 内同步读 offsetHeight」——后者每个 mount 一次 reflow，N 个 = N 次。
   */
  private measurePending() {
    if (this.pendingMeasure.length === 0) return;
    const ids = this.pendingMeasure;
    this.pendingMeasure = [];
    this.measuring = true;
    const measured: number[] = [];
    for (const i of ids) {
      const el = this.elements.get(i)?.el;
      if (!el) continue;
      measured.push(i);
      this.onElHeight(i, el.offsetHeight); // 读布局（批量合并）+ 更新缓存
    }
    for (const i of measured) this.elements.get(i)?.el.classList.remove('vs-pending');
    this.measuring = false;
  }

  /** 视口顶对应的 item index（其底端越过 scrollTop，即视口内最靠上的可见 item）。 */
  private viewportTopIndex(): number {
    let acc = 0;
    for (let k = this.mountedStart; k < this.mountedEnd; k++) {
      acc += this.heightOf(k);
      if (acc > this.viewport.scrollTop) return k;
    }
    return Math.max(this.mountedStart, this.mountedEnd - 1);
  }

  /** 视口底对应的 item index（其底端越过 scrollTop + vh）。 */
  private viewportBottomIndex(): number {
    const target = this.viewport.scrollTop + this.viewportHeight;
    let acc = 0;
    for (let k = this.mountedStart; k < this.mountedEnd; k++) {
      acc += this.heightOf(k);
      if (acc > target) return k;
    }
    return Math.max(this.mountedStart, this.mountedEnd - 1);
  }

  /** 元素上报真实高度变化：更新缓存，若发生在视口上方则锚点补偿。 */
  private onElHeight(i: number, h: number) {
    if (this.destroyed) return;
    const old = this.heights.get(i);
    if (old === h) return;
    this.heights.set(i, h);
    // 元素顶在视口顶之上 → 其高度变化会让下方位移，补偿 scrollTop 使视口不动。
    // mount 内首次上报（mounting）跳过补偿与 balance，避免挂载过程重入 balance。
    if (!this.shifting && !this.mounting && !this.measuring && old !== undefined && this.topOf(i) < this.viewport.scrollTop) {
      this.shifting = true;
      this.viewport.scrollTop += h - old;
      this.shifting = false;
    }
    if (!this.mounting && !this.measuring) this.scheduleBalance();
  }

  private isAtBottom(): boolean {
    return this.viewport.scrollTop + this.viewportHeight >= this.content.scrollHeight - 1;
  }

  // ---------- 历史加载 ----------

  private maybeLoadMore() {
    if (this.destroyed || this.loadingMore || this.noMoreHistory || !this.onLoadMore) return;
    // 仅当已滚到当前挂载顶（无更早已加载数据可由 balance 顶部挂载补上）才向宿主要新历史。
    if (this.mountedStart > 0) return;
    this.loadingMore = true;
    const more = this.onLoadMore();
    this.loadingMore = false;
    if (more && more.length) {
      this.prependItems(more);
    } else {
      this.noMoreHistory = true; // 宿主表示无更多 → 不再自动触发
    }
  }

  // ---------- 工具 ----------

  private measureViewport() {
    this.viewportHeight = this.viewport.clientHeight;
  }

  /** prepend 时把已挂载元素的 index 整体后移 n（重建三个 Map 的 key）。 */
  private shiftKeys(n: number) {
    if (n <= 0) return;
    this.heights = remap(this.heights, n);
    this.unsubs = remap(this.unsubs, n);
    // elements 含 VsElement 引用，单独重建。
    const els = new Map<number, VsElement<T>>();
    for (const [k, v] of this.elements) els.set(k + n, v);
    this.elements = els;
  }

  private emit() {
    this.onScroll?.(this.getInfo());
  }
}

/** Map<number, V> 的 key 整体 +n，返回新 Map。 */
function remap<V>(m: Map<number, V>, n: number): Map<number, V> {
  const r = new Map<number, V>();
  for (const [k, v] of m) r.set(k + n, v);
  return r;
}
