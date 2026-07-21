import type { ConsoleEntry } from '../../services/log-buffer';

/**
 * Pure, Tauri-free merge utilities for the debug log panel. Kept in their own module (no Angular) so a
 * zoneless spec can exercise the timestamp parse + interleave without booting the DI graph.
 *
 * Three sources, two shapes:
 *  - **JS** — structured `ConsoleEntry` from the in-memory ring buffer (`fromJsEntry`); no parsing.
 *  - **Kotlin** — `native.log` text lines WE author, format `${ISO_UTC} [${level}] [${sub}] ${msg}`
 *    (matches the JS ring buffer's `new Date().toISOString()`, so the two interleave exactly).
 *  - **Rust** — `SOMS.log` text lines from `tauri-plugin-log`; format is the plugin's default formatter
 *    (a leading bracketed `[date][time]…`). Parsed best-effort — when the timestamp or level can't be
 *    extracted the line keeps its raw text and sorts to the end (see {@link mergeByTs}).
 */

export type LogSource = 'js' | 'rust' | 'kotlin';
export type LogLevel = 'error' | 'warn' | 'info' | 'log' | 'debug';

export interface MergedLine {
  /** Epoch ms for ordering, or `null` when no timestamp could be parsed (sorts after parseable lines). */
  readonly ts: number | null;
  /** Original timestamp text for display (empty when none). */
  readonly rawTs: string;
  readonly level: LogLevel;
  readonly source: LogSource;
  /** Best-effort message; falls back to the trimmed raw line when extraction fails. */
  readonly text: string;
  /** Full original line, for copy/export fidelity. */
  readonly raw: string;
}

const LEVEL_WORDS: Record<string, LogLevel> = {
  error: 'error', err: 'error',
  warn: 'warn', warning: 'warn',
  info: 'info',
  log: 'log',
  debug: 'debug', trace: 'debug', verbose: 'debug',
};

/** ISO-8601 with optional fractional seconds + optional zone, OR a leading bracketed `[date][time]`
 *  (the `tauri-plugin-log` file format). Captures group 1 = the timestamp token(s). */
const ISO_RE = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;
const BRACKET_RE = /^\[(\d{4}-\d{2}-\d{2})\]\[(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]/;

/** Try to peel a leading timestamp off `line`. Bracketed times carry no zone — assume UTC so they line up
 *  with the UTC ISO stamps JS + Kotlin emit (see the module note on the Rust-local-time caveat). */
function extractTs(line: string): { ms: number | null; raw: string; rest: string } {
  let m = ISO_RE.exec(line);
  if (m) {
    const raw = m[1];
    const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`;
    const ms = Date.parse(withZone);
    return { ms: Number.isNaN(ms) ? null : ms, raw, rest: line.slice(raw.length) };
  }
  m = BRACKET_RE.exec(line);
  if (m) {
    const ms = Date.parse(`${m[1]}T${m[2]}Z`);
    return { ms: Number.isNaN(ms) ? null : ms, raw: `${m[1]} ${m[2]}`, rest: line.slice(m[0].length) };
  }
  return { ms: null, raw: '', rest: line };
}

/** Find a level token in the post-timestamp remainder. Kotlin puts it first (`[info] [Rt] msg`); Rust buries
 *  it mid-prefix (`…[TARGET][INFO] msg`). Defaults to `info` so an unrecognised line still renders. */
function extractLevel(rest: string): { level: LogLevel; text: string } {
  const trimmed = rest.replace(/^[\s:]+/, '');
  const lead = /^\[?([A-Za-z]+)\]?[\s:\]]+/.exec(trimmed);
  if (lead) {
    const lvl = LEVEL_WORDS[lead[1].toLowerCase()];
    if (lvl) return { level: lvl, text: trimmed.slice(lead[0].length).replace(/^[\s:]+/, '') };
  }
  const bracket = /\[(ERROR|WARNING|WARN|INFO|DEBUG|TRACE|LOG)\]/i.exec(trimmed.slice(0, 80));
  if (bracket) {
    const lvl = LEVEL_WORDS[bracket[1].toLowerCase()];
    if (lvl) return { level: lvl, text: trimmed };
  }
  return { level: 'info', text: trimmed };
}

/** Adapt a structured JS ring-buffer entry (already typed — no text parsing). */
export function fromJsEntry(e: ConsoleEntry): MergedLine {
  const ms = Date.parse(e.ts);
  return { ts: Number.isNaN(ms) ? null : ms, rawTs: e.ts, level: e.level, source: 'js', text: e.text, raw: `${e.ts} [${e.level}] ${e.text}` };
}

/** Parse one native (Rust or Kotlin) text line into a {@link MergedLine}. */
export function parseNativeLine(line: string, source: 'rust' | 'kotlin'): MergedLine {
  const lineTrim = line.replace(/\r$/, '');
  if (lineTrim === '') return { ts: null, rawTs: '', level: 'info', source, text: '', raw: lineTrim };
  const { ms, raw, rest } = extractTs(lineTrim);
  const { level, text } = extractLevel(rest);
  return { ts: ms, rawTs: raw, level, source, text: text || lineTrim, raw: lineTrim };
}

/**
 * Interleave by timestamp. Parseable lines sort ascending; ties keep input order (Array.sort is stable, so
 * sources passed already time-ordered stay coherent). `ts === null` lines sort LAST in input order — their
 * position in the timeline is unknown, so they're gathered at the end rather than scattered.
 */
export function mergeByTs(lines: readonly MergedLine[]): MergedLine[] {
  return [...lines].sort((a, b) => {
    if (a.ts === null && b.ts === null) return 0;
    if (a.ts === null) return 1;
    if (b.ts === null) return -1;
    return a.ts - b.ts;
  });
}

/** Split a tail blob into individual lines (trimming a single trailing newline so it doesn't yield an empty
 *  final line). */
export function splitLines(blob: string): string[] {
  if (!blob) return [];
  const trimmed = blob.replace(/\n+$/, '');
  return trimmed === '' ? [] : trimmed.split('\n');
}
