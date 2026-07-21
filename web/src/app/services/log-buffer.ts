/**
 * A capped ring buffer of the webview's `console.*` output — the JS layer's durable sink.
 *
 * Two consumers:
 *  - **Diagnostic bundle** (Settings → Report → Rust `report_diagnostics`): `dumpConsoleBuffer()` renders
 *    this buffer as `webview-console.log`, a PURE JS slice. Rust logs are NOT mirrored here anymore (the
 *    `attachRustConsole` console re-emission was removed); the bundle carries Rust full-fidelity in
 *    `rust/SOMS.log` and Kotlin in `native/kotlin.log`, so the three bundle artifacts are non-overlapping.
 *  - **Debug log panel**: `getConsoleEntries()` for the live JS leg of the merged 3-layer view.
 *
 * Installed FIRST in main.ts (before bootstrap) so it captures from the earliest moment. Module-level (not
 * an Angular service) deliberately: it must be installable before DI exists, and the bundle path reads it
 * outside Angular's request scope. `installConsoleBuffer()` is idempotent.
 */
export interface ConsoleEntry {
  /** ISO timestamp (the entry's order is also the array order; the ts is for the log line). */
  readonly ts: string;
  readonly level: 'log' | 'debug' | 'info' | 'warn' | 'error';
  readonly text: string;
}

const CAPACITY = 2000;
const LEVELS = ['log', 'debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

const buffer: ConsoleEntry[] = [];
const originals = new Map<Level, (...args: unknown[]) => void>();
let installed = false;

/** Best-effort stringify of one console argument (Errors keep their stack; circular objects don't throw). */
function stringify(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/**
 * Wrap every `console.<level>` so each call is appended to the ring buffer (then forwarded to the real
 * implementation, so devtools behavior is unchanged). Idempotent — safe to call more than once.
 */
export function installConsoleBuffer(): void {
  if (installed) return;
  installed = true;
  for (const level of LEVELS) {
    const orig = console[level].bind(console);
    originals.set(level, orig);
    // Arrow (not reassigning `console[level]` as a method) so `this`/receiver stay correct.
    const capture = (...args: unknown[]): void => {
      try {
        buffer.push({ ts: new Date().toISOString(), level, text: args.map(stringify).join(' ') });
        if (buffer.length > CAPACITY) buffer.splice(0, buffer.length - CAPACITY);
      } catch {
        // A capture failure must never break the actual log — swallow.
      }
      orig(...args);
    };
    console[level] = capture as (typeof console)[Level];
  }
}

/**
 * Render the captured buffer as a single text blob (one line per entry, newest last) for the
 * `webview-console.log` entry of the diagnostic bundle. Returns what was captured up to this call.
 */
export function dumpConsoleBuffer(): string {
  return buffer.map((e) => `${e.ts} [${e.level}] ${e.text}`).join('\n');
}

/**
 * Read-only view of the live buffer for the debug log panel's JS leg. Returns the underlying array by
 * reference (typed readonly); callers that need a stable snapshot across an await should clone it
 * (`[...]`) — the buffer is mutated on the main thread by future `console.*` calls (append + splice from
 * the front when over capacity).
 */
export function getConsoleEntries(): readonly ConsoleEntry[] {
  return buffer;
}

/**
 * Drop every captured entry. Used by the debug panel's "clear" action so a fresh trace starts empty
 * without reloading. No effect on the real `console.*` (still installed + forwarding).
 */
export function clearConsoleBuffer(): void {
  buffer.length = 0;
}
