/**
 * ChatBoxScrollerAnchor —— 方案 A：借浏览器 overflow-anchor 锚定（与方案 B 硬分叉，便于 a/b 对比）。
 *
 * 【array index-based】内核维护 `mounted: Entry[]` 有序数组（mounted[0]=最老/DOM 顶 → 末=最新/底），
 *  下标=窗口局部 index（不累积、不依赖方向、天然支持双向）。item.id（msgId）仅作 source 游标，
 *  **不参与位置算术**。前缀和 `prefix[]`（flushPrefix 懒失效）让 topOf/totalH O(1) 摊销。
 *
 * 与方案 B（{@link ChatBoxScroller}）同构：array index + 数据源驱动、像素阈值窗口、检查点加载、trim、
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

import type { CbSource } from './cb-source';
import type {
  CbItem, CbElement, CbHooks, CbOptions, CbScrollInfo, CbDebugStats, CbConfig, ScrollerApi, CbInitOpts,
} from './chat-box-scroller';

export type { CbItem, CbElement, CbHooks, CbOptions, CbScrollInfo, CbDebugStats, CbConfig, ScrollerApi, CbInitOpts } from './chat-box-scroller';

const DEFAULTS: Required<CbConfig> = {
  edge: 1000, mountItem: 50, thresholdFloor: 6000, vhExtra: 2000, initBatch: 100,
};

/** Mounted entry: item (with msgId) + element handle + cached height + height unsubscribe. Fields are mutable (rebuild replaces el/vs/height/unsub). */
interface Entry<T> {
  item: CbItem<T>;
  el: HTMLElement;
  vs: CbElement<T>;
  height: number;
  unsub: () => void;
  /** insertAfter 插入的项为 true（未注册到 source）。其 id 非 source 游标，故游标派生（olderCursorId/newerCursorId）
   *  跳过之——防 transient 到达首/末后让 getOlder/getNewer 返回 [] 误锁 noOlder/noNewer。 */
  transient: boolean;
  /** True for an in-flight pending send (insertAfter {optimistic:true}): registered with source.pending, returned by
   *  getNewer when the real batch is short. Skipped by cursor derivation and protected from trim (atomic block). */
  optimistic: boolean;
  /** True for a just-mounted real item confirming an optimistic send — mounted visibly and flagged so reconcileOptimistic
   *  removes the matching optimistic duplicate and tags this real cb-confirmed. No hiding: the swap is synchronous within
   *  the loadNewer→reconcile microtask (never painted as two bubbles). Set by the loadNewer mount-dispatch; cleared at reconcile. */
  resortTarget: boolean;
  /** True on a mount that should play the cb-enter animation (insertAfter + appendLive only; scroll-loaded history
   *  batches never animate). Consumed once by measurePending (after cb-pending is dropped): calls enterAnim and clears it. */
  animate: boolean;
  /** True while the cb-leave exit animation is in flight. The entry STAYS in mounted[] (height still counted) until
   *  animationend so the height model stays exact; cursor derivation skips it like transient. Set by removeItem. */
  leaving: boolean;
  /** Guards double-fire of the leave completion (animationend + safety timeout both call the same handler). */
  leaveDone: boolean;
  /** Safety timer in case animationend is swallowed during a leave (cleared on completion / teardown). */
  leaveTimer?: ReturnType<typeof setTimeout>;
  /** enter-animation safety timer (cb-enter). Undefined when not animating or already finished; its presence is the
   *  "still in flight" signal used by teardown to decrement `animating` exactly once. */
  enterTimer?: ReturnType<typeof setTimeout>;
  /** FLIP-move (cb-move) safety timer. Undefined when not moving or already finished; its presence is the "still in
   *  flight" signal used by teardown (cancelEntryAnim) to decrement `animating` exactly once. Set by flipMove when a
   *  reconcilePending reorder (or status-morph height delta) shifts the entry's absolute top. */
  moveTimer?: ReturnType<typeof setTimeout>;
}

export class ChatBoxScrollerAnchor<T = unknown> implements ScrollerApi<T> {
  private readonly viewport: HTMLElement;
  private readonly content: HTMLElement;
  private readonly hooks: CbHooks<T>;
  private readonly source: CbSource<T>;
  private readonly cfg: Required<CbConfig>;
  private readonly initOpts: { chatId?: number };
  private readonly onScroll?: (info: CbScrollInfo) => void;
  private readonly onDebug?: (stats: CbDebugStats) => void;

  /** 有序挂载项：index 0=最老（DOM 顶）→ 末=最新（DOM 底）。下标=窗口局部 index。 */
  private mounted: Entry<T>[] = [];
  /** 前缀和：prefix[i]=Σheight[0..i-1]（prefix[0]=0、prefix[n]=totalH）。dirtyPrefix 时 flushPrefix 重算。 */
  private prefix: number[] = [0];
  private dirtyPrefix = true;

  private noOlder = false;
  private noNewer = false;
  /** 当前显骨架的 entry（= mounted[0] 当 !noOlder）；null=无骨架。用 entry 引用（不怕数组位移）。 */
  private ghostEntry: Entry<T> | null = null;

  /** Tail cap: a persistent non-message element kept as the last child of content (NEVER in mounted[]), mirroring the top
   *  ghost at the newer edge. Gap mode (noNewer, at the global newest) = a small spacer; loading mode (!noNewer) = the same
   *  spinner as the top ghost. Its height is folded into totalH() but never into prefix[]/topOf, so it neither shifts any
   *  real item's position nor corrupts the newer cursor (mounted[last].item.id). Created once in the ctor; reused, never
   *  duplicated, across batches — every append inserts before it, so it is continuously the last child (no accumulation). */
  private tailCapEl: HTMLElement | null = null;
  private tailCapH = 0;
  private readonly tailCapObs: ResizeObserver = new ResizeObserver(() => {
    if (this.tailCapEl) this.tailCapH = this.tailCapEl.offsetHeight; // re-measure on async/responsive height change
  });
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
  /** Set after a viewport-resize reflow re-pins to bottom; onNativeScroll consumes it once so the async scroll event
   *  the pinToBottom write fires does not re-arm balance/load/trim during a viewport shrink (soft keyboard, etc.). */
  private suppressScrollBalance = false;
  private mounting = false;
  private measuring = false;
  private destroyed = false;
  private dirty = false;
  private rafId = 0;
  private lastScrollTop = 0;
  private mountTick = 0;
  private unmountTick = 0;
  /** Count of in-flight enter/exit (cb-enter/cb-leave) animations. While > 0, scheduleBalance defers (sets deferBalance)
   *  instead of scheduling a RAF — no load/trim runs during an animation. Mount/unmount/settle ops are NOT blocked:
   *  each manages this counter, so add+remove and multi-remove animate concurrently. Drains to 0 on animationend. */
  private animating = 0;
  /** Set when a balance was requested while animating>0; fired once when animating drains to 0. */
  private deferBalance = false;
  /** Set during reconcileOptimistic. Reconcile is synchronous (no slide) and never spans an await, so this is never
   *  observed true by a deferred trim — kept so trimOlder/trimNewer (rule 4a) stay self-documenting. */
  private resorting = false;
  private readonly viewportObs: ResizeObserver;

