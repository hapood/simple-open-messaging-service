/**
 * ChatBoxScroller —— array index + 数据源驱动的虚拟列表（方案 B：手动 scrollTop 补偿）。
 *
 * 【array index-based】内核维护 `mounted: Entry[]` 有序数组（mounted[0]=最老/DOM 顶 → 末=最新/底），
 *  下标=窗口局部 index（不累积、不依赖方向、天然支持双向）。item.id（msgId）仅作 source 游标，
 *  **不参与位置算术**。前缀和 `prefix[]`（flushPrefix 懒失效）让 topOf/totalH O(1) 摊销。
 *  数据经 {@link VsSource} 异步取（getOlder/getNewer 游标）；mergeItems hook 在 createItem 前合并相册（per-batch）。
 *  边界 noOlder/noNewer 归内核（从 source 返回 item 的 boundary 标记读到）。
 *
 * 【DOM 顺序】mounted index 升序 = 最老→最新 = DOM 顶→底。createEntry 按邻居（index-1 上方更老）插入。
 *
 * 【方案 B 补偿】向上挂载（prepend 更老）+ 上方高度变化 → scrollTop += delta；截上方 → scrollTop -= delta；
 *   下方变化不补。与方案 A（借浏览器 overflow-anchor，仅 Android）硬分叉。
 *
 * 【异步对策】getOlder/getNewer 是异步；resolve 时【重校验】（仍在该边缘 + 方向未反 + 未撞边界），否则只更缓存不挂载
 *   （零跳变；用户回滑时下个 balance 从缓存挂）。补偿用 resolve 时【实测】高度，非请求时快照。
 *
 * 框架无关：不 import Angular。declare ngDevMode 守卫诊断（生产 AOT 死代码消除）。
 */
declare const ngDevMode: boolean | null | undefined;

import type { VsSource } from './source';

export interface VsItem<T = unknown> {
  /** 真实数据 id（source 给的 msgId）。内核仅作 source 游标 + createItem 读 data，**不参与位置算术**（内核位置用 array index）。 */
  id: string | number;
  data: T;
  /** 边界标记（source 赋值）：'oldest'=全局最旧、'newest'=全局最新。内核读到设 noOlder/noNewer。 */
  boundary?: 'oldest' | 'newest';
  /**
   * All member msgIds an aggregated item (e.g. album) represents — populated by the mergeItems hook
   * when it merges several msgs into one item (the first member equals {@link id}). Single (non-merged)
   * items leave this undefined. Purpose: id resolution for jump/positioning (scrollToIndex, indexOfId)
   * must land on the album item when the target is any album member — otherwise jumping to a non-head
   * image's msgId fails to find it (item.id only carries the head) and the viewport ends up empty
   * (jump-to-id bug). Read-only in the kernel; the source returns raw msgs and never sets this.
   */
  ids?: (string | number)[];
}

/**
 * 已挂载元素句柄。createItem 返回；内核只通过它操作元素。
 * 两个高度方法只在元素已挂载时调用。
 */
export interface VsElement<T = unknown> {
  readonly el: HTMLElement;
  estimateHeight(): number;
  onHeightChange(cb: (height: number) => void): () => void;
  destroy(): void;
}

/** createItem：把 item 包装成 VsElement。prev = 更老邻居（mounted 内 index-1），供算分组（首/续）；无则 null。 */
export interface VsHooks<T = unknown> {
  createItem: (item: VsItem<T>, prev: VsItem<T> | null) => VsElement<T>;
  /** 在 createItem 前对每个 source batch 调用：展示聚合（如相册合并连续同 creator IMAGE）。默认 noop。scope=batch（per-batch，跨 batch 切断）。 */
  mergeItems?: (items: VsItem<T>[]) => VsItem<T>[];
}

/** 可配置阈值（全部有默认）。 */
export interface VsConfig {
  /** 检查点触发距离：视口距 mounted 内容上/下边缘 < edge → 进检查点。默认 1000。 */
  edge?: number;
  /** loadOlder/loadNewer 每次加载条数。默认 50。 */
  mountItem?: number;
  /** 窗口阈值下限：max(vh + vhExtra, floor)。默认 6000。 */
  thresholdFloor?: number;
  /** vh 之外额外像素（阈值 = max(vh+vhExtra, thresholdFloor)）。默认 2000。 */
  vhExtra?: number;
  /** init 首批 / 补批条数。默认 100。 */
  initBatch?: number;
}

