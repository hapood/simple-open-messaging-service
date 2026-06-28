/**
 * 消息分组判定（纯函数，无 DOM/框架依赖）。
 *
 * 业界（WhatsApp）式分组：连续消息「同发送者」归为一组（不再用时间窗口——时间间隔交由日期分隔行断开），
 * 组首显头像+名字、组内贴近上一条、每条仍显自己的时间戳。头像显隐直接决定单条渲染高度，
 * 是虚拟滚动（尤其 scrollTo(id) 跳转高度计算）的地基。
 *
 * 抽离自 MsgGroupFactory._buildDispDict，纯函数化，供 playground 假数据与真实消息列表统一复用。
 */

export interface GroupCtx {
  /** 发送者标识（用户 id）。 */
  creator: number | string;
}

export interface GroupFlags {
  /** 组首：显头像 + 名字（无 prev / 换发送者 → 开新组）。 */
  isShowHead: boolean;
  /** 组内合并：贴近上一条（有 next 且同发送者 → 每条仍显自己的时间戳）。 */
  isDateShrink: boolean;
}

/**
 * 判定单条消息的分组标志（按发送者连续分组，WhatsApp 式）。
 *
 * @param prev 上一条（组首判定依据）；列表首条 / 日期分隔后传 null。
 * @param cur  当前条。
 * @param next 下一条（组内合并判定依据）；列表末条传 null。
 */
export function classifyGroupFlags(
  prev: GroupCtx | null,
  cur: GroupCtx,
  next: GroupCtx | null,
): GroupFlags {
  // 组首：无 prev / 换发送者 → 开新组，显头像+名字。
  const isShowHead = !prev || prev.creator !== cur.creator;
  // 组内合并：有 next 且同发送者 → 贴近上一条（每条仍显自己的时间戳）。
  const isDateShrink = !!next && next.creator === cur.creator;
  return { isShowHead, isDateShrink };
}
