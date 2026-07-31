import { Injectable } from '@angular/core';
import {
  DefaultTranspiler,
  getValue,
  setValue,
  TranspileParams,
} from '@jsverse/transloco';

/**
 * CSP-safe Transloco transpiler that resolves the ICU MessageFormat *argument*
 * subset SOMS uses (`{var, plural, …}` / `{var, select, …}`) WITHOUT runtime
 * `eval`/`new Function`.
 *
 * Why this exists: `@jsverse/transloco-messageformat` delegates to
 * `@messageformat/core`, whose `compile()` builds each message into a function
 * via `new Function(...)`. That requires `'unsafe-eval'` in the CSP. The bundled
 * Tauri build enforces `script-src 'self' …` with no `'unsafe-eval'`, so every
 * translation threw `EvalError` at boot and no localized text rendered (the dev
 * server worked only because it serves no such CSP). Adding `'unsafe-eval'` is a
 * real XSS relaxation and is rejected here; instead the plural category is taken
 * from the platform built-in `Intl.PluralRules` (no eval), the recognized
 * CSP-safe way to pluralize.
 *
 * Behavior mirrors `MessageFormatTranspiler`: it first delegates to
 * `DefaultTranspiler.transpile` (so ordinary `{{param}}` interpolation and the
 * object/array param shapes still work), then resolves any ICU arguments in the
 * result via {@link resolveIcu}. The five ICU strings currently in the app —
 * `group.members`, `chat.mediaCount.{image,video,audio}` —
 * all resolve correctly; any unsupported ICU construct is left untouched.
 */
@Injectable()
export class CspSafeIcuTranspiler extends DefaultTranspiler {
  /** Active UI language, captured from {@link onLangChanged} for `Intl.PluralRules`. */
  private lang = 'en';

  override transpile({ value, params = {}, translation, key }: TranspileParams): unknown {
    if (!value) {
      return value;
    }

    // Object-valued translation with params: resolve each keyed sub-message
    // (the nested-param shape DefaultTranspiler supports), applying ICU per key.
    if (value !== null && typeof value === 'object' && params) {
      const target = value as Record<string, unknown>;
      for (const p of Object.keys(params)) {
        const transpiled = super.transpile({
          value: getValue(target, p),
          params: getValue(params, p) as Record<string, unknown>,
          translation,
          key,
        }) as string;
        target[p] = resolveIcu(transpiled, params[p], this.lang);
      }
      return target;
    }

    // Array values are passed through unchanged (no string interpolation).
    if (Array.isArray(value)) {
      return value;
    }

    // Scalar string: default `{{param}}` interpolation first, then ICU args.
    const transpiled = super.transpile({ value, params, translation, key }) as string;
    return resolveIcu(transpiled, params, this.lang);
  }

  /** Track the active language so plural-category selection is locale-correct. */
  onLangChanged(lang: string): void {
    this.lang = lang;
  }
}

/**
 * Resolve ICU MessageFormat *argument* spans in `message` against `params`.
 *
 * An argument has the shape `{ name , plural|select , BODY }` where BODY is a
 * sequence of branch groups `selector { branch }`. `selector` is `=N` (an exact
 * match for value N), a CLDR plural keyword (zero/one/two/few/many/other), or —
 * for `select` — any literal key. Inside a `plural` branch, `#` is replaced by
 * the numeric value. Nested arguments are resolved inside-out. Spans that are
 * not valid ICU arguments (e.g. leftover `{`/`}`) are emitted verbatim.
 *
 * `lang` selects the CLDR plural category via `Intl.PluralRules` (no eval).
 */
function resolveIcu(message: string, params: unknown, lang: string): string {
  const paramMap = (params && typeof params === 'object'
    ? (params as Record<string, unknown>)
    : {});
  return resolveSpans(message, paramMap, lang);
}

/** Recursive span scanner (handles nesting by reducing inside-out). */
function resolveSpans(message: string, params: Record<string, unknown>, lang: string): string {
  let out = '';
  let i = 0;
  while (i < message.length) {
    if (message[i] === '{') {
      const end = findMatchingBrace(message, i);
      if (end === -1) {
        return out + message.slice(i); // unbalanced — emit the remainder verbatim
      }
      const inner = message.slice(i + 1, end);
      const resolved = resolveArgument(inner, params, lang);
      out += resolved ?? `{${inner}}`; // not an ICU argument → keep as-is
      i = end + 1;
    } else {
      out += message[i];
      i += 1;
    }
  }
  return out;
}

/** Try to interpret `inner` (text between the outer braces) as an ICU argument. */
function resolveArgument(inner: string, params: Record<string, unknown>, lang: string): string | null {
  const parts = splitTopLevel(inner, ',');
  if (parts.length < 3) return null;
  const name = parts[0].trim();
  const kind = parts[1].trim();
  const body = parts.slice(2).join(',').trim();
  if (!name || (kind !== 'plural' && kind !== 'select')) return null;

  const branches = parseBranches(body);
  const value = params[name];

  if (kind === 'plural') {
    const n = Number(value);
    const numeric = Number.isFinite(n) ? String(n) : '';
    // Exact `=N` wins, then the locale's CLDR category, then `other`.
    const chosen =
      (numeric !== '' && branches.get(`=${numeric}`)) ||
      branches.get(pluralCategory(n, lang)) ||
      branches.get('other') ||
      '';
    // `#` is the count placeholder; then resolve any nested args.
    return resolveSpans(chosen.replace(/#/g, numeric), params, lang);
  }

  // select: branch key matches the stringified value, else `other`.
  const chosen = branches.get(String(value)) || branches.get('other') || '';
  return resolveSpans(chosen, params, lang);
}

/**
 * CLDR plural category for `n` in `lang`. `Intl.PluralRules` is a platform
 * built-in — it performs NO code generation, so it is safe under a CSP that
 * omits `'unsafe-eval'`. Falls back to English binary rules on a bad locale.
 */
function pluralCategory(n: number, lang: string): string {
  try {
    return new Intl.PluralRules(lang).select(n);
  } catch {
    return n === 1 ? 'one' : 'other';
  }
}

/** Index of the `}` matching the `{` at `open`, accounting for nesting. -1 if unbalanced. */
function findMatchingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on `sep` only at brace-depth 0 (so commas/semicolons inside branches are kept). */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Parse a BODY like `=1 {# Photo} other {# Photos}` into selector → branch text.
 * Branch text keeps nested braces for downstream recursive resolution.
 */
function parseBranches(body: string): Map<string, string> {
  const map = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;
    // Selector token: `=N`, or a bare word keyword / select key.
    let selector = '';
    while (i < body.length && !/\s/.test(body[i])) selector += body[i++];
    while (i < body.length && /\s/.test(body[i])) i++;
    if (body[i] !== '{') break;
    const end = findMatchingBrace(body, i);
    if (end === -1) break;
    map.set(selector, body.slice(i + 1, end));
    i = end + 1;
  }
  return map;
}