export interface VsOptions<T> {
  viewport: HTMLElement;
  content: HTMLElement;
  hooks: VsHooks<T>;
  source: VsSource<T>;
  config?: VsConfig;
  /** 透传给 source.init（chatId 等）。 */
  initOpts?: { chatId?: number };
  onScroll?: (info: VsScrollInfo) => void;
  onDebug?: (stats: VsDebugStats) => void;
}

export interface VsScrollInfo {
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  /** 挂载窗口边界 item.id（msgId）。 */
  oldestId: string | number | null;
  newestId: string | number | null;
  mounted: number;
  atTop: boolean;
  atBottom: boolean;
  noOlder: boolean;
  noNewer: boolean;
}

/** 单帧 balance 诊断（onDebug 载荷，仅供调试 UI）。 */
export interface VsDebugStats {
  ms: number;
  mount: number;
  unmount: number;
  scrollTop: number;
  oldestId: string | number | null;
  newestId: string | number | null;
  inflightOlder: boolean;
  inflightNewer: boolean;
}

/** init() 选项：跳转/重锚（开在指定消息）。 */
export interface VsInitOpts {
  /** 以该 msgId 为锚双向取数（默认无 = 从全局最新首屏）。 */
  startMsgId?: string | number | null;
  /** 目标在视口对齐方式（默认 'center'）。 */
  anchor?: 'top' | 'center' | 'bottom';
  /** 定位后给目标加一次高亮闪烁（默认 false）。 */
  highlight?: boolean;
}

/** 内核对外公共能力（方案 A/B 共同满足）。 */
export interface ScrollerApi<T = unknown> {
  /** 首屏加载；传 opts.startMsgId 则开在指定消息（重锚），否则从全局最新铺底。 */
  init(opts?: VsInitOpts): Promise<void>;
  scrollToBottom(): void;
  scrollToTop(): void;
  /** 跳转到 id：已挂载则直接定位；未挂载则重置窗口围绕 id（re-seed）再定位。anchor 默认 'center'。highlight 给目标加一次高亮。 */
  scrollToIndex(id: string | number, anchor?: 'top' | 'center' | 'bottom', highlight?: boolean): void;
  appendLive(items: VsItem<T>[]): void;
  getInfo(): VsScrollInfo;
  refresh(): void;
  destroy(): void;
}

const DEFAULTS: Required<VsConfig> = {
  edge: 1000, mountItem: 50, thresholdFloor: 6000, vhExtra: 2000, initBatch: 100,
};

/** 挂载项：item（带 msgId）+ 元素句柄 + 缓存高度 + 高度退订。字段可变（rebuild 替换 el/vs/height/unsub）。 */
interface Entry<T> { item: VsItem<T>; el: HTMLElement; vs: VsElement<T>; height: number; unsub: () => void; }

