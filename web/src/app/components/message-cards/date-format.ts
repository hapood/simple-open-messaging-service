import dayjs from 'dayjs';

/**
 * Frontend derivation of date-separator labels and conversation-list timestamps.
 *
 * A date is no longer a CbItem carried by the source (it never returns one and never occupies an abstract id);
 * instead it is a derived view computed at mount time by the createItem factory, which compares the current
 * message against its older in-window neighbor (`prev`) and inserts a date pill above when the day changes.
 *
 * One decision covers all three origins (prev is always the older in-window neighbor passed in by the kernel):
 *  ① consecutive mount within a batch: prev = the previous item in the same batch;
 *  ② batch-boundary mount:             prev = the last item of the previous batch;
 *  ③ oldest:                           prev = null (the global oldest, no older neighbor).
 *
 * Locale awareness: weekday and month/day names come from dayjs once the global locale is switched by
 * LanguageService. "Today" / "Yesterday" have no dayjs format token (without the relativeTime plugin), so
 * they are read from the translation dictionary via the `translate` argument. Callers re-evaluate on a
 * language switch by reading the language signal in their `computed`/template context.
 */

/** Minimal slice of TranslocoService the formatters need — keeps them pure and unit-testable. */
export interface DateTranslator {
  translate(key: string): string;
}

/** Whether two instants fall on the same calendar day (cross-year same month/day is still a different day). */
export function sameDay(a: number, b: number): boolean {
  return dayjs(a).isSame(b, 'day');
}

/**
 * Date-separator pill label: Today / Yesterday / weekday name / MMM D / MMM D, YYYY.
 * Used by DateRowComponent (which owns the language-reactive computation).
 */
export function formatDateSeparator(ms: number, t: DateTranslator): string {
  const d = dayjs(ms);
  const now = dayjs();
  if (d.isSame(now, 'day')) return t.translate('date.today');
  if (d.isSame(now.subtract(1, 'day'), 'day')) return t.translate('date.yesterday');
  if (d.isAfter(now.subtract(7, 'day'))) return d.format('dddd');
  if (d.isSame(now, 'year')) return d.format('MMM D');
  return d.format('MMM D, YYYY');
}

/**
 * Conversation-list timestamp: HH:mm for today, weekday for this week, MMM D same year, MMM D, YYYY otherwise.
 * Mirrors the date-separator vocabulary so the list and the chat share one mental model.
 */
export function formatListTime(ms: number | null | undefined, t: DateTranslator): string {
  if (ms === null || ms === undefined) return '';
  const d = dayjs(ms);
  const now = dayjs();
  if (d.isSame(now, 'day')) return d.format('HH:mm');
  if (d.isSame(now.subtract(1, 'day'), 'day')) return t.translate('date.yesterday');
  if (d.isAfter(now.subtract(7, 'day'))) return d.format('dddd');
  if (d.isSame(now, 'year')) return d.format('MMM D');
  return d.format('MMM D, YYYY');
}

/**
 * Whether a date separator should appear above the current message.
 *
 *  - prev exists and same day → no (consecutive within a group).
 *  - prev exists and day changed → yes.
 *  - prev == null and isOldestBoundary → yes (a fixed date above the conversation's true first message).
 *  - prev == null and NOT oldest → **no**. Key point: after a mid-window trim re-mounts this row, the prev
 *    neighbor has been reclaimed by the kernel (unmountOne also deletes it from items) → prev == null, but
 *    this is not the oldest; showing a date here would make date pills flicker during fast up/down scrolling.
 *    Distinguish the two prev == null cases via item.boundary === 'oldest'.
 *
 * @param prevMs           createdAtMs of the older in-window neighbor; null if none.
 * @param curMs            createdAtMs of the current message.
 * @param isOldestBoundary whether the current message carries the global-oldest boundary marker.
 */
export function shouldShowDateSeparator(
  prevMs: number | null,
  curMs: number,
  isOldestBoundary: boolean,
): boolean {
  if (prevMs === null) return isOldestBoundary;
  return !sameDay(prevMs, curMs);
}
