import type { SupportedLocale } from '../common/locale.js';

/**
 * Server-side notification copy — the single source of truth for the localized title + body of the
 * coalesced "away" message summary. This is the FIRST localized string the backend renders (every other
 * user-facing string is a numeric {@link BusinessCode} the client localizes); the three notification
 * renderers (Web Push SW, Android Kotlin, foreground Angular) used to each carry their own copy +
 * folding logic and had already diverged (the SW showed a count, Kotlin omitted it). Centralizing here
 * makes one template + one fold rule the truth.
 *
 * Locale is negotiated per request in {@link pickLocale} (Accept-Language, stateless). Add a locale by
 * extending {@link TEMPLATES} + {@link SUPPORTED_LOCALES}.
 */

/** One thread's contribution to the away-summary body — the folded display name + its unread tally. */
export interface SummaryItem {
  /** Alias-aware display name (peer nickname for P2P, group name for GROUP). */
  displayName: string;
  /** Unread messages in this thread (the away surface counts only unread). */
  unreadCount: number;
}

/** The maximum number of distinct sender names spelled out in the body; the rest fold into a "+N" tail.
 *  Keeps the shade tidy (2 names + a count is the universal chat-app convention). */
const NAME_CAP = 2;

/** Template key → the localized format string. `{{name}}`/`{{a}}`/`{{b}}` = senders, `{{count}}` = total
 *  unread messages, `{{extra}}` = senders beyond {@link NAME_CAP}. */
type TemplateMap = {
  /** One sender, exactly one unread message. */
  one: string;
  /** One sender, multiple unread messages. */
  many: string;
  /** Two distinct senders. */
  two: string;
  /** Three or more distinct senders (names {@link NAME_CAP}, the rest folded into {{extra}}). */
  manyConv: string;
};

const TEMPLATES: Record<SupportedLocale, TemplateMap> = {
  'en': {
    one: '{{name}} sent you a message',
    many: '{{name}} sent you {{count}} messages',
    two: '{{a}}, {{b}} sent you {{count}} messages',
    manyConv: '{{a}}, {{b}} +{{extra}} sent you {{count}} messages',
  },
  'zh-CN': {
    one: '{{name}} 给你发了 1 条消息',
    many: '{{name}} 给你发了 {{count}} 条消息',
    two: '{{a}}、{{b}} 给你发了 {{count}} 条消息',
    manyConv: '{{a}}、{{b}} 等 {{extra}} 人给你发了 {{count}} 条消息',
  },
};

/** Interpolate `{{key}}` tokens in a template string. Unknown tokens are left intact (defensive). */
function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, key: string) =>
    key in vars ? String(vars[key]) : m,
  );
}

/** Distinct non-empty display names, order-preserving (the first-seen order = the folded name order). */
function distinctNames(items: SummaryItem[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const n = (it.displayName ?? '').trim();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Build the coalesced away-summary body from the unread threads. Folding rules:
 *  - senders = distinct non-empty displayNames, capped at {@link NAME_CAP} (the rest folded into +N);
 *  - count = the total unread messages across all of them (NOT the thread count);
 *  - template chosen by sender count (1 / 2 / 3+) and, for a lone sender, the 1-vs-many plural.
 *
 * Returns the empty string only when there is nothing to summarize (no unread items) — the caller turns
 * that into a `kind:'clear'` descriptor (cancel the prior notification) rather than posting an empty body.
 */
export function buildSummaryBody(items: SummaryItem[], locale: SupportedLocale): string {
  const total = items.reduce((sum, it) => sum + (it.unreadCount > 0 ? it.unreadCount : 0), 0);
  if (total <= 0) return '';
  const t = TEMPLATES[locale] ?? TEMPLATES['en'];
  const names = distinctNames(items);
  if (names.length === 0) return fill(t.many, { name: '', count: total });
  if (names.length === 1) {
    return total === 1
      ? fill(t.one, { name: names[0] })
      : fill(t.many, { name: names[0], count: total });
  }
  if (names.length === 2) {
    return fill(t.two, { a: names[0], b: names[1], count: total });
  }
  return fill(t.manyConv, {
    a: names[0],
    b: names[1],
    extra: names.length - NAME_CAP,
    count: total,
  });
}

/** The notification title — the app name (locale-stable for now; the shade shows it above the body). */
export function buildSummaryTitle(locale: SupportedLocale): string {
  // Single source for the title text; both locales use the product name. Localize here if it ever differs.
  void locale;
  return 'SOMS';
}

/** Localized labels for the notification action buttons, by action id. The server localizes (the client
 *  renders verbatim) so a button's text is consistent with the body's locale. Add an id here when a new
 *  action is introduced. */
const ACTION_LABELS: Record<SupportedLocale, Record<string, string>> = {
  'en': {
    'mark-all-read': 'Mark all read',
    reply: 'Reply',
    mute: 'Mute',
  },
  'zh-CN': {
    'mark-all-read': '全部标为已读',
    reply: '回复',
    mute: '静音',
  },
};

/** The localized label for an action `id` in `locale` (falls back to en, then the raw id). */
export function actionLabel(id: string, locale: SupportedLocale): string {
  return (ACTION_LABELS[locale] ?? ACTION_LABELS['en'])[id] ?? id;
}
