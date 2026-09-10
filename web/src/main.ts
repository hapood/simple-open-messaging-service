import { runAsActivePage } from './app/services/active-page';
import { installKeyboardInsetBridge } from './app/services/keyboard-inset.service';
import { installConsoleBuffer } from './app/services/log-buffer';
import {
  applySafeInsets,
  installActiveOriginBridge,
  isTauri,
} from './app/services/runtime';

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
    if (
      reason &&
      typeof reason === 'object' &&
      (reason as { name?: string }).name === 'HttpErrorResponse'
    ) {
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

// Capture the webview console into a ring buffer FIRST (before anything logs), so the diagnostic bundle
// (Settings → Report → Rust report_diagnostics) carries a PURE JS slice, and the debug log panel has the
// JS leg of its 3-layer view. Idempotent + no-op if unavailable. Rust logs are no longer mirrored into the
// console here — the bundle carries them full-fidelity in `rust/SOMS.log` and the panel tails them via
// `read_native_log`, so re-emitting would only double-capture (and pollute the JS console at JS levels).
installConsoleBuffer();
// Wire the global error net so it captures anything the setup below throws or rejects.
installGlobalErrorReporting();

// Apply native system-bar insets (Android WebView: status-bar height from the Kotlin SomsShell bridge)
// to :root BEFORE bootstrap, so the first paint already has --soms-safe-top (FOUC-free). No-op in the
// browser build (no SomsShell → the CSS default env() applies there).
applySafeInsets();

// Install the native→JS keyboard-inset push (Android WebView) before bootstrap so the first native frame
// is never missed. No-op in the browser build (the global is installed but never called there).
installKeyboardInsetBridge();

// Install the native→JS active-origin push (Android WebView) before bootstrap, so Kotlin's origin decisions
// for the /events stream reach the Rust set_active_origin command from the very first one (Android is
// Kotlin-authoritative; Rust follows). No-op in the browser/desktop build.
installActiveOriginBridge();

// The native launch overlay is already visible at this point. Session restoration is an APP_INITIALIZER,
// so label that otherwise quiet wait before Angular constructs AppComponent. No-op outside Android.
window.SomsShell?.setSplashStage?.('session');

async function startApplication(): Promise<void> {
  // Do not evaluate account services or open their databases in a waiting page.
  const [{ bootstrapApplication }, { appConfig }, { AppComponent }] =
    await Promise.all([
      import('@angular/platform-browser'),
      import('./app/app.config'),
      import('./app/app.component'),
    ]);
  await bootstrapApplication(AppComponent, appConfig);
}

void (isTauri() ? startApplication() : runAsActivePage(startApplication)).catch(
  (err) => console.error(err),
);
