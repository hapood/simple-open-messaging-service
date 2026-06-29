/**
 * VirtualScrollerAnchor —— 方案 A：借浏览器 overflow-anchor 锚定（与方案 B 硬分叉，便于 a/b 对比）。
 *
 * 【array index-based】内核维护 `mounted: Entry[]` 有序数组（mounted[0]=最老/DOM 顶 → 末=最新/底），
 *  下标=窗口局部 index（不累积、不依赖方向、天然支持双向）。item.id（msgId）仅作 source 游标，
 *  **不参与位置算术**。前缀和 `prefix[]`（flushPrefix 懒失效）让 topOf/totalH O(1) 摊销。
 *
 * 与方案 B（{@link VirtualScroller}）同构：array index + 数据源驱动、像素阈值窗口、检查点加载、trim、
 *  mergeItems hook（相册合并在内核，per-batch）。唯一区别：**不写 scrollTop 补偿**——prepend 更老 /
 *  上方高度变化 / 截上方 都不动 scrollTop，交由浏览器 `overflow-anchor: auto`（默认）钉住首个可见元素。
 *
 * 故方案 A 没有「异步 resolve 后补偿用快照会跳变」的风险面（§async 对策只需重校验、不需补偿算术）——
 * 这是方案 A 在 fling + 慢加载场景更顺的根本原因。代价：iOS 全系不支持 overflow-anchor → 方案 A 仅 Android。
 *
 * 注：重校验仍需（避免向反向/边界挂载），只是去掉补偿。
 * 前提：宿主 viewport overflow-anchor: auto（默认）；方案 B 的 playground 设 none 让手动补偿独占。
 */
declare const ngDevMode: boolean | null | undefined;

import type { VsSource } from './source';
import type {
  VsItem, VsElement, VsHooks, VsOptions, VsScrollInfo, VsDebugStats, VsConfig, ScrollerApi, VsInitOpts,
} from './virtual-scroller';

export type { VsItem, VsElement, VsHooks, VsOptions, VsScrollInfo, VsDebugStats, VsConfig, ScrollerApi, VsInitOpts } from './virtual-scroller';

const DEFAULTS: Required<VsConfig> = {
  edge: 1000, mountItem: 50, thresholdFloor: 6000, vhExtra: 2000, initBatch: 100,
};

/** 挂载项：item（带 msgId）+ 元素句柄 + 缓存高度 + 高度退订。字段可变（rebuild 替换 el/vs/height/unsub）。 */
interface Entry<T> { item: VsItem<T>; el: HTMLElement; vs: VsElement<T>; height: number; unsub: () => void; }

export class VirtualScrollerAnchor<T = unknown> implements ScrollerApi<T> {
  private readonly viewport: HTMLElement;
  private readonly content: HTMLElement;
  private readonly hooks: VsHooks<T>;
  private readonly source: VsSource<T>;
  private readonly cfg: Required<VsConfig>;
  private readonly initOpts: { chatId?: number };
  private readonly onScroll?: (info: VsScrollInfo) => void;
  private readonly onDebug?: (stats: VsDebugStats) => void;

  /** 有序挂载项：index 0=最老（DOM 顶）→ 末=最新（DOM 底）。下标=窗口局部 index。 */
  private mounted: Entry<T>[] = [];
  /** 前缀和：prefix[i]=Σheight[0..i-1]（prefix[0]=0、prefix[n]=totalH）。dirtyPrefix 时 flushPrefix 重算。 */
  private prefix: number[] = [0];
  private dirtyPrefix = true;

  private noOlder = false;
  private noNewer = false;
  /** 当前显骨架的 entry（= mounted[0] 当 !noOlder）；null=无骨架。用 entry 引用（不怕数组位移）。 */
  private ghostEntry: Entry<T> | null = null;
  private inflightOlder = false;
  private inflightNewer = false;
  /** 重置代：openAround 自增；loadOlder/loadNewer 的 await 后比对，过期批不挂（防跳转超越在途加载）。 */
  private gen = 0;
  /** re-seed 进行中（resetWindowState→mount 之间）：appendLive 期间丢弃 WS（已在 source 缓存，回滑 getNewer 取回）。 */
  private resetting = false;
  /** 调试开关：关闭挂载检查点（balance 不触发 loadOlder/loadNewer）。balance 内 ngDevMode 守卫 → 生产 AOT 移除。默认 false（检查点正常加载）。 */
  closeCheckpoint = false;