export class ChatBoxScroller<T = unknown> implements ScrollerApi<T> {
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
  private shifting = false;   // 屏蔽程序化 scrollTop 写引发的 scroll 方向误判 + onElHeight 补偿
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
      this.measurePending();            // 补批统一测（init 贴底，补偿无影响）
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
    if (ngDevMode) console.log('[JUMP] scrollToIndex id=', id, 'alreadyMounted idx=', idx);
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
   * gen 自增使在途的 loadOlder/loadNewer 作废；resetting 期间丢弃 appendLive（WS 消息在 source 缓存，回滑取回）。
   * 居中锚需两侧都有足够内容才「真居中」；fillAround 保证窗口达 threshold（近边界时 best-effort，clamp 自动妥协）。
   */
  private async openAround(id: string | number, anchor: 'top' | 'center' | 'bottom', highlight: boolean): Promise<void> {
    const g = ++this.gen;
    if (ngDevMode) console.log('[JUMP] openAround start id=', id, 'gen=', g, 'vh=', this.vh, 'threshold=', this.threshold);
    this.resetWindowState();
    try {
      const batch = await this.source.init(id, this.cfg.mountItem, this.cfg.mountItem, this.initOpts);
      if (this.destroyed || g !== this.gen) { if (ngDevMode) console.log('[JUMP] bail: gen overtaken / destroyed'); return; } // 被更新的跳转/destroy 超越
      const merged = this.mergeBatch(batch);
      const key = String(id);
      const hasTarget = merged.some(it => this.itemHasId(it, id));
      if (ngDevMode) console.log('[JUMP] init batch merged=', merged.length, 'hasTarget=', hasTarget, 'ids=', merged.slice(0, 2).map(i => i.id), '..', merged.slice(-2).map(i => i.id), 'noOlder/noNewer=', this.noOlder, this.noNewer);
      if (merged.length === 0 || !hasTarget) { this.updateGhost(); this.emit(); return; } // source 未返回目标
      this.absorbBoundary(merged);
      this.mountBatch(merged, 'init');
      this.measurePending();
      if (ngDevMode) console.log('[JUMP] after init mount+measure: mounted=', this.mounted.length, 'totalH=', Math.round(this.totalH()), 'sampleH=', this.mounted.slice(0, 5).map(e => Math.round(e.height)));
      await this.fillAround(id, g); // 双向填到各 threshold/2（边界例外）+ 一侧到界时另一侧补到 threshold
      if (this.destroyed || g !== this.gen) { if (ngDevMode) console.log('[JUMP] bail after fill: gen overtaken'); return; }
      if (ngDevMode) console.log('[JUMP] fill done: mounted=', this.mounted.length, 'range=', this.mounted[0]?.item.id, '..', this.mounted[this.mounted.length - 1]?.item.id, 'totalH=', Math.round(this.totalH()), 'noOlder/noNewer=', this.noOlder, this.noNewer);
      const idx = this.indexOfId(id);
      if (idx >= 0) {
        this.positionMounted(idx, anchor);
        if (highlight) this.flashHighlight(idx);
      } else if (ngDevMode) console.log('[JUMP] target not found after fill (idx=-1)!');
      this.updateGhost();
      this.emit();
    } finally {
      this.resetting = false;
    }
  }

