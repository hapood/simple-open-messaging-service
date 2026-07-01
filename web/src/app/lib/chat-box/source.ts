/**
 * 数据源契约（VsSource）：虚拟滚动内核与「数据从哪来」之间的隔离层。
 *
 * 内核（ChatBoxScroller / ChatBoxScrollerAnchor）只管窗口策略 + 渲染（array index-based：
 * mounted[] 有序数组，下标=局部 index），通过本接口向数据层「要数据」；数据层拥有缓存 + IO
 *（HTTP / 生成器）。
 *
 * 【source 只给原始数据】source 返回**原始 msg**（`VsItem.id` = 真实 msgId），**不合并相册、
 *  不分配展示用连续 id**。相册合并是展示决策，由内核 `mergeItems` hook 做（per-batch，createItem 前）。
 *  source 只管 IO + 去重（knownMsgIds，IO 防重复）+ boundary 标记。
 *
 * 【cursor 游标】内核请求更老/更新数据时，传「当前窗口边界 item 的 msgId」当游标 + 方向 + count
 *  （`getOlder(cursorId, count)` / `getNewer(cursorId, count)`）。不依赖连续数值 id —— 内核位置（array
 *  index）与数据 id（msgId）彻底解耦。
 *
 * 【init 锚点】init(anchorId, olderCount, newerCount) 的 anchorId：
 *  - `-1` = 全局最新（锚点=最新，newerCount 忽略、out[last] 恒 'newest'；首屏从最新往更老铺）。
 *  - 其他（string|number）= 真实 msgId：**双向取**——olderCount 条更老（含 anchorId）+ newerCount 条更新，
 *    返回以 anchorId 居中的升序窗口（跳转到指定消息 / 从通知打开会话用）。全局最旧/最新仍按 boundary 标记。
 *
 * 【升序约定】init / getOlder / getNewer 均返回**升序**（旧→新）：out[0]=最老、out[last]=最新。
 *  内核 prepend（older）时 `mounted = [...batch, ...mounted]`、append（newer）时 `mounted = [...mounted, ...batch]`。
 *
 * 【缓存归 source】内核只持「已挂 VsElement」；trim 即忘；回滑重挂 = 再 getOlder/getNewer
 *  （source 缓存命中、近同步返回）。内核无「loaded 区间」，只有「mounted 区间」。
 *
 * 【边界】source 给全局最旧/最新 item 打 boundary 标记；内核读到 → 自维护 noOlder/noNewer。
 *  - getOlder 到 DB 最旧 → out[0]（升序首位=最老）带 'oldest'
 *  - getNewer 到 DB 最新 → out[last]（升序末位=最新）带 'newest'
 *  - init：out[0] 最老（到最旧带 'oldest'）、out[last] 最新（恒 'newest'，锚点=最新）
 *
 * 框架无关：不 import Angular/HTTP，仅 type-only 引用 VsItem（编译期擦除，无运行时循环依赖）。
 */
import type { VsItem } from './chat-box-scroller';

/** init 的业务参数（生产侧 HTTP 需要 chatId 等；mock 忽略。后续按需扩展 threadId 等）。 */
export interface VsSourceInitOpts {
  chatId?: number;
}

/**
 * 内核依赖的数据源接口（泛型）。
 *
 * `cursorId` 是 `VsItem.id`（= 真实 msgId），内核从挂载窗口边界 item 取，仅作 source 游标，
 * 不参与内核位置算术。
 */
export interface VsSource<T = unknown> {
  /**
   * 初始化 / 重锚：以 anchorId 为锚加载 olderCount 条更老 + newerCount 条更新。
   *  - anchorId: `-1` = 全局最新（newerCount 忽略、out[last] 恒 'newest'）；
   *    其他（string|number）= 真实 msgId → 双向取（olderCount 含 anchorId + newerCount 更新）。
   * 返回【原始 msg】items（升序：旧→新；VsItem.id = msgId；全局最旧/最新带 boundary）。
   * 内核 init() 首屏用 -1；scrollToIndex(id)/init({startMsgId}) 跳转用真实 msgId。
   */
  init(anchorId: string | number, olderCount: number, newerCount: number, opts?: VsSourceInitOpts): Promise<VsItem<T>[]>;
  /**
   * 从 cursorId（msgId）向【更老】方向取 count 条。返回【原始 msg】items（升序；id=msgId）。
   * 到 DB 最旧 → out[0]（最老）带 boundary:'oldest'。
   */
  getOlder(cursorId: string | number, count: number): Promise<VsItem<T>[]>;
  /**
   * 从 cursorId（msgId）向【更新】方向取 count 条。返回【原始 msg】items（升序；id=msgId）。
   * 到 DB 最新 → out[last]（最新）带 boundary:'newest'。
   */
  getNewer(cursorId: string | number, count: number): Promise<VsItem<T>[]>;
  /**
   * 实时新消息（WS）：原样入缓存，返回带 boundary:'newest' 的 items（VsItem.id = msgId）。
   * 内核 append 到底。去重由 source 内部 knownMsgIds 处理（IO 防重复）。
   */
  appendLive(items: VsItem<T>[]): VsItem<T>[];
  /** 释放（退订 WS 等）。 */
  destroy(): void;
}