  /** 待实测高度的 entry 队列（改存 entry 引用，回调内 indexOf 读当前 index）。 */
  private pendingMeasure: Entry<T>[] = [];

  private vh = 0;
  private shifting = false;   // 屏蔽程序化 scrollTop 写（scrollToBottom 等）引发的 scroll 方向误判
  private mounting = false;
  private measuring = false;
  private destroyed = false;
  private dirty = false;
  private rafId = 0;
  private lastScrollTop = 0;
  private mountTick = 0;
  private unmountTick = 0;
  private readonly viewportObs: ResizeObserver;

  constructor(opts: VsOptions<T>) {
    this.viewport = opts.viewport;
    this.content = opts.content;
    this.hooks = opts.hooks;
    this.source = opts.source;
    this.onScroll = opts.onScroll;
    this.onDebug = opts.onDebug;
    this.initOpts = opts.initOpts ?? {};
    this.cfg = { ...DEFAULTS, ...opts.config };
    this.viewportObs = new ResizeObserver(() => { this.measureVh(); this.scheduleBalance(); });
    this.measureVh();
    this.viewportObs.observe(this.viewport);
    this.viewport.addEventListener('scroll', this.onNativeScroll, { passive: true });
  }

  private get threshold(): number {
    return Math.max(this.vh + this.cfg.vhExtra, this.cfg.thresholdFloor);
  }

  async init(opts?: VsInitOpts): Promise<void> {
    // 跳转/重锚：开在指定消息（双向取数 + 居中定位），不走最新铺底。
    const startId = opts?.startMsgId ?? null;
    if (startId !== null) { await this.openAround(startId, opts?.anchor ?? 'center', opts?.highlight ?? false); return; }
    let batch = await this.source.init(-1, this.cfg.initBatch, 0, this.initOpts);
    let merged = this.mergeBatch(batch);
    if (merged.length === 0) return;
    this.absorbBoundary(merged);
    this.mountBatch(merged, 'init');
    while (this.totalH() < this.threshold && !this.noOlder && this.mounted.length > 0) {
      const cursor = this.mounted[0].item.id; // 最老挂载的 msgId
      batch = await this.source.getOlder(cursor, this.cfg.initBatch);
      merged = this.mergeBatch(batch);
      if (merged.length === 0) { this.noOlder = true; break; }
      this.absorbBoundary(merged);
      this.mountBatch(merged, 'older'); // 不内部 measure
      this.measurePending();            // 补批统一测
    }
    this.scrollToBottom();
    this.updateGhost();
  }

  appendLive(rawItems: VsItem<T>[]): void {
    if (this.destroyed || this.resetting || rawItems.length === 0) return;
    const wasAtBottom = this.isAtBottom();
    const items = this.source.appendLive(rawItems);
    const merged = this.mergeBatch(items);
    this.absorbBoundary(merged);
    this.mountBatch(merged, 'newer');
    if (wasAtBottom) this.scrollToBottom();
    this.emit();
  }

  scrollToBottom(): void {
    if (this.destroyed) return;
    this.shifting = true;
    this.viewport.scrollTop = this.content.scrollHeight - this.vh;
    this.shifting = false;
    this.lastScrollTop = this.viewport.scrollTop;
    this.emit();
    // 最新端可能被 trimNewer 截掉（窗口后退、noNewer=false）→ 加载回全局最新（loadNewer 内 wasAtBottom 跟随再 scrollToBottom，链式直到 noNewer）
    if (!this.noNewer) void this.loadNewer();
  }

  scrollToTop(): void {
    if (this.destroyed) return;
    this.shifting = true;
    this.viewport.scrollTop = 0;
    this.shifting = false;
    this.lastScrollTop = 0;
    this.emit();
  }

