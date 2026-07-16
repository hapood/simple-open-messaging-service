/**
 * Pure builder for the body of the single rolling "away messages" summary notification. Extracted from
 * {@link UnreadAttentionService} so it is unit-testable with an identity translate stub (mirrors
 * `biz-code.spec`): the suite asserts WHICH i18n key + interpolations are selected, not the bundle wording
 * (that is `en.json` / `zh-CN.json`'s job).
 */

/** One conversation's worth of "arrived while away" tally, accumulated across an away-session. */
export interface AwayEntry {
  /** Display name (alias-aware — {@link displayThreadName}). */
  name: string;
  /** Messages received from this conversation during the current away-session. */
  count: number;
}

/** Translate fn shape: `(key, params?) => string`. Decouples the helper from TranslocoService. */
export type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

/**
 * Build the summary body from the conversations that received messages during the current away-session
 * (NOT the cumulative `unreadCount` — only what arrived while the tab was unfocused, so the count is
 * exact even when the user left with prior unread). Variants by sender count:
 *   1 conversation, 1 msg   → `notif.one`
 *   1 conversation, >1 msg  → `notif.many`
 *   2 conversations         → `notif.two`
 *   3+ conversations        → `notif.manyConv` (names the first two + the conversation total `{{n}}`)
 *
 * Returns `null` when there is nothing to summarize (empty / non-positive total) — the caller then skips
 * posting entirely.
 */
export function buildAwayBody(entries: readonly AwayEntry[], t: TranslateFn): string | null {
  const total = entries.reduce((sum, e) => sum + e.count, 0);
  if (entries.length === 0 || total <= 0) return null;

  const names = entries.map((e) => e.name);

  if (entries.length === 1) {
    return total === 1
      ? t('notif.one', { name: names[0] })
      : t('notif.many', { name: names[0], count: total });
  }
  if (entries.length === 2) {
    return t('notif.two', { a: names[0], b: names[1], count: total });
  }
  return t('notif.manyConv', {
    a: names[0],
    b: names[1],
    n: entries.length, // total conversations (zh: "等 N 个会话"; en ignores the number)
    count: total,
  });
}
