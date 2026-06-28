/**
 * VirtualScrollerAnchor —— 方案 A：借浏览器滚动锚定（与方案 B {@link VirtualScroller} 硬分叉）。
 *
 * 【与方案 B 的本质区别】
 * - 方案 B（virtual-scroller.ts）：文档流 + 内核手动写 scrollTop 做锚点补偿（顶部增删/上方变高时
 *   scrollTop += delta）。补偿必须逐像素准，且与浏览器锚定不能并存。
 * - 方案 A（本文件）：文档流 + **内核完全不写 scrollTop（顶部增删/变高时）**，交浏览器
 *   `overflow-anchor: auto`（默认）钉住「首个可见元素」→ 视口自动稳定。内核只管「挂哪些 item」。
 *
 * 【为何顶部窗口判定要换算法】
 *   方案 B 靠「挂载即推 scrollTop」形成反馈环终止挂载循环（scrollTop 一旦 >= buffer 就停）。
 *   方案 A 不推 scrollTop，循环没有自增变量 → 必须改用**累计计数法**：
 *     · 顶部挂载：deficit = buffer - scrollTop（还差多少上方内容）；挂到 deficit <= 0 停。
 *     · 顶部回收：excess = scrollTop - buffer（上方多出多少）；卸到 excess < 下一项高停。
 *   跨帧由浏览器把 scrollTop 校正到准确值（锚定副作用），故每帧 deficit/excess 都是基于真实位移算的。
 *
 * 【方案 A 的得失】
 *   + 稳定性交浏览器，对测量误差（estimate vs 实测、box 口径）免疫——不存在「补偿算错」这类 bug。
 *   + 挂载与锚定在同一 layout pass 完成，无方案 B 那「JS 补偿帧」的潜在 1 帧错位。
 *   − 依赖 overflow-anchor（2026 全平台支持；Safari 13.1+）；mock 环境无浏览器锚定，单测只能验「内核不补偿」。
 *   − 底部跟随（贴底收新消息）锚定帮不上（它钉顶部首个可见），仍需内核手动 scrollTop = max。
 *
 * 【借浏览器锚定的前提】宿主 viewport 必须 overflow-anchor: auto（默认）。方案 B 的 playground
 *   设了 overflow-anchor: none（让手动补偿独占）；方案 A 的 playground 不设 none（保持默认 auto）。
 */

import { ScrollerApi, VsDebugStats, VsElement, VsHooks, VsItem, VsOptions, VsScrollInfo } from './virtual-scroller';

export type { VsDebugStats, VsItem, VsElement, VsHooks, VsOptions, VsScrollInfo } from './virtual-scroller';

// Angular 生产 AOT 把全局 ngDevMode 置 falsy 并据此做死代码消除。方案 A 用它守卫诊断采集
// （与方案 B 对等）：生产 bundle 不含诊断代码、热路径零开销；非 Angular 环境该全局 undefined 同样关闭。
declare const ngDevMode: boolean | null | undefined;

const DEFAULT_BUFFER = 1500;

export class VirtualScrollerAnchor<T = unknown> implements ScrollerApi<T> {
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
  /** 调试回调（opts.onDebug）：提供则每帧 balance 上报单帧统计（与方案 B 对等）。 */
  private readonly onDebug?: (stats: VsDebugStats) => void;
  private mountTick = 0;
  private unmountTick = 0;
  /** 待批量首测的已挂载 index（mount 加入、measurePending 消费）。延迟首测：mount 不读 offsetHeight。 */
  private pendingMeasure: number[] = [];
  /** measurePending 进行中：屏蔽 onElHeight 的 scheduleBalance 重入。 */
  private measuring = false;

  private items: VsItem<T>[] = [];
  private mountedStart = 0;
  private mountedEnd = 0;
  private elements = new Map<number, VsElement<T>>();
  private heights = new Map<number, number>();
  private unsubs = new Map<number, () => void>();

  private viewportHeight = 0;
  private shifting = false; // 程序化改 scrollTop 中（贴底/跳转），忽略由此引发的 scroll 事件
  private mounting = false; // mount 内首次 onHeightChange：跳过 balance，防重入
  private loadingMore = false;
  private noMoreHistory = false;
  private destroyed = false;

  private rafId = 0;
  private dirty = false;
  private readonly sentinelObs?: IntersectionObserver;
  private readonly viewportObs: ResizeObserver;

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
    this.buffer = opts.buffer ?? Math.max(DEFAULT_BUFFER, this.viewportHeight * 3);
    const bal = opts.balance ?? { mount: 20, recycle: 80, target: 40 };
    this.bMount = bal.mount;
    this.bRecycle = bal.recycle;
    this.bTarget = bal.target;
    this.viewport.addEventListener('scroll', this.onNativeScroll, { passive: true });