  scrollToIndex(id: string | number, anchor: 'top' | 'center' | 'bottom' = 'center', highlight = false): void {
    if (this.destroyed) return;
    const idx = this.indexOfId(id);
    if (idx >= 0) { // 已挂载：直接定位
      this.positionMounted(idx, anchor);
      if (highlight) this.flashHighlight(idx);
      return;
    }
    // 未挂载：重置窗口围绕 id（re-seed），完成后再定位
    void this.openAround(id, anchor, highlight);
  }

  /**
   * 重置窗口围绕 id：卸载当前窗口 → source.init(id, older, newer) 双向取一批 → 挂载 → fillAround 双向填满 → 定位到 id。
   * 方案 A **不补偿 scrollTop**（浏览器 overflow-anchor 钉视口）；gen 自增使在途 loadOlder/loadNewer 作废；
   * resetting 期间丢弃 appendLive（WS 消息在 source 缓存，回滑 getNewer 取回）。居中锚需两侧内容足够才「真居中」，
   *  fillAround 保证窗口达 threshold（近边界 best-effort，clamp 自动妥协）。
   */
  private async openAround(id: string | number, anchor: 'top' | 'center' | 'bottom', highlight: boolean): Promise<void> {
    const g = ++this.gen;
    this.resetWindowState();
    try {
      const batch = await this.source.init(id, this.cfg.mountItem, this.cfg.mountItem, this.initOpts);
      if (this.destroyed || g !== this.gen) return; // 被更新的跳转/destroy 超越
      const merged = this.mergeBatch(batch);
      const key = String(id);
      if (merged.length === 0 || !merged.some(it => String(it.id) === key)) { this.updateGhost(); this.emit(); return; } // source 未返回目标
      this.absorbBoundary(merged);
      this.mountBatch(merged, 'init');
      this.measurePending();
      await this.fillAround(id, g); // 双向填到各 threshold/2（边界例外）+ 一侧到界时另一侧补到 threshold
      if (this.destroyed || g !== this.gen) return;
      const idx = this.indexOfId(id);
      if (idx >= 0) {
        this.positionMounted(idx, anchor);
        if (highlight) this.flashHighlight(idx);
      }
      this.updateGhost();
      this.emit();
    } finally {
      this.resetting = false;
    }
  }

  /**
   * 居中跳转的窗口填充：
   *  1) 上方 while 填到 aboveTarget ≥ threshold/2（或撞 noOlder）；下方 while 填到 belowTarget ≥ threshold/2（或撞 noNewer）。
   *  2) 补偿：若一侧到界（不足 threshold/2）→ 向【未到界】的另一侧补，直到 totalH ≥ threshold（两侧都到界则无法补，直接渲染）。
   * 视口尚未定位（scrollTop=0），故加载不补偿/不 trim。方案 A 本就不补偿 scrollTop。gen 守卫防跳转超越在途批。
   */
  private async fillAround(targetId: string | number, g: number): Promise<void> {
    const halfTh = this.threshold / 2;
    while (this.aboveTarget(targetId) < halfTh && !this.noOlder && this.mounted.length > 0) {
      if (await this.loadOlderIntoFresh(g) === 0) break; // 到界 / 超越 / 无数据
    }
    while (this.belowTarget(targetId) < halfTh && !this.noNewer && this.mounted.length > 0) {
      if (await this.loadNewerIntoFresh(g) === 0) break;
    }
    if (this.totalH() < this.threshold) {
      const fillUp = this.noNewer && !this.noOlder;   // 下方到底 → 上方补
      const fillDown = this.noOlder && !this.noNewer; // 上方到顶 → 下方补
      while (this.totalH() < this.threshold && (fillUp || fillDown) && this.mounted.length > 0) {
        const n = fillUp ? await this.loadOlderIntoFresh(g) : await this.loadNewerIntoFresh(g);
        if (n === 0) break; // 另一侧也到界
      }
    }
  }

  /** targetId 上方所有挂载项总高（= topOf(targetIdx)）。target 不在窗口 → 视为全部在上方。 */
  private aboveTarget(targetId: string | number): number {
    const idx = this.indexOfId(targetId);
    return idx < 0 ? this.totalH() : this.topOf(idx);
  }
  /** targetId 下方所有挂载项总高（不含 target 自身）。target 不在窗口 → 0。 */
  private belowTarget(targetId: string | number): number {
    const idx = this.indexOfId(targetId);
    if (idx < 0) return 0;
    this.flushPrefix();
    return this.totalH() - this.prefix[idx + 1];
  }

