/**
 * A capped ring buffer of the webview's `console.*` output — the JS layer's durable sink.
 *
 * Two consumers:
 *  - **Diagnostic bundle** (Settings → Report → Rust `report_diagnostics`): the in-memory ring is mirrored
 *    to a DURABLE file `app_log_dir/webview-console.log` via the Rust `log_js` command (throttled +
 *    batched), and `report_diagnostics` tars THAT file — not a string passed from JS. So a report, even
 *    right after a crash/relaunch when this in-memory ring is empty, still carries the pre-crash JS trail.
 *  - **Debug log panel**: `getConsoleEntries()` for the live JS leg of the merged 3-layer view.
 *
 * Installed FIRST in main.ts (before bootstrap) so it captures from the earliest moment. Module-level (not
 * an Angular service) deliberately: it must be installable before DI exists, and the bundle path reads it
 * outside Angular's request scope. `installConsoleBuffer()` is idempotent. Dependency-free by design (no
 * Angular/runtime imports) so it can load first without risking an import-order TDZ; the Tauri bridge is
 * read inline from `window.__TAURI__`, and every `log_js` failure is swallowed SILENTLY — a `console.error`
 * on failure would recurse (error → capture → flush → fail → error → …).
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
let installed = false;
/** Release builds retain only failures until the hidden debug gesture is enabled. This keeps the normal
 * hot path cheap while preserving a small post-mortem signal. Dev builds and DebugToolsService switch
 * this on during bootstrap; switching is immediate and does not require a reload. */
let fullLogging = false;

export function setFullConsoleLogging(enabled: boolean): void {
  fullLogging = enabled;
}

/** Runtime gate shared by chatty diagnostics that should also follow the hidden production toggle. */
export function isFullConsoleLoggingEnabled(): boolean {
  return fullLogging;
}

// --- durable mirror (Rust app_log_dir/webview-console.log via the `log_js` IPC) -----------------
// Rendered lines not yet flushed to Rust. Flushed on a throttle (count OR interval), on `pagehide`, on
// `clearConsoleBuffer` (as a truncate), and on explicit `flushConsoleBuffer()` (awaited before a report).
const pending: string[] = [];
/** Flush once this many unflushed lines accumulate (immediate flush, no timer wait). */
const FLUSH_COUNT = 20;
/** Otherwise flush at most this often (a pending timer coalesces a burst into one IPC). */
const FLUSH_MS = 1000;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Serializes flushes onto one chain so at most one `log_js` IPC is ever in flight, and a caller that
 *  awaits `flushPending()` (e.g. `flushConsoleBuffer` before a report) resolves only after the entries
 *  buffered at call time are on disk — including any a prior link was still writing. */
let flushChain: Promise<void> = Promise.resolve();

/** Render one entry the same way for the durable file, the in-memory dump, and the panel. */
function renderEntry(e: ConsoleEntry): string {
  return `${e.ts} [${e.level}] ${e.text}`;
}

/** The raw Tauri `invoke` if running under the Tauri shell, else `null` (browser/PWA — no Rust mirror,
 *  and diagnostics is Tauri-only anyway). Read inline so this module stays dependency-free. */
function tauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  if (typeof window === 'undefined') return null;
  const invoke = (window as unknown as {
    __TAURI__?: { core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
  }).__TAURI__?.core?.invoke;
  return typeof invoke === 'function' ? invoke : null;
}

/** One `log_js` round-trip. Never rejects: a mirror failure is swallowed (see file header — no recursion). */
function invokeLogJs(lines: string[], clear: boolean): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) return Promise.resolve();
  try {
    return invoke('log_js', clear ? { lines, clear: true } : { lines }).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve(); // sync throw (bridge absent mid-call) — swallow.
  }
}

/** Drain `pending` into one `log_js` batch, chained after any in-flight flush. Returns a promise that
 *  resolves once this link's drain is done — so `flushConsoleBuffer()` (awaited before a report) waits for
 *  a currently-writing batch too, not just `pending`. JS is single-threaded: the chain serializes without
 *  a mutex, and entries captured between links land in the next link's `pending`. */
function flushPending(): Promise<void> {
  flushChain = flushChain
    .catch(() => undefined) // a prior link never breaks the chain (and invokeLogJs never rejects anyway)
    .then(async () => {
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      await invokeLogJs(batch, false); // swallowed inside — drop on persistent failure (bounded loss)
    });
  return flushChain;
}

function armTimer(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPending();
  }, FLUSH_MS);
}

/** Push strategy: cross the count threshold → flush now; otherwise coalesce on the interval timer. */
function scheduleOrFlush(): void {
  if (pending.length >= FLUSH_COUNT) {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    void flushPending();
  } else {
    armTimer();
  }
}

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
 * implementation, so devtools behavior is unchanged) AND mirrored to the durable file. Idempotent — safe
 * to call more than once.
 */
export function installConsoleBuffer(): void {
  if (installed) return;
  installed = true;
  for (const level of LEVELS) {
    const orig = console[level];
    // Huawei's Android WebView exposes console methods through a Java bridge. Function.bind() turns that
    // method into a wrapper the bridge rejects as a "non-injected object", so preserve the original
    // function and provide its real receiver at call time instead.
    const capture = (...args: unknown[]): void => {
      try {
        if (!fullLogging && level !== 'error') {
          Reflect.apply(orig, console, args);
          return;
        }
        const entry: ConsoleEntry = {
          ts: new Date().toISOString(),
          level,
          text: args.map(stringify).join(' '),
        };
        buffer.push(entry);
        if (buffer.length > CAPACITY) buffer.splice(0, buffer.length - CAPACITY);
        pending.push(renderEntry(entry));
        scheduleOrFlush();
      } catch {
        // A capture failure must never break the actual log — swallow.
      }
      Reflect.apply(orig, console, args);
    };
    console[level] = capture as (typeof console)[Level];
  }
  // Best-effort final flush on tab hide / app backgrounding so the durable file isn't missing the last
  // ≤ FLUSH_MS of activity. The IPC may not finish before unload; that's acceptable for diagnostics.
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      void flushPending();
    });
  }
}

/**
 * Force every buffered entry to the durable file. Awaited by the diagnostics Report action right before
 * it invokes `report_diagnostics`, so the bundle (which Rust builds from the file) carries everything
 * captured up to the click — the throttle would otherwise hold back the last ≤ FLUSH_MS.
 */
export async function flushConsoleBuffer(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushPending();
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
 * Drop every captured entry AND wipe the durable mirror. Used by the debug panel's "clear" action so a
 * fresh trace starts empty without reloading. The durable file is truncated too (fire-and-forget) so a
 * subsequent report reflects the cleared trace — the file is the bundle's source, so the live view and the
 * report must clear together. No effect on the real `console.*` (still installed + forwarding).
 */
export function clearConsoleBuffer(): void {
  buffer.length = 0;
  pending.length = 0;
  void invokeLogJs([], true);
}