    if (this.topSentinel && this.onLoadMore) {
      this.sentinelObs = new IntersectionObserver(entries => {
        if (entries.some(e => e.isIntersecting)) this.maybeLoadMore();
      }, { root: this.viewport, rootMargin: `${this.buffer}px 0px ${this.buffer}px 0px` });
      this.sentinelObs.observe(this.topSentinel);
    }
  }

  // ---------- 公共 API ----------

  setItems(items: VsItem<T>[]) {
    this.unmountAll();
    this.items = items;
    this.mountedStart = 0;
    this.mountedEnd = 0;
    this.noMoreHistory = false;
    this.mountInitialForward();
    this.shifting = true;
    this.viewport.scrollTop = 0;
    this.shifting = false;
    this.emit();
  }

  appendItems(newItems: VsItem<T>[]) {
    if (this.destroyed || newItems.length === 0) return;
    const wasAtBottom = this.isAtBottom();
    for (const it of newItems) this.items.push(it);
    if (wasAtBottom) {
      // 贴底跟随是锚定帮不上的（它钉顶部），内核手动钉到底。
      this.shifting = true;
      for (let i = this.mountedEnd; i < this.items.length; i++) {
        this.mount(i);
        this.mountedEnd = i + 1;
      }
      this.measurePending();
      this.viewport.scrollTop = this.content.scrollHeight - this.viewportHeight;
      this.shifting = false;
    }
    this.emit();
  }

  /** 在头部插入若干 item（下拉加载历史）。不写 scrollTop——浏览器锚定钉住首个可见元素，视觉不跳。 */
  prependItems(newItems: VsItem<T>[]) {
    if (this.destroyed || newItems.length === 0) return;
    const len = newItems.length;
    this.noMoreHistory = false;
    this.shiftKeys(len);
    this.items.unshift(...newItems);
    this.mountedStart += len;
    this.mountedEnd += len;
    // 挂载新元素 0..len-1 到顶部（从后往前 mount，邻居查找正确串成顺序）。不补偿 scrollTop。
    for (let i = len - 1; i >= 0; i--) {
      this.mount(i);
    }
    // 不重渲原首条（现 index=len）：宿主用"幽灵 prev"保证 prepend 后其分组不变，零 reflow。
    // 见 playground fetchOlder 的衔接不变量（末条.creator = 旧顶端幽灵 creator）。
    this.measurePending();
    this.emit();
  }

  scrollToBottom() {
    if (this.destroyed) return;
    this.unmountAll();
    this.mountedEnd = this.items.length;
    this.mountedStart = this.items.length;
    this.shifting = true;
    while (this.mountedStart > 0 && this.totalMountedHeight() < this.viewportHeight + this.buffer) {
      this.mountedStart--;
      this.mount(this.mountedStart);
    }
    this.measurePending();
    this.viewport.scrollTop = this.content.scrollHeight - this.viewportHeight;
    this.shifting = false;
    this.ensureFilled(); // 内容不足一屏则加载更早历史填满（首次加载/数据稀少）
    this.emit();
  }

  /** 内容不足一屏时持续加载更早历史直到填满视口或无更多；加载后重新钉到底。 */
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

  private mount(i: number) {
    if (this.elements.has(i)) return;
    if (ngDevMode) this.mountTick++;
    const vs = this.hooks.createItem(this.items[i], i);
    const el = vs.el;
    el.dataset['vsIdx'] = String(i);
    const prev = this.elements.get(i - 1)?.el;
    const next = this.elements.get(i + 1)?.el;
    if (prev) prev.after(el);
    else if (next) this.content.insertBefore(el, next);
    else this.content.appendChild(el);
    this.elements.set(i, vs);
    this.heights.set(i, vs.estimateHeight()); // 初值；measurePending 批量测真实（延迟首测）
    el.classList.add('vs-pending');            // 占位隐藏：测好前不可见，消除 estimate→真实 flicker
    this.pendingMeasure.push(i);               // 待批量测高
    // mounting：mount 内首次上报只更新缓存，不触发 balance（否则挂载途中重入，mountedEnd 未推进）。
    this.mounting = true;
    const stop = vs.onHeightChange(h => this.onElHeight(i, h));
    this.mounting = false;
    this.unsubs.set(i, stop);
  }

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

  private mountInitialForward() {
    while (this.mountedEnd < this.items.length
           && this.content.scrollHeight - this.viewportHeight < this.buffer) {
      this.mount(this.mountedEnd);
      this.mountedEnd++;
    }
    this.measurePending();
  }

  // ---------- balance：双向回收（方案 A：顶部不写 scrollTop）----------

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
   * 重平衡挂载窗口。底部增删不影响视口（内容在下方）；顶部增删**不写 scrollTop**，交浏览器锚定。
   * 顶部窗口判定用累计计数（deficit/excess），因为方案 A 没有「挂载即推 scrollTop」的反馈环。
   */
  private balance() {
    if (this.destroyed) return;
    const t0 = ngDevMode ? performance.now() : 0;
    const m0 = this.mountTick, u0 = this.unmountTick;
    const topIdx = this.viewportTopIndex();
    const botIdx = this.viewportBottomIndex();
    // 缓冲阈值（宽滞后，与方案 B 一致）：缓冲 <mount 才挂载到 target、>recycle 才回收到 target，中间死区不动。
    const MOUNT_BELOW = this.bMount, RECYCLE_ABOVE = this.bRecycle, TARGET = this.bTarget;

    // 1/2. 底部挂载/回收（互斥）：下方缓冲 <10 挂到 20、>40 回收到 20。
    const below = (this.mountedEnd - 1) - botIdx;
    if (below < MOUNT_BELOW) {
      while (this.mountedEnd < this.items.length && (this.mountedEnd - 1) - botIdx < TARGET) {
        this.mount(this.mountedEnd);
        this.mountedEnd++;
      }
    } else if (below > RECYCLE_ABOVE) {
      while (this.mountedEnd - 1 > this.mountedStart && (this.mountedEnd - 1) - botIdx > TARGET) {
        this.unmount(this.mountedEnd - 1);
        this.mountedEnd--;
      }
    }
    // 3/4. 顶部挂载/回收（互斥）：上方缓冲 <10 挂到 20、>40 回收到 20（不写 scrollTop，交浏览器锚定）。
    const above = topIdx - this.mountedStart;
    if (above < MOUNT_BELOW) {
      while (this.mountedStart > 0 && topIdx - this.mountedStart < TARGET) {
        this.mountedStart--;
        this.mount(this.mountedStart);
      }
    } else if (above > RECYCLE_ABOVE) {
      while (this.mountedStart < this.mountedEnd && topIdx - this.mountedStart > TARGET) {
        this.unmount(this.mountedStart);
        this.mountedStart++;
      }
    }

    this.measurePending();
    this.emit();

    if (ngDevMode && this.onDebug && (this.mountTick !== m0 || this.unmountTick !== u0)) {
      this.onDebug({
        ms: performance.now() - t0,
        mount: this.mountTick - m0,
        unmount: this.unmountTick - u0,
        scrollTop: Math.round(this.viewport.scrollTop),
        mountedStart: this.mountedStart,
        mountedEnd: this.mountedEnd,
      });
    }
  }

  // ---------- 高度 ----------

  private heightOf(i: number): number {
    return this.heights.get(i) ?? this.elements.get(i)?.estimateHeight() ?? 0;
  }

  private totalMountedHeight(): number {
    let acc = 0;
    for (let k = this.mountedStart; k < this.mountedEnd; k++) acc += this.heightOf(k);
    return acc;
  }

  /**
   * 批量首测：对本批 pendingMeasure 的元素一次性读 offsetHeight（同一 layout pass = 1 次 reflow），
   * 更新 heights（经 onElHeight，measuring 标志屏蔽 scheduleBalance 重入），再集中移 vs-pending。
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
      this.onElHeight(i, el.offsetHeight);
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

  /** 元素上报真实高度变化：只更新缓存 + 重平衡；不补偿 scrollTop（交浏览器锚定）。 */
  private onElHeight(i: number, h: number) {
    if (this.destroyed) return;
    const old = this.heights.get(i);
    if (old === h) return;
    this.heights.set(i, h);
    if (!this.mounting && !this.measuring) this.scheduleBalance();
  }

  private isAtBottom(): boolean {
    return this.viewport.scrollTop + this.viewportHeight >= this.content.scrollHeight - 1;
  }

  // ---------- 历史加载 ----------

  private maybeLoadMore() {
    if (this.destroyed || this.loadingMore || this.noMoreHistory || !this.onLoadMore) return;
    if (this.mountedStart > 0) return;
    this.loadingMore = true;
    const more = this.onLoadMore();
    this.loadingMore = false;
    if (more && more.length) {
      this.prependItems(more);
    } else {
      this.noMoreHistory = true;
    }
  }

  // ---------- 工具 ----------

  private measureViewport() {
    this.viewportHeight = this.viewport.clientHeight;
  }

  private shiftKeys(n: number) {
    if (n <= 0) return;
    this.heights = remap(this.heights, n);
    this.unsubs = remap(this.unsubs, n);
    const els = new Map<number, VsElement<T>>();
    for (const [k, v] of this.elements) els.set(k + n, v);
    this.elements = els;
  }

  private emit() {
    this.onScroll?.(this.getInfo());
  }
}

function remap<V>(m: Map<number, V>, n: number): Map<number, V> {
  const r = new Map<number, V>();
  for (const [k, v] of m) r.set(k + n, v);
  return r;
}