  /**
   * Window fill for a centered jump:
   *  1) Fill upward until aboveTarget ≥ threshold/2 (or hit noOlder); fill downward until belowTarget ≥ threshold/2 (or hit noNewer).
   *  2) Compensate: if one side hit a boundary (< threshold/2) → fill the other (still-open) side until totalH ≥ threshold
   *     (if both hit boundaries there is nothing to fill — just render).
   * The viewport is not yet positioned (scrollTop=0), so loading neither compensates nor trims (unlike loadOlder/loadNewer).
   * gen guard drops batches overtaken by a newer jump. Iteration counts are surfaced once in the fill-done log — a spike
   * (e.g. up=200) would reveal a heights-read-as-0 regression without per-iteration spam.
   */
  private async fillAround(targetId: string | number, g: number): Promise<void> {
    const halfTh = this.threshold / 2;
    let upIter = 0;
    while (this.aboveTarget(targetId) < halfTh && !this.noOlder && this.mounted.length > 0) {
      const n = await this.loadOlderIntoFresh(g);
      upIter++;
      if (n === 0) break; // reached boundary / overtaken / no data
    }
    let downIter = 0;
    while (this.belowTarget(targetId) < halfTh && !this.noNewer && this.mounted.length > 0) {
      const n = await this.loadNewerIntoFresh(g);
      downIter++;
      if (n === 0) break;
    }
    let compIter = 0;
    if (this.totalH() < this.threshold) {
      const fillUp = this.noNewer && !this.noOlder;   // bottom reached → fill upward
      const fillDown = this.noOlder && !this.noNewer; // top reached → fill downward
      while (this.totalH() < this.threshold && (fillUp || fillDown) && this.mounted.length > 0) {
        const n = fillUp ? await this.loadOlderIntoFresh(g) : await this.loadNewerIntoFresh(g);
        compIter++;
        if (n === 0) break; // other side also reached boundary
      }
    }
    if (ngDevMode) console.log('[JUMP] fill iters up/down/comp=', upIter, downIter, compIter, 'totalH=', Math.round(this.totalH()));
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
    if (ngDevMode) console.log('[JUMP] positionMounted idx=', idx, 'id=', this.mounted[idx]?.item.id, 'topOf=', Math.round(this.prefix[idx]), 'h=', Math.round(h), 'rawSt=', Math.round(st), 'max=', Math.round(max), 'vh=', this.vh, '-> scrollTop=', Math.round(this.viewport.scrollTop));
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

  // ---------- 挂载（array index；DOM 按 mounted 顺序） ----------

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
   * 原地重建一个已挂 entry：用当前真实 prev（mounted[idx-1]，更老邻居）重 createItem，DOM 原地替换、迁移订阅。
   * **轻量**：不 measurePending——由 loadOlder 在「挂新批 + ghost 显形」后统一一次 measure。
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

  /** 卸最老（mounted[0]，DOM 顶）。不补 scrollTop（由调用方 trimOlder 在 shifting 内补）。 */
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

  /** 同步骨架态（纯 class）：骨架 = mounted[0]（最老挂载）在「未到全局最老」时。用 entry 引用比对。 */
  private updateGhost(): void {
    const target = !this.noOlder && this.mounted.length > 0 ? this.mounted[0] : null;
    if (target === this.ghostEntry) return;
    this.ghostEntry?.el.classList.remove('vs-ghost');
    target?.el.classList.add('vs-ghost');
    this.ghostEntry = target;
  }

  // ---------- balance：检查点 + 加载 ----------

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
   * 向更老加载：getOlder（游标=mounted[0].item.id）+ mergeItems + 挂 prepend + 旧 ghost 显形 rebuild。
   * **方案 B 补偿**：视口上方总 delta（新批实测高 + ghost rebuild delta）一次 compensateAbove（视口不跳）。
   * ghost 显形与新批共用一次 measurePending（measuring 屏蔽 onElHeight 补偿 → 补偿统一在此算）。
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
      const oldGhostH = oldGhost ? oldGhost.height : 0;
      this.mountBatch(merged, 'older'); // prepend（不内部 measure）
      let rebuildGhost = false;
      if (oldGhost && this.mounted.indexOf(oldGhost) > 0) {
        oldGhost.el.classList.remove('vs-ghost'); // 须在 rebuild 换 el 前
        this.rebuildEntry(oldGhost);
        rebuildGhost = true;
      }
      this.measurePending(); // 一次统一测：新批 + ghost 显形（measuring 屏蔽 onElHeight 补偿）
      this.flushPrefix();
      const addedPx = this.prefix[merged.length] ?? 0; // 新批实测总高（prepend 了 merged.length 条）
      const rebuildDelta = rebuildGhost && oldGhost ? oldGhost.height - oldGhostH : 0;
      this.compensateAbove(addedPx + rebuildDelta); // 方案 B：视口上方总 delta 一次补
      this.trimNewer();
      this.updateGhost();
    } finally {
      this.inflightOlder = false;
    }
    this.emit();
  }

  /** 向更新加载：getNewer（游标=mounted 末 item.id）+ mergeItems + append。重校验后挂载 + 截顶（trimOlder 内补偿）。 */
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
    const wasAtBottom = this.isAtBottom(); // 加载前贴底 → 加载后跟随到新底（点定位底部 / 向下滚贴底时滚到新加载段）
    this.absorbBoundary(merged); // 阶段0：通过后才吸收边界
    this.mountBatch(merged, 'newer'); // append（末尾 measure）
    this.trimOlder(); // 截顶 + 方案 B 补偿 scrollTop -= h
    if (wasAtBottom) this.scrollToBottom(); // 跟随到底（含触发后续 loadNewer 直到全局最新）
    this.updateGhost();
    this.emit();
  }

  /** 截更新端（底部，mounted 末）。**保留视口下方 buffer**：截后 content 底（totalH-h）须仍 > 视口底（st+vh）+ edge，
   *  否则不截——防 loadOlder 的 compensateAbove 把 st 推大后，trim 截到视口内 → st 超出 total → atBottom 误判
   *  → loadNewer wasAtBottom 跳到最新端。截掉最新端 → 重置 noNewer（loadNewer 可加载回）。无补偿（底部在视口下方）。 */
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
   *  **方案 B 补偿** scrollTop -= h。截掉最老端 → 重置 noOlder。 */
  private trimOlder(): void {
    let trimmed = false;
    while (this.mounted.length > 1) {
      this.flushPrefix();
      const h = this.mounted[0].height;
      if (this.totalH() - h > this.threshold && this.viewport.scrollTop - h > this.cfg.edge) {
        this.shifting = true;
        this.unmountTop();
        this.viewport.scrollTop -= h;
        this.shifting = false;
        trimmed = true;
      } else break;
    }
    if (trimmed) this.noOlder = false;
  }

  // ---------- 高度 / 补偿 ----------

  /** 方案 B：视口上方变化 → scrollTop += delta（shifting 屏蔽方向误判）。 */
  private compensateAbove(delta: number): void {
    if (delta === 0) return;
    this.shifting = true;
    this.viewport.scrollTop += delta;
    this.shifting = false;
    this.lastScrollTop = this.viewport.scrollTop;
  }

  /** 元素上报真实高度：更新缓存；视口上方变化 → 补偿。mount/measure 内首报跳过（防重入）。 */
  private onElHeight(entry: Entry<T>, h: number): void {
    if (this.destroyed) return;
    const old = entry.height;
    if (old === h) return;
    entry.height = h;
    this.dirtyPrefix = true;
    if (!this.shifting && !this.mounting && !this.measuring) {
      const idx = this.mounted.indexOf(entry);
      if (idx >= 0 && this.isAboveViewport(idx)) this.compensateAbove(h - old);
      this.scheduleBalance();
    }
  }

  /** Whether an item represents the given msgId — matches {@link VsItem.id} OR any member in {@link VsItem.ids}
   *  (so a jump to a non-head album member still resolves to its album item). */
  private itemHasId(item: VsItem<T>, id: string | number): boolean {
    const key = String(id);
    if (String(item.id) === key) return true;
    const ids = item.ids;
    return ids !== undefined && ids.some(x => String(x) === key);
  }

  /** Current index of the entry representing id (onElHeight/scrollToIndex/openAround). O(n), low frequency. */
  private indexOfId(id: string | number): number {
    return this.mounted.findIndex(e => this.itemHasId(e.item, id));
  }

  /** idx 是否在视口上方（其顶 < scrollTop）。 */
  private isAboveViewport(idx: number): boolean {
    return this.topOf(idx) < this.viewport.scrollTop;
  }

  private isAtBottom(): boolean {
    return this.viewport.scrollTop + this.vh >= this.content.scrollHeight - 1;
  }

  /** 滚动方向（据 scrollTop 变化，±1px 容差）。程序化写（shifting）期间不算。 */
  private scrollDir(st: number): 'up' | 'down' | null {
    if (this.shifting) return null;
    if (st < this.lastScrollTop - 1) return 'up';
    if (st > this.lastScrollTop + 1) return 'down';
    return null;
  }

  /** 重校验：仍在顶边缘 + 方向未向下 + 未撞最老边界（单条且到最老时熔断，防 init 单条死循环）。 */
  private revalidateTop(): boolean {
    const st = this.viewport.scrollTop;
    return st < this.cfg.edge && this.scrollDir(st) !== 'down' && !(this.mounted.length <= 1 && this.noOlder);
  }

  /** 重校验：仍在底边缘 + 方向未向上 + 未撞最新边界。 */
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
    let zeros = 0;
    for (const entry of entries) {
      if (this.mounted.indexOf(entry) < 0) continue; // 已卸载（防 trim 后残留）
      const h = entry.el.offsetHeight;
      if (ngDevMode && h === 0) zeros++;
      this.onElHeight(entry, h); // measuring 屏蔽补偿 + balance（loadOlder 统一补）
      entry.el.classList.remove('vs-pending');
    }
    this.measuring = false;
    if (ngDevMode && (zeros > 0 || this.resetting)) console.log('[JUMP] measure n=', entries.length, 'zeroH=', zeros, 'contentScrollH=', this.content.scrollHeight);
  }

  private emit(): void { this.onScroll?.(this.getInfo()); }
}
