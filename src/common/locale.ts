/**
 * HTTP `Accept-Language` negotiation — the single place the backend reads the caller's preferred locale.
 *
 * The backend has no other i18n surface today: business outcomes travel as numeric `BusinessCode` values
 * (translated client-side), and the one prior dotted-key convention (`ApiResult.messageKey`, set only by the
 * invite controller) is a CLIENT-side translation hint. This module is the first time the backend itself
 * localizes a rendered string — the notification descriptor's title/body — so it owns the locale pick.
 *
 * Stateless by design: the locale is negotiated per request from `Accept-Language` (the caller's runtime
 * language), never stored on the user. That keeps a single source (the device language the client already
 * knows) and avoids a `User.locale` column + a settings UI for a transient display string. The web SW and
 * Kotlin both send the device locale here (navigator.language / Locale.getDefault()); the foreground
 * Angular app sends its live Transloco language so an in-app language switch is honored.
 */

/** The locales the backend notification templates ship. Add a pair to {@link TEMPLATES} to extend. */
export const SUPPORTED_LOCALES = ['en', 'zh-CN'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Default locale when the header is absent or matches nothing — matches the project's UI-text-in-English
 *  baseline (consumer + playground text English; zh-CN/en JSON on the client). */
export const DEFAULT_LOCALE: SupportedLocale = 'en';

/** The maximum number of `Accept-Language` entries parsed (DoS cap — a real header has <10). */
const MAX_ENTRIES = 50;
/** Hard cap on the parsed header length (DoS cap). */
const MAX_HEADER_LEN = 2048;

/**
 * Parse an `Accept-Language` header into `{ tag, q }` entries, sorted by descending `q` (most-preferred
 * first), per RFC 9420 §11.5. Tags are lowercased + trimmed; the `q` weight defaults to 1 when absent.
 * Malformed entries are dropped. Null/empty input → `[]`.
 *
 * Pure + total: never throws; any garbage input degrades to `[]` (→ the default locale).
 */
export function parseAcceptLanguage(
  header: string | undefined | null,
): { tag: string; q: number }[] {
  if (!header) return [];
  const parts = header
    .slice(0, MAX_HEADER_LEN)
    .split(',', MAX_ENTRIES + 1)
    .slice(0, MAX_ENTRIES);
  const out: { tag: string; q: number }[] = [];
  for (const part of parts) {
    const segs = part.trim().split(';');
    const tag = segs[0]?.trim().toLowerCase();
    if (!tag) continue;
    let q = 1;
    for (let i = 1; i < segs.length; i++) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(segs[i]);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n)) q = n;
      }
    }
    out.push({ tag, q });
  }
  out.sort((a, b) => b.q - a.q || a.tag.localeCompare(b.tag));
  return out;
}

/**
 * Map a single (lowercased) language tag to a supported locale by prefix, or null if it maps to none.
 * `zh*` (zh, zh-cn, zh-tw, zh-hk, …) → `zh-CN`; `en*` → `en`. Prefix matching means `zh` (no region)
 * correctly resolves to the Chinese template. A tag that is neither → null (the caller keeps walking the
 * q-sorted list / falls back to the default).
 */
function tagToLocale(tag: string): SupportedLocale | null {
  if (tag.startsWith('zh')) return 'zh-CN';
  if (tag.startsWith('en')) return 'en';
  return null;
}

/**
 * Pick the best supported locale for an `Accept-Language` header: walk the q-sorted parsed entries and
 * return the first that maps to a supported locale; fall back to {@link DEFAULT_LOCALE} when none match.
 *
 * The single entry point the notification path calls (`pickLocale(req.headers['accept-language'])`).
 */
export function pickLocale(header: string | undefined | null): SupportedLocale {
  for (const { tag } of parseAcceptLanguage(header)) {
    const loc = tagToLocale(tag);
    if (loc) return loc;
  }
  return DEFAULT_LOCALE;
}
