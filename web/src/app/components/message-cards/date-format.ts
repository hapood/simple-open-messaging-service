import dayjs from 'dayjs';

/**
 * 日期分隔标签的前端计算。
 *
 * date 不再是数据源的 CbItem（不再随 source 返回、不占抽象 id），而是 createItem 工厂挂载时
 * 按「相邻消息跨日」判定的【派生视图】——比较当前 msg 与窗口内前一条（更老邻居 prev）的
 * createdAtMs，跨日则在当前 msg 上方插一个 date pill。
 *
 * 一处判定覆盖三种来源（prev 一律是内核传入的窗口内前一条）：
 *  ① 批次内连续挂载：prev = 同批前一条；
 *  ② 批次边界挂载：prev = 上一批末条；
 *  ③ oldest：prev = null（全局最老，无更老邻居）。
 */

/** Date separator label: Today / Yesterday / weekday name / MMM D / MMM D, YYYY. */
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function formatDateSeparator(ms: number): string {
  const d = dayjs(ms);
  const now = dayjs();
  if (d.isSame(now, 'day')) return 'Today';
  if (d.isSame(now.subtract(1, 'day'), 'day')) return 'Yesterday';
  if (d.isAfter(now.subtract(7, 'day'))) return WEEKDAYS[d.day()];
  if (d.isSame(now, 'year')) return d.format('MMM D');
  return d.format('MMM D, YYYY');
}

/** 两时刻是否同一天（日历日，跨年同月日也算不同天）。 */
export function sameDay(a: number, b: number): boolean {
  return dayjs(a).isSame(b, 'day');
}

/**
 * 当前 msg 上方是否需要 date 分隔。
 *
 *  - prev 存在且同天 → 否（组内连续）。
 *  - prev 存在且跨天 → 是。
 *  - prev==null 且 isOldestBoundary → 是（对话真正第一条上方固定 date）。
 *  - prev==null 且非 oldest → **否**。关键：窗口中部 trim 后重挂时，prev 邻居已被内核回收
 *    （unmountOne 连同 items.delete）→ prev==null，但此条并非 oldest；此时不显 date，否则
 *    快速上下滑会误冒 date pill 闪烁。用 item.boundary==='oldest' 区分这两种 prev==null。
 *
 * @param prevMs           窗口内前一条（更老邻居）msg 的 createdAtMs；无则 null。
 * @param curMs            当前 msg 的 createdAtMs。
 * @param isOldestBoundary 当前 msg 是否带全局 oldest 边界标记（item.boundary==='oldest'）。
 */
export function shouldShowDateSeparator(
  prevMs: number | null,
  curMs: number,
  isOldestBoundary: boolean,
): boolean {
  if (prevMs === null) return isOldestBoundary;
  return !sameDay(prevMs, curMs);
}