  constructor(opts: CbOptions<T>) {
    this.viewport = opts.viewport;
    this.content = opts.content;
    this.hooks = opts.hooks;
    this.source = opts.source;
    this.onScroll = opts.onScroll;
    this.onDebug = opts.onDebug;
    this.initOpts = opts.initOpts ?? {};
    this.cfg = { ...DEFAULTS, ...opts.config };
    this.viewportObs = new ResizeObserver(() => this.onViewportResize());
    this.measureVh();
    this.viewportObs.observe(this.viewport);
    this.viewport.addEventListener('scroll', this.onNativeScroll, { passive: true });
    // Tail cap: created once, appended as the only/last child. Every later createEntry inserts before it (see createEntry),
    // so it stays the permanent last child of content across all mounts/re-seeds; removed only in destroy.
    this.tailCapEl = document.createElement('div');
    this.tailCapEl.className = 'cb-tail-cap';
    this.content.appendChild(this.tailCapEl);
    this.tailCapObs.observe(this.tailCapEl);
  }

  private get threshold(): number {
    return Math.max(this.vh + this.cfg.vhExtra, this.cfg.thresholdFloor);
  }

  async init(opts?: CbInitOpts): Promise<void> {
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

  appendLive(rawItems: CbItem<T>[]): void {
    if (this.destroyed || rawItems.length === 0) return;
    // Direct-mount path for live items (production WS incoming). Cache via pushLive, then mount at the tail (dedup by
    // id). Plan A relies on overflow-anchor to pin the viewport (no manual compensation). NOT the optimistic-confirm
    // path — that goes through onMessageSignal (reconcile).
    this.source.pushLive(rawItems);
    if (this.resetting) { this.emit(); return; }
    const remaining = rawItems.filter(it => this.indexOfId(it.id) < 0);
    if (remaining.length === 0) { this.emit(); return; }
    if (!this.noNewer) { this.emit(); return; }              // newer end trimmed → cache only
    const wasAtBottom = this.isAtBottom();
    const merged = this.mergeBatch(remaining);
    this.mountBatch(merged, 'newer', true);
    this.noNewer = true;
    if (wasAtBottom) this.scrollToBottom();                  // overflow-anchor pins; pin to reveal the new message
    this.emit();
  }

  /** Signal that new messages are available (the source already cached them via pushLive). If the kernel still mounts
   *  the global newest, pull via loadNewer, run reconcileOptimistic, follow to the bottom if pinned — pinning AFTER
   *  reconcile so the target is the final bottom (the optimistic duplicate is already removed, not counted) — and trim.
   *  Plan A relies on overflow-anchor (no manual scrollTop compensation). */
  async onMessageSignal(): Promise<void> {
    if (this.destroyed || this.resetting) return;
    if (!this.noNewer) return;                               // newer end trimmed → cached only; load on scroll-back
    const wasAtBottom = this.isAtBottom();
    await this.loadNewer(true);                              // forced: the signal means new data is available (bypasses the noNewer/revalidate guards)
    if (this.destroyed) return;
    await this.reconcileOptimistic();                        // remove optimistic duplicates (synchronous) so the bottom is final
    if (this.destroyed) return;
    // Trim + ghost + cap BEFORE the pin: these mutate content (remove top items → scrollHeight shrinks), so pinning to the
    // FINAL bottom must come after them (mirrors Kernel B). Pinning before trim anchored scrollTop to a pre-trim bottom and
    // the subsequent trim shifted it off → the latest message dropped below the fold on the first send.
    this.trimOlder();
    this.updateGhost();
    this.updateTailCap();
    if (wasAtBottom) this.pinToBottom();                     // follow to the FINAL bottom (after reconcile + trim)
    this.emit();
  }

  /**
   * 在已挂载的 afterId 项之后插入一条 item。afterId 未挂载或正在 re-seed 时为 no-op（返回 false）。
   *
   * **不触发 balance**：不调 loadOlder/loadNewer/trim。measurePending 在 `measuring` 守卫下结算高度、不 schedule
   *  balance。方案 A **不补偿 scrollTop**（浏览器 overflow-anchor 钉视口）——这是方案 A 与方案 B 的唯一分歧：
   *  方案 B 手动 compensateAbove；方案 A 交由浏览器。
   *
   * 后继项（原 idx+1）的 prev 变了（target → 新 item）→ 原地 rebuild 重算组首/date（同 ghost 显形 rebuild）；
   * 再往后的项 prev 不变、无需 rebuild。新 entry 标 transient（非 source 游标）。
   */
  insertAfter(afterId: string | number, item: CbItem<T>, opts?: { optimistic?: boolean }): boolean {
    if (this.destroyed || this.resetting) return false;
    const idx = this.indexOfId(afterId);
    if (idx < 0) return false;                  // 未挂载 → 忽略插入请求
    const target = this.mounted[idx];
    const successor = this.mounted[idx + 1] ?? null;
    const anchorEl = successor ? successor.el : null;

    // New entry: prev = target item (older neighbor). DOM lands between target and successor (createEntry inserts
    // before anchorEl; no successor -> append). animate=true so it plays cb-enter once measured.
    const entry = this.createEntry(item, target.item, anchorEl, true);
    if (opts?.optimistic) entry.optimistic = true;   // pending send (in source.pending, returned by getNewer, atomic)
    else entry.transient = true;                      // FAKE debug insert (viewport-only)
    this.mounted.splice(idx + 1, 0, entry);
    if (successor) this.rebuildEntry(successor); // prev 变了 → 重算组首/date（高度置 0、下面统一 measure）

    this.dirtyPrefix = true;
    this.measurePending();                       // `measuring` 守卫屏蔽 onElHeight 补偿/balance
    // 方案 A：浏览器 overflow-anchor 自动钉住视口（视口上方插入/高度变化不跳变），无需手动补偿 scrollTop。
    this.emit();
    return true;
  }

  /**
   * Remove mounted entries by id (fake/pending/real, or any album-member id). Accepts one id or an array. Each removed
   * entry plays a cb-leave exit animation; the logical unmount is deferred to animationend (the entry STAYS in mounted[],
   * height still counted, until then — so the height model stays exact). No `animating>0` guard: removes run concurrently
   * with each other and with inserts; only balance is gated by animating. Returns the count scheduled for removal.
   */
  removeItem(ids: string | number | (string | number)[]): number {
    if (this.destroyed || this.resetting) return 0;
    const list = Array.isArray(ids) ? ids : [ids];
    const targets: Entry<T>[] = [];
    for (const id of list) {
      const idx = this.indexOfId(id);                 // album-aware (itemHasId -> whole album item)
      if (idx < 0) continue;
      const e = this.mounted[idx];
      if (!e.leaving && !targets.includes(e)) targets.push(e); // dedup (several album ids -> same entry)
    }
    for (const e of targets) this.leaveEntry(e);      // each starts its own concurrent cb-leave
    if (targets.length > 0) this.emit();
    return targets.length;
  }

  /** Start one entry's cb-leave exit: mark leaving, animating++, add the class; complete the unmount on animationend
   *  (or the safety timeout). Plan A does not compensate scrollTop (browser overflow-anchor pins the viewport). */
  private leaveEntry(entry: Entry<T>): void {
    entry.leaving = true;
    entry.leaveDone = false;
    this.animating++;
    entry.el.classList.add('cb-leave');
    const onEnd = (): void => {
      if (entry.leaveDone) return;
      entry.leaveDone = true;
      if (entry.leaveTimer !== undefined) { clearTimeout(entry.leaveTimer); entry.leaveTimer = undefined; }
      entry.el.classList.remove('cb-leave');
      const i = this.mounted.indexOf(entry);          // re-find (concurrent removes shift indices)
      if (i >= 0) this.unmountAt(i);
      entry.leaving = false;
      this.onAnimEnd();                               // drains animating; fires the deferred balance
    };
    entry.el.addEventListener('animationend', onEnd, { once: true });
    entry.leaveTimer = setTimeout(onEnd, 600);        // safety if animationend is swallowed
  }

  scrollToBottom(): void {
    if (this.destroyed) return;
    this.pinToBottom();
    // 最新端可能被 trimNewer 截掉（窗口后退、noNewer=false）→ 加载回全局最新（followToNewest 链式直到 noNewer）
    if (!this.noNewer) void this.followToNewest();
  }

  /** Position the viewport at the content bottom (instant, shifting suppresses direction misdetection) and emit. */
  private pinToBottom(): void {
    this.shifting = true;
    this.viewport.scrollTop = this.content.scrollHeight - this.vh;
    this.shifting = false;
    this.lastScrollTop = this.viewport.scrollTop;
    this.emit();
  }

  /** Explicit go-to-bottom follow (started by scrollToBottom): keep loading one newer batch and re-pinning until the
   *  global newest (noNewer). Plan A re-pins explicitly (overflow-anchor also helps). gen guard bails if a jump overtakes. */
  private async followToNewest(): Promise<void> {
    const g = this.gen;
    while (!this.noNewer && !this.destroyed && this.mounted.length > 0) {
      const n = await this.loadNewer();
      if (this.destroyed || g !== this.gen) return;
      if (n === 0) break;
      this.pinToBottom();
    }
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
    if (idx >= 0) { // already mounted: position directly
      this.positionMounted(idx, anchor);
      if (highlight) this.flashHighlight(idx);
      return;
    }
    // not mounted: re-seed the window around id, then position
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
    if (ngDevMode) console.log('[JUMP] openAround start id=', id, 'gen=', g, 'vh=', this.vh, 'threshold=', this.threshold);
    this.resetWindowState();
    try {
      const batch = await this.source.init(id, this.cfg.mountItem, this.cfg.mountItem, this.initOpts);
      if (this.destroyed || g !== this.gen) { if (ngDevMode) console.log('[JUMP] bail: gen overtaken / destroyed'); return; } // overtaken by newer jump / destroyed
      const merged = this.mergeBatch(batch);
      const hasTarget = merged.some(it => this.itemHasId(it, id));
      if (ngDevMode) console.log('[JUMP] init batch merged=', merged.length, 'hasTarget=', hasTarget, 'ids=', merged.slice(0, 2).map(i => i.id), '..', merged.slice(-2).map(i => i.id), 'noOlder/noNewer=', this.noOlder, this.noNewer);
      if (merged.length === 0 || !hasTarget) { this.updateGhost(); this.emit(); return; } // source did not return target
      this.absorbBoundary(merged);
      this.mountBatch(merged, 'init');
      this.measurePending();
      if (ngDevMode) console.log('[JUMP] after init mount+measure: mounted=', this.mounted.length, 'totalH=', Math.round(this.totalH()), 'sampleH=', this.mounted.slice(0, 5).map(e => Math.round(e.height)));
      await this.fillAround(id, g); // fill both ways to threshold/2 (boundary exceptions) + compensate the open side when one side hits a boundary
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
   * 居中跳转的窗口填充：
   *  1) 上方 while 填到 aboveTarget ≥ threshold/2（或撞 noOlder）；下方 while 填到 belowTarget ≥ threshold/2（或撞 noNewer）。
   *  2) 补偿：若一侧到界（不足 threshold/2）→ 向【未到界】的另一侧补，直到 totalH ≥ threshold（两侧都到界则无法补，直接渲染）。
   * 视口尚未定位（scrollTop=0），故加载不补偿/不 trim。方案 A 本就不补偿 scrollTop。gen 守卫防跳转超越在途批。
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
    const cursor = this.olderCursorId();
    const batch = await this.source.getOlder(cursor, this.cfg.mountItem);
    if (this.destroyed || g !== this.gen) return 0;
    const merged = this.mergeBatch(batch);
    if (merged.length === 0) { this.noOlder = true; return 0; }
    this.absorbBoundary(merged);
    const oldGhost = this.ghostEntry;
    this.mountBatch(merged, 'older');
    if (oldGhost && this.mounted.indexOf(oldGhost) > 0) { oldGhost.el.classList.remove('cb-ghost'); this.rebuildEntry(oldGhost); }
    this.measurePending();
    this.updateGhost();
    return merged.length;
  }
  /** 构建中窗口向更新加载一批（append）。空批→noNewer。返回挂载数（0=到界/超越/无数据）。 */
  private async loadNewerIntoFresh(g: number): Promise<number> {
    if (this.destroyed || g !== this.gen || this.noNewer || this.mounted.length === 0) return 0;
    const cursor = this.newerCursorId();
    const batch = await this.source.getNewer(cursor, this.cfg.mountItem);
    if (this.destroyed || g !== this.gen) return 0;
    const merged = this.mergeBatch(batch);
    if (merged.length === 0) { this.noNewer = true; return 0; }
    this.absorbBoundary(merged);
    // Authoritative: a newer batch reaches the global newest iff it carries the 'newest' marker. A full page WITHOUT it
    // means more newer data remains (a large WS backlog spans multiple pages) → noNewer=false so the next load continues.
    // absorbBoundary is sticky (only ever sets true), so without this a partial backlog page left the kernel falsely at
    // the newest, stranding the remaining newer messages off-window.
    this.noNewer = merged.some(it => it.boundary === 'newest');
    this.mountBatch(merged, 'newer');
    // Reached the newest edge → (re)mount in-flight optimistic sends (getPending). loadNewerIntoFresh only runs when
    // !noNewer (the guard above), so the unmount branch cannot fire here — only the follow/fill path uses this.
    if (this.noNewer) this.elevatePending();
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
    this.updateTailCap(); // window emptied → hide the cap (mounted.length === 0 → height 0) until the new batch mounts
  }

