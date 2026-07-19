import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';
import { installKeyboardInsetBridge } from './app/services/keyboard-inset.service';
import { installConsoleBuffer } from './app/services/log-buffer';
import { applySafeInsets, isTauri, listenEvent } from './app/services/runtime';

/**
 * Install window-level listeners that surface errors no local handler caught into the webview console —
 * the third surface of the three-way split that gives every uncaught failure a visible home:
 *  - HTTP request failures   → `httpTraceInterceptor` (the `[http]` family: method + url + status).
 *  - Angular-managed throws → `GlobalErrorHandler`    (the `[angular]` family).
 *  - everything else here    → `[unhandled]`           (raw promise rejections + errors in non-Angular
 *    contexts: native bridges, free event listeners, setTimeout, eval).
 *
 * Installed as early as possible so it captures failures during the bootstrap setup below.
 * `HttpErrorResponse` is skipped on the promise channel — the interceptor already logged it with more
 * context, so this avoids a lower-fidelity duplicate. Angular-consumed errors do NOT re-fire
 * `window.onerror`, so there is no overlap with `GlobalErrorHandler` either; the three are disjoint.
 */
function installGlobalErrorReporting(): void {
  if (typeof window === 'undefined') return;
  // Raw unhandled promise rejections — NOT routed to Angular's ErrorHandler. Catches a stray rejection
  // from a fire-and-forget promise (e.g. a `void tauriInvoke(...)` whose rejection a caller never
  // awaited), which would otherwise leak as Chrome's opaque `Uncaught (in promise) ... <page>:1`.
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    // HTTP failures are owned by httpTraceInterceptor (logged with method + url + status); skip the
    // duplicate. An HttpErrorResponse carries `.name === 'HttpErrorResponse'`.
    if (reason && typeof reason === 'object' && (reason as { name?: string }).name === 'HttpErrorResponse') {
      return;
    }
    console.error('[unhandled] promise rejection:', reason);
  });
  // Script errors Angular's ErrorHandler did not consume (raw/native/free-listener contexts). Resource-
  // load failures (img/script 404) also fire here with NO `event.error` (only `event.target`); skip those
  // — the failing element reports them, and logging every missing asset would drown the signal.
  window.addEventListener('error', (event) => {
    if (event.error) console.error('[unhandled] window error:', event.error);
  });
}

/**
 * Under the Tauri shell, attach a listener that re-emits every Rust-side log into the webview console,
 * dispatched by level — so Rust-side failures (SSE connect errors, upstream proxy failures, panics) land
 * in the SAME console the JS errors do (visible via edge://inspect / `adb logcat`). This replicates
 * `@tauri-apps/plugin-log`'s `attachConsole()` WITHOUT pulling that npm package in — it rides the raw
 * `window.__TAURI__.event.listen` surface via the existing `listenEvent` wrapper, keeping the browser
 * build free of @tauri-apps deps (the whole reason runtime.ts avoids them).
 *
 * The Rust `tauri-plugin-log` Webview target emits each record on the `log://log` event as
 * `{ level: 1..5, message }` (1=Trace … 5=Error); `message` may carry ANSI color codes the file/stdout
 * sinks use, so they're stripped here (mirroring the upstream plugin). No-op outside the shell. Fired
 * before bootstrap; the SSE supervisor starts during app construction (before this attaches), so its
 * very first logs may be missed — later reconnects and all proxy failures are captured.
 */
async function attachRustConsole(): Promise<void> {
  if (!isTauri()) return;
  await listenEvent<{ level: number; message: string }>('log://log', (e) => {
    // Rust log levels (tauri-plugin-log): Trace=1, Debug=2, Info=3, Warn=4, Error=5. Unknown → error
    // (safest — never silently drop a record).
    const fn: 'log' | 'debug' | 'info' | 'warn' | 'error' =
      e.payload.level === 1 ? 'log'
        : e.payload.level === 2 ? 'debug'
        : e.payload.level === 3 ? 'info'
        : e.payload.level === 4 ? 'warn'
        : 'error';
    // Strip ANSI escape codes the file/stdout sinks may have baked into the message.
    const msg = e.payload.message.replace(
      /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
      '',
    );
    console[fn](`[rust] ${msg}`);
  });
}

// Capture the webview console into a ring buffer FIRST (before anything logs), so the diagnostic bundle
// (Settings → Report → Rust report_diagnostics) carries a JS-side slice. Idempotent + no-op if unavailable.
installConsoleBuffer();
// Wire the global error net so it captures anything the setup below throws or rejects.
installGlobalErrorReporting();
// Then mirror Rust-side logs into this same console (SSE/proxy/panic failures) under Tauri.
attachRustConsole();

// Apply native system-bar insets (Android WebView: status-bar height from the Kotlin SomsShell bridge)
// to :root BEFORE bootstrap, so the first paint already has --soms-safe-top (FOUC-free). No-op in the
// browser build (no SomsShell → the CSS default env() applies there).
applySafeInsets();

// Install the native→JS keyboard-inset push (Android WebView) before bootstrap so the first native frame
// is never missed. No-op in the browser build (the global is installed but never called there).
installKeyboardInsetBridge();

bootstrapApplication(AppComponent, appConfig).catch((err) => console.error(err));