  /** 构建中窗口向更老加载一批（不补偿/不 trim/不 revalidate——视口未定位）；含旧 ghost 显形 rebuild。空批→noOlder。返回挂载数（0=到界/超越/无数据）。 */
  private async loadOlderIntoFresh(g: number): Promise<number> {
    if (this.destroyed || g !== this.gen || this.noOlder || this.mounted.length === 0) return 0;
    const cursor = this.mounted[0].item.id;
    const batch = await this.source.getOlder(cursor, this.cfg.mountItem);
    if (this.destroyed || g !== this.gen) return 0;
    const merged = this.mergeBatch(batch);
    if (merged.length === 0) { this.noOlder = true; return 0; }
    this.absorbBoundary(merged);
    const oldGhost = this.ghostEntry;
    this.mountBatch(merged, 'older');
    if (oldGhost && this.mounted.indexOf(oldGhost) > 0) { oldGhost.el.classList.remove('vs-ghost'); this.rebuildEntry(oldGhost); }
    this.measurePending();
    this.updateGhost();
    return merged.length;
  }
  /** 构建中窗口向更新加载一批（append）。空批→noNewer。返回挂载数（0=到界/超越/无数据）。 */
  private async loadNewerIntoFresh(g: number): Promise<number> {
    if (this.destroyed || g !== this.gen || this.noNewer || this.mounted.length === 0) return 0;
    const cursor = this.mounted[this.mounted.length - 1].item.id;
    const batch = await this.source.getNewer(cursor, this.cfg.mountItem);
    if (this.destroyed || g !== this.gen) return 0;
    const merged = this.mergeBatch(batch);
    if (merged.length === 0) { this.noNewer = true; return 0; }
    this.absorbBoundary(merged);
    this.mountBatch(merged, 'newer');
    this.measurePending();
    this.updateGhost();
    return merged.length;
  }

  /** 已挂载 idx 的定位数学（scrollToIndex / openAround 共用）。shifting 屏蔽方向误判。 */
  private positionMounted(idx: number, anchor: 'top' | 'center' | 'bottom'): void {
    this.flushPrefix();
    let st = this.prefix[idx];
    const h = this.mounted[idx].height;
    if (anchor === 'center') st += h / 2 - this.vh / 2;
    else if (anchor === 'bottom') st += h - this.vh;
    const max = this.content.scrollHeight - this.vh;
    this.shifting = true;
    this.viewport.scrollTop = Math.max(0, Math.min(st, max));
    this.shifting = false;
    this.lastScrollTop = this.viewport.scrollTop;
    this.emit();
  }

  /** 清空窗口 + 复位所有加载/边界状态（openAround 开头调）。unmountAll 已清 mounted/prefix/pending/ghost。 */
  private resetWindowState(): void {
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    this.dirty = false;
    this.unmountAll();
    this.noOlder = false;
    this.noNewer = false;
    this.inflightOlder = false;
    this.inflightNewer = false;
    this.lastScrollTop = 0;
    this.resetting = true;
    this.shifting = true;
    this.viewport.scrollTop = 0; // content 已空，归零
    this.shifting = false;
  }

  /** 给目标 entry 加一次性高亮闪烁（animationend 移除 class；reflow 保证重复跳转能重启动画）。 */
  private flashHighlight(idx: number): void {
    const el = this.mounted[idx]?.el;
    if (!el) return;
    el.classList.remove('vs-jump-highlight');
    void el.offsetWidth; // 强制 reflow → 重新触发动画
    el.classList.add('vs-jump-highlight');
    el.addEventListener('animationend', () => el.classList.remove('vs-jump-highlight'), { once: true });
  }

  getInfo(): VsScrollInfo {
    return {
      scrollTop: Math.round(this.viewport.scrollTop),
      scrollHeight: Math.round(this.content.scrollHeight),
      viewportHeight: this.vh,
      oldestId: this.mounted[0]?.item.id ?? null,
      newestId: this.mounted.length > 0 ? this.mounted[this.mounted.length - 1].item.id : null,
      mounted: this.mounted.length,
      atTop: this.mounted.length > 0 && this.viewport.scrollTop <= 0,
      atBottom: this.mounted.length > 0 && this.isAtBottom(),
      noOlder: this.noOlder,
      noNewer: this.noNewer,
    };
  }