  /** 给目标 entry 加一次性高亮闪烁（animationend 移除 class；reflow 保证重复跳转能重启动画）。 */
  private flashHighlight(idx: number): void {
    const el = this.mounted[idx]?.el;
    if (!el) return;
    el.classList.remove('cb-jump-highlight');
    void el.offsetWidth; // 强制 reflow → 重新触发动画
    el.classList.add('cb-jump-highlight');
    el.addEventListener('animationend', () => el.classList.remove('cb-jump-highlight'), { once: true });
  }

  getInfo(): CbScrollInfo {
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
    this.tailCapObs.disconnect();
    this.viewport.removeEventListener('scroll', this.onNativeScroll);
    this.unmountAll();
    if (this.tailCapEl) { this.tailCapEl.remove(); this.tailCapEl = null; } // cap persists across re-seed; torn down only here
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

  // totalH adds tailCapH (the cap is below every real item, so it never enters prefix[]/topOf — only the total). prefix
  // stays real-items-only; this keeps belowTarget/atBottom honest (the cap really is below the last real item) and topOf exact.
  private totalH(): number { this.flushPrefix(); return (this.prefix.length > 0 ? this.prefix[this.prefix.length - 1] : 0) + this.tailCapH; }

  // ---------- 挂载（array index；DOM 按 mounted 顺序，不涉 scrollTop） ----------

  /** mergeItems hook（默认 noop）。在 createItem 前、对每个 source batch 调一次。scope=batch。 */
  private mergeBatch(batch: CbItem<T>[]): CbItem<T>[] {
    return this.hooks.mergeItems ? this.hooks.mergeItems(batch) : batch;
  }

  /**
   * 挂一批（已 merge）：side=init/older → prepend（mounted 首，DOM 插到旧首前）；newer → append（末）。
   * older 不内部 measure（loadOlder 统一测 + ghost rebuild）；init/newer 末尾 measure。
   * prev = 更老邻居：batch 内前一个（升序），或 append 时旧末。
   */
  private mountBatch(merged: CbItem<T>[], side: 'init' | 'older' | 'newer', animate = false): void {
    // merged already passed through the mergeItems hook (per-batch) by the caller; this method only mounts.
    if (merged.length === 0) return;
    if (side === 'newer') {
      for (let i = 0; i < merged.length; i++) {
        const prev = i > 0 ? merged[i - 1] : (this.mounted.length > 0 ? this.mounted[this.mounted.length - 1].item : null);
        this.mounted.push(this.createEntry(merged[i], prev, undefined, animate));
      }
    } else { // init / older both prepend (when init, mounted is empty, anchorEl = null -> appendChild)
      const anchorEl = this.mounted.length > 0 ? this.mounted[0].el : null;
      const fresh: Entry<T>[] = [];
      for (let i = 0; i < merged.length; i++) {
        const prev = i > 0 ? merged[i - 1] : null;
        fresh.push(this.createEntry(merged[i], prev, anchorEl)); // prepended history never animates
      }
      this.mounted.unshift(...fresh);
    }
    this.dirtyPrefix = true;
    if (side !== 'older') this.measurePending();
    this.updateTailCap(); // re-measure the cap every batch mount: a newer batch reaching the global newest flips loading→gap
  }

  /** Create and mount one entry: createItem + DOM insert (before anchorEl / append) + pendingMeasure + subscribe to height.
   *  `animate` (default false) marks a mount that should play cb-enter after its height settles — only insertAfter and
   *  appendLive pass true; scroll-loaded history batches (init/older/newer) never animate. */
  private createEntry(item: CbItem<T>, prev: CbItem<T> | null, anchorEl?: HTMLElement | null, animate = false): Entry<T> {
    if (ngDevMode) this.mountTick++;
    const vs = this.hooks.createItem(item, prev);
    const el = vs.el;
    el.dataset['cbId'] = String(item.id);
    if (anchorEl !== undefined && anchorEl !== null) this.content.insertBefore(el, anchorEl);
    else if (this.tailCapEl) this.content.insertBefore(el, this.tailCapEl); // append path: keep the tail cap always last
    else this.content.appendChild(el);
    const entry: Entry<T> = { item, el, vs, height: 0, unsub: () => {}, transient: false, optimistic: false, resortTarget: false, animate, leaving: false, leaveDone: false }; // real height set by measurePending()
    el.classList.add('cb-pending');
    this.pendingMeasure.push(entry);
    this.mounting = true; // suppress the first report (same as id-based)
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
  /**
   * Rebuild a mounted entry in place: re-runs createItem with the current real prev (mounted[idx-1], the older neighbor),
   * replaces the DOM in place (insertBefore(newEl,oldEl)+removeChild(oldEl)), migrates the subscription. When `newItem`
   * is given (settle: optimistic->confirmed) the entry's item is replaced too; otherwise (ghost reveal) the item is
   * unchanged. **Lightweight**: does not measurePending -- loadOlder does one unified measure after "mount new batch +
   * ghost reveal". Plan A never compensates scrollTop (browser overflow-anchor pins the viewport). Never sets `animate`
   * (a rebuild reuses an already-visible slot; no cb-enter).
   */
  private rebuildEntry(entry: Entry<T>, newItem: CbItem<T> = entry.item): void {
    const idx = this.mounted.indexOf(entry);
    if (idx < 0) return;
    if (ngDevMode) this.mountTick++;
    const newPrev = idx > 0 ? this.mounted[idx - 1].item : null; // older neighbor (one index lower)
    const newVs = this.hooks.createItem(newItem, newPrev);
    const newEl = newVs.el;
    newEl.dataset['cbId'] = String(newItem.id);
    this.content.insertBefore(newEl, entry.el);
    this.content.removeChild(entry.el);
    entry.unsub();
    entry.vs = newVs;
    entry.el = newEl;
    entry.item = newItem; // no-op for ghost reveal (same ref); replaces item for settle
    entry.height = 0; // real height set by measurePending() (loadOlder measures after rebuild)
    newEl.classList.add('cb-pending');
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

  /** Unmount the entry at an arbitrary index (used by removeItem's exit-animation completion). Plan A does not
   *  compensate scrollTop (browser overflow-anchor pins the viewport). */
  private unmountAt(i: number): boolean {
    if (i < 0 || i >= this.mounted.length) return false;
    const e = this.mounted[i];
    e.unsub();
    if (e.el.parentNode === this.content) this.content.removeChild(e.el);
    e.vs.destroy();
    this.mounted.splice(i, 1);
    if (ngDevMode) this.unmountTick++;
    this.dirtyPrefix = true;
    return true;
  }

  /** Cancel any in-flight enter/leave/move animation on an entry being force-unmounted (jump re-seed / destroy).
   *  Decrements `animating` exactly once per in-flight animation (guarded by enterTimer / leaveDone / moveTimer) so the
   *  counter does not leak across a window reset, and the deferred animationend/timeout handlers become no-ops. */
  private cancelEntryAnim(entry: Entry<T>): void {
    if (entry.enterTimer !== undefined) {
      clearTimeout(entry.enterTimer); entry.enterTimer = undefined;
      entry.el.classList.remove('cb-enter');
      this.animating--;
    }
    if (entry.leaving && !entry.leaveDone) {
      if (entry.leaveTimer !== undefined) clearTimeout(entry.leaveTimer);
      entry.leaveDone = true; entry.el.classList.remove('cb-leave');
      this.animating--;
    }
    if (entry.moveTimer !== undefined) {
      clearTimeout(entry.moveTimer); entry.moveTimer = undefined;
      entry.el.classList.remove('cb-move');
      entry.el.style.removeProperty('--cb-move-dy');
      this.animating--;
    }
  }

  private unmountAll(): void {
    for (const e of this.mounted) {
      this.cancelEntryAnim(e);
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
   *（不怕数组位移）；变了则旧 ghost 移 cb-ghost、新 ghost 加 cb-ghost。
   * ghost 显形的 rebuild 由 loadOlder 在挂新批后显式做（并入统一 measure）。noOlder 时 target=null 永久消失。
   */
  private updateGhost(): void {
    const target = !this.noOlder && this.mounted.length > 0 ? this.mounted[0] : null;
    if (target === this.ghostEntry) return;
    this.ghostEntry?.el.classList.remove('cb-ghost');
    target?.el.classList.add('cb-ghost');
    this.ghostEntry = target;
  }

  /**
   * Sync the tail cap (class toggle + MEASURED height), mirroring {@link updateGhost} at the newer edge. The cap is a
   * persistent non-message element kept as the last child of content (never in mounted[]), so it never corrupts the newer
   * cursor (mounted[last].item.id) and never shifts a real item's topOf. Mode:
   *  - mounted empty → hidden (height 0): no lone spinner during the empty first load / re-seed.
   *  - noNewer       → gap: a small spacer below the last message (breathing room above the input bar).
   *  - !noNewer      → loading: the same centered spinner as the top ghost (cb-tail-cap--loading).
   * Height is READ via offsetHeight, never assumed — CSS owns the dimension (gap/spinner size), the kernel measures it so
   * totalH stays exact even if the CSS is later tuned. Called at the end of every mountBatch (a newer batch reaching the
   * global newest flips loading→gap and genuinely changes the height) and on resize via tailCapObs. Plan A does not
   * compensate scrollTop (browser overflow-anchor pins the viewport); in either case the cap sits below every real item,
   * so a height change moves nothing above it.
   */
  private updateTailCap(): void {
    const el = this.tailCapEl;
    if (!el) return;
    const mode: 'hidden' | 'gap' | 'loading' = this.mounted.length === 0 ? 'hidden' : this.noNewer ? 'gap' : 'loading';
    el.classList.toggle('cb-tail-cap--gap', mode === 'gap');
    el.classList.toggle('cb-tail-cap--loading', mode === 'loading');
    this.tailCapH = el.offsetHeight;
  }

  // ---------- balance：检查点 + 加载（无补偿） ----------

  /** Viewport resized (soft keyboard open/close, orientation change, window resize). Reflow, not a checkpoint:
   *  re-measure vh and keep the reading position. Was-at-bottom → re-pin and skip load/trim (a shrink-triggered
   *  balance is jitter); mid-screen → scheduleBalance is a no-op unless at an edge. Content-driven rebalances still
   *  run via onElHeight + onNativeScroll. */
  private onViewportResize(): void {
    if (this.destroyed) return;
    const wasAtBottom = this.isAtBottom();   // capture BEFORE re-measure (old vh)
    this.measureVh();                         // apply the new vh
    if (wasAtBottom && this.mounted.length > 0) {
      this.pinToBottom();
      this.suppressScrollBalance = true;  // swallow the async scroll event the pin fires (no load/trim at bottom)
      return;
    }
    this.scheduleBalance();
  }

  private onNativeScroll = () => {
    if (this.shifting || this.destroyed) return;
    if (this.suppressScrollBalance) { this.suppressScrollBalance = false; return; }  // consume the reflow-pin's scroll event
    this.scheduleBalance();
  };

  private scheduleBalance(): void {
    if (this.dirty || this.destroyed) return;
    // An enter/exit animation is in flight: hold the checkpoint until it drains. Mount/unmount ops still proceed
    // (each manages `animating`), so concurrent add+remove keep animating — only the load/trim checkpoint waits.
    if (this.animating > 0) { this.deferBalance = true; return; }
    this.dirty = true;
    this.rafId = requestAnimationFrame(() => { this.dirty = false; this.balance(); });
  }

  /** Animation completion drain (called from every enter/exit animationend). When the last one finishes, fire the
   *  balance that was deferred while animating>0. */
  private onAnimEnd(): void {
    if (this.animating > 0) this.animating--;
    if (this.animating === 0 && this.deferBalance && !this.destroyed) {
      this.deferBalance = false;
      this.scheduleBalance();
    }
  }

  /** Play the cb-enter mount animation on a freshly-measured entry (cb-pending already removed -> visible).
   *  `enterTimer !== undefined` is the "still in flight" signal; finish() and teardown both guard on it so the
   *  `animating` counter is decremented exactly once (animationend, safety timeout, or forced unmount). */
  private enterAnim(entry: Entry<T>): void {
    const finish = (): void => {
      if (entry.enterTimer === undefined) return;
      clearTimeout(entry.enterTimer); entry.enterTimer = undefined;
      entry.el.classList.remove('cb-enter');
      this.onAnimEnd();
    };
    entry.el.classList.add('cb-enter');
    this.animating++;
    entry.enterTimer = setTimeout(finish, 600); // safety if animationend is swallowed
    entry.el.addEventListener('animationend', finish, { once: true });
  }

  private async balance(): Promise<void> {
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

    if (atTop && dir !== 'down' && !this.noOlder) { await this.loadOlder(); this.trimNewer(); }
    else if (atBottom && dir !== 'up' && !this.noNewer) { await this.loadNewer(); await this.reconcileOptimistic(); this.trimOlder(); }

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
   * 向更老加载：getOlder（游标=olderCursorId()，最老的非 transient 挂载项）+ mergeItems + 挂 prepend + 旧 ghost（原 mounted[0]）
   *  显形 rebuild。方案 A **不补偿 scrollTop**（浏览器 overflow-anchor 钉视口）；ghost 显形与新批共用一次 measure。
   * absorbBoundary 在 revalidate 通过后才调（防 fling 回滑误锁 noOlder → 最老批永久不挂）。
   */
  private async loadOlder(): Promise<void> {
    if (this.inflightOlder || this.noOlder || this.mounted.length === 0) return;
    this.inflightOlder = true;
    const g = this.gen;
    try {
      const cursor = this.olderCursorId();
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
        oldGhost.el.classList.remove('cb-ghost'); // 须在 rebuild 换 el 前
        this.rebuildEntry(oldGhost);
      }
      this.measurePending(); // 一次统一测：新批 + ghost 显形（方案 A 不补偿）
      this.updateGhost();
    } finally {
      this.inflightOlder = false;
    }
    this.emit();
  }

  /** Load ONE newer batch: getNewer + mergeItems, then a mount-dispatch. **Pure load — no trim** (split: the caller —
   *  balance / onMessageSignal — trims + reconciles). Returns the count mounted (0 = boundary / overtaken / no data). */
  private async loadNewer(force = false): Promise<number> {
    if (this.inflightNewer || this.mounted.length === 0) return 0;
    if (!force && this.noNewer) return 0;
    this.inflightNewer = true;
    const g = this.gen;
    let batch: CbItem<T>[];
    try {
      const cursor = this.newerCursorId();
      batch = await this.source.getNewer(cursor, this.cfg.mountItem);
      if (this.destroyed || g !== this.gen) return 0;
    } finally {
      this.inflightNewer = false;
    }
    if (this.destroyed || g !== this.gen) return 0;
    if (batch.length === 0) { this.noNewer = true; return 0; }
    if (!force && !this.revalidateBottom()) return 0;
    const wasAtNewest = this.noNewer;                        // pre-load edge state (transition gate for the optimistic dispatch)
    this.absorbBoundary(batch);
    // Authoritative: a newer batch reaches the global newest iff it carries the 'newest' marker. A full page WITHOUT it
    // means more newer data remains (a large WS backlog spans multiple pages) → noNewer=false so the next load continues.
    // absorbBoundary is sticky (only ever sets true), so without this a partial backlog page left the kernel falsely at
    // the newest, stranding the remaining newer messages off-window.
    this.noNewer = batch.some(it => it.boundary === 'newest');

    const count0 = this.mounted.length;
    // The batch is reals only — in-flight optimistic sends are mounted separately at the newest edge via elevatePending.
    this.mountNewerReals(this.mergeBatch(batch));
    // Symmetric optimistic lifecycle — (re)mount at the newest edge; unmount when a push extended the newest
    // (wasAtNewest && !noNewer). Recoverable via getPending on returning to the newest.
    if (this.noNewer) this.elevatePending();
    else if (wasAtNewest) this.unmountAllOptimistic();
    this.dirtyPrefix = true;
    this.measurePending();
    this.updateGhost();
    this.updateTailCap();
    this.emit();
    return this.mounted.length - count0;
  }

  /**
   * (Re)mount in-flight optimistic sends at the global newest edge (mirror of Plan B). Driven by source.getPending();
   * a pending matching a mounted transient is promoted (transient→optimistic), one already mounted is skipped, one not
   * mounted is appended at the tail as optimistic. No-op in the common case (insertAfter pre-mounts for display).
   */
  private elevatePending(): void {
    for (const p of this.source.getPending()) {
      const idx = this.indexOfClientMsgId(p.clientMessageId);
      if (idx >= 0) {
        const e = this.mounted[idx];
        if (e.transient) { e.transient = false; e.optimistic = true; } // promote
      } else {
        const tail = this.mounted.length > 0 ? this.mounted[this.mounted.length - 1].item : null;
        const entry = this.createEntry(p, tail, undefined, true);
        entry.optimistic = true;
        this.mounted.push(entry);
      }
    }
  }

  /**
   * Remove every in-flight optimistic send (mirror of Plan B). Called when a push extended the newest (noNewer
   * true→false). Not lost — re-mounted by elevatePending on returning to the newest. Synchronous (no cb-leave);
   * iterate downward. Plan A relies on overflow-anchor (no manual scrollTop compensation).
   */
  private unmountAllOptimistic(): void {
    let removed = false;
    for (let i = this.mounted.length - 1; i >= 0; i--) {
      if (this.mounted[i].optimistic) { this.unmountAt(i); removed = true; }
    }
    if (removed) this.dirtyPrefix = true;
  }

  /** Mount real items before the optimistic/transient tail block (mirror of Plan B; Plan A adds no scrollTop compensation). */
  private mountNewerReals(reals: CbItem<T>[]): void {
    if (reals.length === 0) return;
    let insertIdx = this.mounted.length;
    for (let i = this.mounted.length - 1; i >= 0; i--) {
      const e = this.mounted[i];
      if (!e.transient && !e.optimistic && !e.leaving && !e.resortTarget) { insertIdx = i + 1; break; }
    }
    for (const item of reals) {
      // Confirm by clientMessageId: the real carries a fresh server id (≠ the optimistic's clientMessageId-as-id),
      // so the pair is matched by clientMessageId, not id. No clientMessageId → a plain incoming message.
      const confirm = this.indexOfClientMsgId(item.clientMessageId) >= 0;
      if (!confirm && this.indexOfId(item.id) >= 0) continue;
      const anchorEl = insertIdx < this.mounted.length ? this.mounted[insertIdx].el : null;
      const prev = insertIdx > 0 ? this.mounted[insertIdx - 1].item : null;
      const entry = this.createEntry(item, prev, anchorEl, !confirm);
      if (confirm) { entry.resortTarget = true; }
      this.mounted.splice(insertIdx, 0, entry);
      insertIdx++;
    }
    this.dirtyPrefix = true;
  }

  /** Optimistic-confirm reconciliation (mirror of Plan B; Plan A relies on overflow-anchor — no manual scrollTop
   *  compensation on removal). Synchronous: for each real flagged resortTarget, remove the optimistic duplicate and tag
   *  the real cb-confirmed. No slide, no hiding — the swap is never painted as two bubbles (runs within the
   *  loadNewer→reconcile microtask). No-op when there are no resortTargets. */
  private async reconcileOptimistic(): Promise<void> {
    const targets = this.mounted.filter(e => e.resortTarget);
    if (targets.length === 0) return;
    this.resorting = true;
    try {
      const pairs: { source: Entry<T>; target: Entry<T> }[] = [];
      for (const target of targets) {
        // Pair by clientMessageId (the real's fresh server id ≠ the optimistic's id → not id-matchable; and indexOfId
        // would return the target itself since the real is mounted BEFORE the optimistic source).
        const si = this.indexOfClientMsgId(target.item.clientMessageId);
        if (si >= 0) pairs.push({ source: this.mounted[si], target });
      }
      if (pairs.length === 0) {
        // No source mounted (e.g. a jump during pending unmounted it): the real is already visible — just tag it.
        for (const t of targets) { t.resortTarget = false; t.el.classList.add('cb-confirmed'); }
        return;
      }
      this.flushPrefix();
      // Remove each optimistic source (the duplicate) — Plan A: overflow-anchor pins the viewport (no manual compensation).
      // No slide: the real is already visible beside it and this pass is synchronous (before paint), so the swap reads as
      // an in-place handoff, not a two-bubble flash.
      for (const source of pairs.map(p => p.source)) {
        const i = this.mounted.indexOf(source);
        if (i < 0) continue;
        this.unmountAt(i);
      }
      // The real is already visible — the cb-confirmed tag alone gates the spinner→check→fade choreography on these reals.
      for (const target of pairs.map(p => p.target)) {
        target.resortTarget = false;
        target.el.classList.add('cb-confirmed');
      }
      this.dirtyPrefix = true;
      this.measurePending();
    } finally {
      this.resorting = false;
    }
    this.emit();
  }

  /**
   * Re-sync the mounted optimistic/pending entries to the source's current `getPending()` snapshot. The caller mutates
   * the pending store first (e.g. the source marks a send failed and sinks it to the end) THEN calls this, so the
   * source stays the single owner of pending order/status and the kernel only reflects it.
   *
   * For each mounted optimistic entry (a contiguous tail block), matched to `fresh` by clientMessageId:
   *  - status change (new data ref) → morphed IN PLACE via `vs.update` (no remount — preserves the DOM node so a FLIP
   *    move can animate it);
   *  - order change → the optimistic tail block is reordered (mounted[] + DOM) to match `fresh`;
   *  - then EVERY entry whose absolute top changed (the mover AND any sibling shoved up/down by it) is FLIP-animated
   *    (cb-move) from its old top to its new top.
   *
   * Synchronous body (no I/O — a pure re-read of getPending); declared async to match reconcileOptimistic's shape so
   * callers can `await` it uniformly. Status-morph height deltas are folded into prefix under the `measuring` guard.
   * Plan A needs no scrollTop compensation for the reorder: a pure reorder within the optimistic tail leaves total
   * height and all above-viewport positions invariant, and the transform is visual-only so overflow-anchor is undisturbed.
   *
   * Skips fresh ids not currently mounted (new sends mount via insertAfter) and mounted optimistic not in fresh (removal
   * is reconcileOptimistic's job on confirm) — both are no-ops here.
   */
  async reconcilePending(): Promise<void> {
    if (this.destroyed || this.resetting) return;
    const fresh = this.source.getPending();

    // Optimistic entries form a contiguous tail block; collect the non-leaving ones (leaving ones are mid-exit).
    const suffix: Entry<T>[] = [];
    for (let i = this.mounted.length - 1; i >= 0; i--) {
      const e = this.mounted[i];
      if (!e.optimistic) break;
      if (!e.leaving) suffix.unshift(e);
    }
    if (suffix.length === 0) return;

    // 1. Capture the OLD absolute top of EVERY suffix entry before any mutation (a shoved sibling must animate too, not
    //    only the explicit mover). Keyed by entry ref — indices shift once we splice.
    this.flushPrefix();
    const oldTop = new Map<Entry<T>, number>();
    for (const e of suffix) oldTop.set(e, this.topOf(this.mounted.indexOf(e)));

    // 2. Morph: swap in the fresh item (new data ref ⇒ status changed) where the clientMessageId matches.
    const freshByCid = new Map<string, CbItem<T>>();
    for (const f of fresh) if (f.clientMessageId !== undefined) freshByCid.set(f.clientMessageId, f);
    for (const e of suffix) {
      const f = e.item.clientMessageId !== undefined ? freshByCid.get(e.item.clientMessageId) : undefined;
      if (f && f !== e.item) e.item = f;
    }

    // 3. Reorder mounted[] + DOM so the suffix matches `fresh` order (only optimistic entries move; reals/transients
    //    above stay put). desired = the suffix entries ordered by their position in fresh (defensively keeps any suffix
    //    entry not found in fresh at the end so nothing is dropped).
    const used = new Set<Entry<T>>();
    const desired: Entry<T>[] = [];
    for (const f of fresh) {
      if (f.clientMessageId === undefined) continue;
      const e = suffix.find(x => x.item.clientMessageId === f.clientMessageId);
      if (e && !used.has(e)) { desired.push(e); used.add(e); }
    }
    for (const e of suffix) if (!used.has(e)) desired.push(e);
    const reordered = desired.some((e, i) => e !== suffix[i]);
    if (reordered) {
      const suffixSet = new Set(suffix);
      const rest = this.mounted.filter(e => !suffixSet.has(e));
      this.mounted = [...rest, ...desired];
      for (const e of desired) {
        if (this.tailCapEl) this.content.insertBefore(e.el, this.tailCapEl); // keep the cap always last
        else this.content.appendChild(e.el);
      }
      this.dirtyPrefix = true;
    }

    // 4. Apply data + grouping in place (prev is final now) and fold any status-morph height delta synchronously under
    //    the measuring guard so prefix stays honest.
    this.flushPrefix();
    this.measuring = true;
    for (const e of suffix) {
      const idx = this.mounted.indexOf(e);
      if (idx < 0) continue;
      const newPrev = idx > 0 ? this.mounted[idx - 1].item : null;
      e.vs.update(e.item, newPrev); // re-render data + recomputed grouping on the same node
      const h = e.el.offsetHeight;   // real height after the re-render
      if (h !== e.height) { e.height = h; this.dirtyPrefix = true; }
    }
    this.measuring = false;

    // 5. FLIP every suffix entry whose absolute top changed (reorder and/or morph height delta).
    this.flipMove(suffix, oldTop);

    this.emit();
  }

  /**
   * FLIP-move (cb-move) entries whose absolute top changed in a reconcilePending pass. FLIP = First-Last-Invert-Play:
   * each mover's old top is passed in; after the reorder/height-change its new top is recomputed, an invert transform
   * makes it APPEAR still at the old top, and the @keyframes animates the transform to identity so it slides to the new.
   *
   * Rides the existing animation/animationend/`animating` convention (no CSS transition — _cb.scss uses only keyframes;
   * this keeps the animEnd test helper valid). The invert offset is a per-element CSS var (--cb-move-dy) consumed by the
   * @keyframes, set before a forced reflow so the browser registers the inverted start. `moveTimer !== undefined` is the
   * "still in flight" signal (mirrors enterTimer); cancelEntryAnim clears it on teardown. animating is bumped so balance
   * defers until the moves drain. delta===0 entries are skipped (no motion).
   */
  private flipMove(entries: Entry<T>[], oldTop: Map<Entry<T>, number>): void {
    this.flushPrefix();
    const movers: { entry: Entry<T>; el: HTMLElement; delta: number }[] = [];
    for (const e of entries) {
      if (e.leaving) continue;
      const idx = this.mounted.indexOf(e);
      if (idx < 0) continue;
      const newTop = this.topOf(idx);
      const delta = (oldTop.get(e) ?? newTop) - newTop;
      if (delta !== 0) movers.push({ entry: e, el: e.el, delta });
    }
    if (movers.length === 0) return;
    // Invert: each mover visually sits at its old top (new layout position + translateY(delta)).
    for (const m of movers) m.el.style.setProperty('--cb-move-dy', `${m.delta}px`);
    void this.content.offsetWidth; // force reflow so the invert start registers before the animation class is added
    // Play: add cb-move (the @keyframes animates translateY(var) → none = old top → new top). animating bumped → balance deferred.
    for (const m of movers) {
      const finish = (): void => {
        if (m.entry.moveTimer === undefined) return; // already finished (animationend + safety timeout guard)
        clearTimeout(m.entry.moveTimer); m.entry.moveTimer = undefined;
        m.el.classList.remove('cb-move');
        m.el.style.removeProperty('--cb-move-dy');
        this.onAnimEnd();
      };
      m.el.classList.add('cb-move');
      this.animating++;
      m.entry.moveTimer = setTimeout(finish, 600); // safety if animationend is swallowed
      m.el.addEventListener('animationend', finish, { once: true });
    }
  }

  /** 截更新端（底部，mounted 末）。**保留视口下方 buffer**：截后 content 底（totalH-h）须仍 > 视口底（st+vh）+ edge，
   *  否则不截——防 compensateAbove 把 st 推大后 trim 截到视口内 → st 超出 total → atBottom 误判 → loadNewer 跳到底。
   *  截掉最新端 → 重置 noNewer。无补偿（底部在视口下方）。 */
  private trimNewer(): void {
    if (this.resorting) return; // rule 4a: never trim during a resort
    let trimmed = false;
    while (this.mounted.length > 1) {
      const last = this.mounted[this.mounted.length - 1];
      // Never trim an in-flight optimistic/transient send or an exiting (leaving) item. Rule 4c: the optimistic block
      // is atomic — reaching it aborts the trim (only reconcileOptimistic removes a member, never trim).
      if (last.transient || last.optimistic || last.leaving) break;
      this.flushPrefix();
      const h = last.height;
      if (this.totalH() - h > this.threshold && (this.totalH() - h) - (this.viewport.scrollTop + this.vh) > this.cfg.edge) {
        this.unmountBot(); trimmed = true;
      } else break;
    }
    if (trimmed) this.noNewer = false;
  }

  /** 截更老端（顶部，mounted[0]）。**保留视口上方 buffer**：截后视口上方（st-h）须 > edge（对称 trimNewer）。
   *  方案 A **不补偿 scrollTop**（浏览器 overflow-anchor 钉住视口）。截掉最老端 → 重置 noOlder。 */
  private trimOlder(): void {
    if (this.resorting) return; // rule 4a: never trim during a resort
    let trimmed = false;
    while (this.mounted.length > 1) {
      const first = this.mounted[0];
      // Never trim transient/optimistic/leaving, and rule 4b: never trim the global-newest real item.
      if (first.transient || first.optimistic || first.leaving || first.item.boundary === 'newest') break;
      this.flushPrefix();
      const h = first.height;
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

  /** Whether an item represents the given msgId — matches CbItem.id OR any member in CbItem.ids
   *  (so a jump to a non-head album member still resolves to its album item). */
  private itemHasId(item: CbItem<T>, id: string | number): boolean {
    const key = String(id);
    if (String(item.id) === key) return true;
    const ids = item.ids;
    return ids !== undefined && ids.some(x => String(x) === key);
  }

  private indexOfId(id: string | number): number {
    return this.mounted.findIndex(e => this.itemHasId(e.item, id));
  }

  /** Index of the in-flight optimistic/transient entry carrying the given clientMessageId — the reconcile key
   *  that pairs an optimistic send with its confirmed real (the real gets a fresh server id, so the pair cannot
   *  be matched by id). Scans transient/optimistic entries only; -1 if none / cid absent. */
  private indexOfClientMsgId(cid: string | undefined): number {
    if (cid === undefined) return -1;
    return this.mounted.findIndex(e => (e.transient || e.optimistic) && e.item.clientMessageId === cid);
  }

  /** 最老的【真实 source 成员】挂载项 id——跳过 transient/optimistic（insertAfter 插入项 / 在途 pending），其 id 非 source 游标。
   *  loadOlder 用它，防 transient/optimistic 经 trim 到达 mounted[0] 后让 getOlder 返回 [] 误锁 noOlder。调用方保证 mounted 非空。 */
  private olderCursorId(): string | number {
    for (const e of this.mounted) if (!e.transient && !e.optimistic && !e.leaving) return e.item.id;
    return this.mounted[0].item.id; // unreachable in practice (the insert/remove target is always a real neighbor)
  }

  /** 最新的【真实 source 成员】挂载项 id——跳过 transient/optimistic 与 leaving。与 olderCursorId 对称。 */
  private newerCursorId(): string | number {
    for (let i = this.mounted.length - 1; i >= 0; i--) if (!this.mounted[i].transient && !this.mounted[i].optimistic && !this.mounted[i].leaving) return this.mounted[i].item.id;
    return this.mounted[this.mounted.length - 1].item.id;
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

  private absorbBoundary(items: CbItem<T>[]): void {
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
      if (this.mounted.indexOf(entry) < 0) continue; // already unmounted (guard against trim leftovers)
      const h = entry.el.offsetHeight;
      if (ngDevMode && h === 0) zeros++;
      this.onElHeight(entry, h);
      entry.el.classList.remove('cb-pending');
      if (entry.animate) { entry.animate = false; this.enterAnim(entry); } // cb-enter now that the element is visible
    }
    this.measuring = false;
    if (ngDevMode && (zeros > 0 || this.resetting)) console.log('[JUMP] measure n=', entries.length, 'zeroH=', zeros, 'contentScrollH=', this.content.scrollHeight);
  }

  private emit(): void { this.onScroll?.(this.getInfo()); }
}