  refresh(): void {
    this.measureVh();
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    this.dirty = false;
    this.balance();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.rafId);
    this.viewportObs.disconnect();
    this.viewport.removeEventListener('scroll', this.onNativeScroll);
    this.unmountAll();
    this.source.destroy();
  }

  // ---------- 前缀和 / 高度 ----------

  /** dirty 时重算 prefix（O(n)，n=mounted.length）。mount/unmount/onElHeight 置 dirty，读 prefix 前调。 */
  private flushPrefix(): void {
    if (!this.dirtyPrefix) return;
    const p = [0];
    let acc = 0;
    for (const e of this.mounted) { acc += e.height; p.push(acc); }
    this.prefix = p;
    this.dirtyPrefix = false;
  }

  /** idx 顶端距 content 顶 = Σ更老邻居高度 = prefix[idx]。 */
  private topOf(idx: number): number { this.flushPrefix(); return this.prefix[idx] ?? 0; }

  private totalH(): number { this.flushPrefix(); return this.prefix.length > 0 ? this.prefix[this.prefix.length - 1] : 0; }

  // ---------- 挂载（array index；DOM 按 mounted 顺序，不涉 scrollTop） ----------

  /** mergeItems hook（默认 noop）。在 createItem 前、对每个 source batch 调一次。scope=batch。 */
  private mergeBatch(batch: VsItem<T>[]): VsItem<T>[] {
    return this.hooks.mergeItems ? this.hooks.mergeItems(batch) : batch;
  }

  /**
   * 挂一批（已 merge）：side=init/older → prepend（mounted 首，DOM 插到旧首前）；newer → append（末）。
   * older 不内部 measure（loadOlder 统一测 + ghost rebuild）；init/newer 末尾 measure。
   * prev = 更老邻居：batch 内前一个（升序），或 append 时旧末。
   */
  private mountBatch(merged: VsItem<T>[], side: 'init' | 'older' | 'newer'): void {
    // merged 已由调用方经 mergeItems hook 合并（per-batch）；本方法只挂载，不再 merge。
    if (merged.length === 0) return;
    if (side === 'newer') {
      for (let i = 0; i < merged.length; i++) {
        const prev = i > 0 ? merged[i - 1] : (this.mounted.length > 0 ? this.mounted[this.mounted.length - 1].item : null);
        this.mounted.push(this.createEntry(merged[i], prev));
      }
    } else { // init / older 都 prepend（init 时 mounted 空，anchorEl=null → appendChild）
      const anchorEl = this.mounted.length > 0 ? this.mounted[0].el : null;
      const fresh: Entry<T>[] = [];
      for (let i = 0; i < merged.length; i++) {
        const prev = i > 0 ? merged[i - 1] : null;
        fresh.push(this.createEntry(merged[i], prev, anchorEl));
      }
      this.mounted.unshift(...fresh);
    }
    this.dirtyPrefix = true;
    if (side !== 'older') this.measurePending();
  }

  /** 创建并挂一个 entry：createItem + DOM 插入（anchorEl 前 / append）+ pendingMeasure + 订阅高度。 */
  private createEntry(item: VsItem<T>, prev: VsItem<T> | null, anchorEl?: HTMLElement | null): Entry<T> {
    if (ngDevMode) this.mountTick++;
    const vs = this.hooks.createItem(item, prev);
    const el = vs.el;
    el.dataset['vsId'] = String(item.id);
    if (anchorEl !== undefined && anchorEl !== null) this.content.insertBefore(el, anchorEl);
    else this.content.appendChild(el);
    const entry: Entry<T> = { item, el, vs, height: vs.estimateHeight(), unsub: () => {} };
    el.classList.add('vs-pending');
    this.pendingMeasure.push(entry);
    this.mounting = true; // 屏蔽首报（同 id-based）
    entry.unsub = vs.onHeightChange(h => this.onElHeight(entry, h));
    this.mounting = false;
    return entry;
  }

  /**
   * 原地重建一个已挂 entry：用当前真实 prev（mounted[idx-1]，更老邻居）重 createItem，DOM 原地替换
   *（insertBefore(newEl,oldEl)+removeChild(oldEl)）、迁移订阅、push pendingMeasure。
   * **轻量**：不 measurePending——由 loadOlder 在「挂新批 + ghost 显形」后统一一次 measure。
   * 方案 A 全程不补偿 scrollTop（浏览器 overflow-anchor 钉视口）。
   * 用途：骨架显形（旧 mounted[0] prepend 后下移、prev 从 null 变非 null，组首/date 须重算）。
   */
  private rebuildEntry(entry: Entry<T>): void {
    const idx = this.mounted.indexOf(entry);
    if (idx < 0) return;
    if (ngDevMode) this.mountTick++;
    const newPrev = idx > 0 ? this.mounted[idx - 1].item : null; // 更老邻居（index 小一条）
    const newVs = this.hooks.createItem(entry.item, newPrev);
    const newEl = newVs.el;
    newEl.dataset['vsId'] = String(entry.item.id);
    this.content.insertBefore(newEl, entry.el);
    this.content.removeChild(entry.el);
    entry.unsub();
    entry.vs = newVs;
    entry.el = newEl;
    entry.height = newVs.estimateHeight();
    newEl.classList.add('vs-pending');
    this.pendingMeasure.push(entry);
    this.mounting = true;
    entry.unsub = newVs.onHeightChange(h => this.onElHeight(entry, h));
    this.mounting = false;
    this.dirtyPrefix = true;
  }

  /** 卸最老（mounted[0]，DOM 顶）。 */
  private unmountTop(): boolean {
    if (this.mounted.length === 0) return false;
    const e = this.mounted[0];
    e.unsub();
    if (e.el.parentNode === this.content) this.content.removeChild(e.el);
    e.vs.destroy();
    this.mounted.shift();
    if (ngDevMode) this.unmountTick++;
    this.dirtyPrefix = true;
    return true;
  }

  /** 卸最新（mounted 末，DOM 底）。 */
  private unmountBot(): boolean {
    if (this.mounted.length === 0) return false;
    const e = this.mounted[this.mounted.length - 1];
    e.unsub();
    if (e.el.parentNode === this.content) this.content.removeChild(e.el);
    e.vs.destroy();
    this.mounted.pop();
    if (ngDevMode) this.unmountTick++;
    this.dirtyPrefix = true;
    return true;
  }

  private unmountAll(): void {
    for (const e of this.mounted) {
      if (e.el.parentNode === this.content) this.content.removeChild(e.el);
      e.vs.destroy();
    }
    this.mounted = [];
    this.prefix = [0];
    this.dirtyPrefix = true;
    this.pendingMeasure = [];
    this.ghostEntry = null;
  }

  /**
   * 同步骨架态（纯 class）：骨架 = mounted[0]（最老挂载）在「未到全局最老」时。用 entry 引用比对
   *（不怕数组位移）；变了则旧 ghost 移 vs-ghost、新 ghost 加 vs-ghost。
   * ghost 显形的 rebuild 由 loadOlder 在挂新批后显式做（并入统一 measure）。noOlder 时 target=null 永久消失。
   */
  private updateGhost(): void {
    const target = !this.noOlder && this.mounted.length > 0 ? this.mounted[0] : null;
    if (target === this.ghostEntry) return;
    this.ghostEntry?.el.classList.remove('vs-ghost');
    target?.el.classList.add('vs-ghost');
    this.ghostEntry = target;
  }

  // ---------- balance：检查点 + 加载（无补偿） ----------

  private onNativeScroll = () => {
    if (this.shifting || this.destroyed) return;
    this.scheduleBalance();
  };

  private scheduleBalance(): void {
    if (this.dirty || this.destroyed) return;
    this.dirty = true;
    this.rafId = requestAnimationFrame(() => { this.dirty = false; this.balance(); });
  }

  private balance(): void {
    if (this.destroyed || this.mounted.length === 0) return;
    if (ngDevMode && this.closeCheckpoint) return; // 调试：关闭挂载检查点（不触发 loadOlder/loadNewer；生产 AOT 移除）
    const t0 = ngDevMode ? performance.now() : 0;
    const m0 = this.mountTick, u0 = this.unmountTick;
    const st = this.viewport.scrollTop;
    const dir = this.scrollDir(st);
    this.lastScrollTop = st;

    const total = this.totalH();
    const atTop = st < this.cfg.edge;
    const atBottom = total - this.vh - st < this.cfg.edge;

    if (atTop && dir !== 'down' && !this.noOlder) this.loadOlder();
    else if (atBottom && dir !== 'up' && !this.noNewer) this.loadNewer();

    if (ngDevMode && this.onDebug) {
      this.onDebug({
        ms: performance.now() - t0, mount: this.mountTick - m0, unmount: this.unmountTick - u0,
        scrollTop: Math.round(st), oldestId: this.mounted[0]?.item.id ?? null, newestId: this.mounted.length > 0 ? this.mounted[this.mounted.length - 1].item.id : null,
        inflightOlder: this.inflightOlder, inflightNewer: this.inflightNewer,
      });
    }
    this.emit();
  }

  /**
   * 向更老加载：getOlder（游标=mounted[0].item.id）+ mergeItems + 挂 prepend + 旧 ghost（原 mounted[0]）
   *  显形 rebuild。方案 A **不补偿 scrollTop**（浏览器 overflow-anchor 钉视口）；ghost 显形与新批共用一次 measure。
   * absorbBoundary 在 revalidate 通过后才调（防 fling 回滑误锁 noOlder → 最老批永久不挂）。
   */
  private async loadOlder(): Promise<void> {
    if (this.inflightOlder || this.noOlder || this.mounted.length === 0) return;
    this.inflightOlder = true;
    const g = this.gen;
    try {
      const cursor = this.mounted[0].item.id;
      const batch = await this.source.getOlder(cursor, this.cfg.mountItem);
      if (this.destroyed || g !== this.gen) return; // 跳转 re-seed 超越 → 丢弃在途批
      if (!this.revalidateTop()) return; // await 期间 fling 反向 → 不挂不 absorb（阶段0：revalidate 通过后才吸收边界）
      const merged = this.mergeBatch(batch);
      if (this.destroyed || merged.length === 0) { if (merged.length === 0) this.noOlder = true; return; }
      this.absorbBoundary(merged); // 阶段0：通过后才吸收边界
      const oldGhost = this.ghostEntry;
      this.mountBatch(merged, 'older'); // prepend（不内部 measure）
      // 旧 ghost 显形 rebuild（位置不变、用新 prev 重算组首/date），与新批共用一次 measure。
      if (oldGhost && this.mounted.indexOf(oldGhost) > 0) {
        oldGhost.el.classList.remove('vs-ghost'); // 须在 rebuild 换 el 前
        this.rebuildEntry(oldGhost);
      }
      this.measurePending(); // 一次统一测：新批 + ghost 显形（方案 A 不补偿）
      this.trimNewer();
      this.updateGhost();
    } finally {
      this.inflightOlder = false;
    }
    this.emit();
  }

  /** 向更新加载：getNewer（游标=mounted 末 item.id）+ mergeItems + append。方案 A：重校验后挂载 + 截顶，**不补偿**。 */
  private async loadNewer(): Promise<void> {
    if (this.inflightNewer || this.noNewer || this.mounted.length === 0) return;
    this.inflightNewer = true;
    const g = this.gen;
    let merged: VsItem<T>[];
    try {
      const cursor = this.mounted[this.mounted.length - 1].item.id;
      const batch = await this.source.getNewer(cursor, this.cfg.mountItem);
      if (this.destroyed || g !== this.gen) return; // 跳转 re-seed 超越 → 丢弃在途批
      merged = this.mergeBatch(batch);
    } finally {
      this.inflightNewer = false;
    }
    if (this.destroyed || g !== this.gen) return;
    if (merged.length === 0) { this.noNewer = true; return; }
    if (!this.revalidateBottom()) return;
    const wasAtBottom = this.isAtBottom(); // 加载前贴底 → 加载后跟随到新底（点定位底部 / 向下滚贴底）
    this.absorbBoundary(merged); // 阶段0：通过后才吸收边界
    this.mountBatch(merged, 'newer'); // append（末尾 measure）
    this.trimOlder();
    if (wasAtBottom) this.scrollToBottom(); // 跟随到底（含触发后续 loadNewer 直到全局最新）
    this.updateGhost();
    this.emit();
  }

  /** 截更新端（底部，mounted 末）。**保留视口下方 buffer**：截后 content 底（totalH-h）须仍 > 视口底（st+vh）+ edge，
   *  否则不截——防 compensateAbove 把 st 推大后 trim 截到视口内 → st 超出 total → atBottom 误判 → loadNewer 跳到底。
   *  截掉最新端 → 重置 noNewer。无补偿（底部在视口下方）。 */
  private trimNewer(): void {
    let trimmed = false;
    while (this.mounted.length > 1) {
      this.flushPrefix();
      const h = this.mounted[this.mounted.length - 1].height;
      if (this.totalH() - h > this.threshold && (this.totalH() - h) - (this.viewport.scrollTop + this.vh) > this.cfg.edge) {
        this.unmountBot(); trimmed = true;
      } else break;
    }
    if (trimmed) this.noNewer = false;
  }

  /** 截更老端（顶部，mounted[0]）。**保留视口上方 buffer**：截后视口上方（st-h）须 > edge（对称 trimNewer）。
   *  方案 A **不补偿 scrollTop**（浏览器 overflow-anchor 钉住视口）。截掉最老端 → 重置 noOlder。 */
  private trimOlder(): void {
    let trimmed = false;
    while (this.mounted.length > 1) {
      this.flushPrefix();
      const h = this.mounted[0].height;
      if (this.totalH() - h > this.threshold && this.viewport.scrollTop - h > this.cfg.edge) {
        this.unmountTop(); trimmed = true;
      } else break;
    }
    if (trimmed) this.noOlder = false;
  }

  // ---------- 高度上报（无补偿） ----------

  /** 方案 A：高度变化不补偿（浏览器锚定），只更缓存 + balance。entry 引用稳定（不怕数组位移）。 */
  private onElHeight(entry: Entry<T>, h: number): void {
    if (this.destroyed) return;
    if (entry.height === h) return;
    entry.height = h;
    this.dirtyPrefix = true;
    if (!this.mounting && !this.measuring) this.scheduleBalance();
  }

  private indexOfId(id: string | number): number {
    const key = String(id);
    return this.mounted.findIndex(e => String(e.item.id) === key);
  }

  private isAtBottom(): boolean {
    return this.viewport.scrollTop + this.vh >= this.content.scrollHeight - 1;
  }

  private scrollDir(st: number): 'up' | 'down' | null {
    if (this.shifting) return null;
    if (st < this.lastScrollTop - 1) return 'up';
    if (st > this.lastScrollTop + 1) return 'down';
    return null;
  }

  private revalidateTop(): boolean {
    const st = this.viewport.scrollTop;
    return st < this.cfg.edge && this.scrollDir(st) !== 'down' && !this.noOlder;
  }

  private revalidateBottom(): boolean {
    const st = this.viewport.scrollTop;
    const total = this.totalH();
    return total - this.vh - st < this.cfg.edge && this.scrollDir(st) !== 'up' && !this.noNewer;
  }

  private absorbBoundary(items: VsItem<T>[]): void {
    for (const it of items) {
      if (it.boundary === 'oldest') this.noOlder = true;
      else if (it.boundary === 'newest') this.noNewer = true;
    }
  }

  private measureVh(): void { this.vh = this.viewport.clientHeight; }

  private measurePending(): void {
    if (this.pendingMeasure.length === 0) return;
    const entries = this.pendingMeasure;
    this.pendingMeasure = [];
    this.measuring = true;
    for (const entry of entries) {
      if (this.mounted.indexOf(entry) < 0) continue; // 已卸载（防 trim 后残留）
      this.onElHeight(entry, entry.el.offsetHeight);
      entry.el.classList.remove('vs-pending');
    }
    this.measuring = false;
  }

  private emit(): void { this.onScroll?.(this.getInfo()); }
}
