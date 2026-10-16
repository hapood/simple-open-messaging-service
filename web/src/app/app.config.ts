import {
  APP_INITIALIZER,
  ApplicationConfig,
  CSP_NONCE,
  ErrorHandler,
  isDevMode,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import {
  provideHttpClient,
  withFetch,
  withInterceptorsFromDi,
  withInterceptors,
  HTTP_INTERCEPTORS,
  HttpBackend,
} from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { MAT_SNACK_BAR_DEFAULT_OPTIONS } from '@angular/material/snack-bar';
import {
  provideTransloco,
  provideTranslocoTranspiler,
} from '@jsverse/transloco';
import { provideServiceWorker } from '@angular/service-worker';
import { CspSafeIcuTranspiler } from './i18n/csp-safe-icu.transpiler';
import { AuthInterceptor } from './auth.interceptor';
import { httpTraceInterceptor } from './http-trace.interceptor';
import {
  httpResilienceInterceptor,
  HTTP_RETRY_CONFIG,
  DEFAULT_HTTP_RETRY_CONFIG,
} from './http-resilience.interceptor';
import { correlationIdInterceptor } from './correlation-id.interceptor';
import { GlobalErrorHandler } from './global-error.handler';
import { SseLifecycleService } from './services/sse-lifecycle.service';
import { routes } from './app.routes';
import { InlineTranslocoLoader } from './i18n/transloco.loader';
import { isTauri } from './services/runtime';
import { TauriHttpBackend } from './tauri-http.backend';
import { provideWebdbService } from './services/webdb.service';

/**
 * Read the CSP nonce the Tauri shell stamped onto an inline element at load time, so Angular can replay
 * it on every runtime-injected `<style>` (component + Material styles).
 *
 * Tauri enforces `style-src 'self' 'nonce-<per-load>'`: per CSP, a nonce disables `'unsafe-inline'`, so
 * Angular's component styles — injected as inline `<style>` AFTER the CSP is fixed, with no nonce of
 * their own — are refused (their `.sheet` ends up null and the rules never apply → the unstyled, tiny,
 * skewed UI seen under the shell before this). Tauri mints one nonce per page load and stamps it onto
 * the static inline elements it processed; reading it back here and handing it to Angular via `CSP_NONCE`
 * makes `SharedStylesHost` stamp it on every `<style>` it creates, so they pass. The nonce rotates per
 * load, so it must be re-read at every bootstrap (this runs at module-eval, after the document is parsed).
 * Returns null in the browser (no nonce there) → Angular injects styles without one, exactly as before.
 */
function readCspNonce(): string | null {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector('style[nonce], script[nonce]') as
    | ({ nonce: string } & Element)
    | null;
  return el?.nonce || null;
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideWebdbService(),
    { provide: CSP_NONCE, useValue: readCspNonce() },
    // Restore the native session from OS secure storage (Android EncryptedSharedPreferences / desktop
    // keyring) BEFORE the router resolves, so isLoggedIn() + the HTTP interceptor see the restored token
    // with no race on a trusted-device cold start.
    {
      provide: APP_INITIALIZER,
      multi: true,
      deps: [SseLifecycleService],
      useFactory: (coordinator: SseLifecycleService) => () =>
        coordinator.restoreSession(),
    },
    provideZonelessChangeDetection(),
    {
      provide: HTTP_INTERCEPTORS,
      useClass: AuthInterceptor,
      multi: true,
    },
    // Global sink for uncaught Angular errors (the `[angular]` family) — logs with a greppable prefix,
    // disjoint from `[http]` (the httpTraceInterceptor) and `[unhandled]` (the main.ts window listeners).
    // See global-error.handler.ts.
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    provideRouter(routes, withComponentInputBinding()),
    // HTTP transport: a custom `HttpBackend` (TauriHttpBackend) is the terminus of the interceptor chain.
    // Browser: delegates to Angular's stock FetchBackend (same-origin fetch; httpOnly cookie authenticates).
    // Tauri (desktop + Android): routes /api/v1 through the Rust `api_request` IPC command — Android's
    // WebView rejects the old `api://` custom scheme in fetch(), and Rust injects the Bearer so JS never
    // touches the session token. Upload-progress events are not consumed, so the backend swap is safe.
    provideHttpClient(
      // `withFetch()` registers `FetchBackend` on its own token AND binds `HttpBackend → FetchBackend`.
      // Both matter here: `TauriHttpBackend` (our `HttpBackend` override below) does `inject(FetchBackend)`
      // to delegate the browser path + non-`/api/v1` requests, so `FetchBackend` MUST be a resolvable token.
      // Without `withFetch()`, `provideHttpClient` only provides `HttpXhrBackend` and leaves the
      // `FetchBackend` token unbound → NG0201 at `TauriHttpBackend` construction. Our later
      // `{ provide: HttpBackend, useClass: TauriHttpBackend }` wins (last provider), so `FetchBackend`
      // stays the shared delegate while `TauriHttpBackend` is the chain terminus. Upload-progress events
      // are not consumed anywhere (see message.service.ts), so the fetch transport is safe.
      withFetch(),
      withInterceptorsFromDi(),
      // Always-on HTTP visibility: log every FAILED request to the webview console (5xx + status-0
      // network → error, 4xx → warn; the cancel/abort trace stays dev-only inside the file). Runs INNER
      // to AuthInterceptor, so it logs first then rethrows and the 401 re-login side-effect still fires.
      // See http-trace.interceptor.ts.
      withInterceptors([
        correlationIdInterceptor,
        httpTraceInterceptor,
        httpResilienceInterceptor,
      ]),
    ),
    { provide: HttpBackend, useClass: TauriHttpBackend },
    // 429 burst rate-limit backoff-retry + 5xx/network degraded-notice (see http-resilience.interceptor.ts).
    { provide: HTTP_RETRY_CONFIG, useValue: DEFAULT_HTTP_RETRY_CONFIG },
    provideAnimationsAsync(),
    // Global Material snackbar defaults. The library default IS bottom-center, but the container sits flush
    // at the viewport edge (8px margin) — so every snackbar overlapped the Android gesture/nav bar and read
    // as "too low". The `soms-snack-bar` panelClass lifts it clear of the safe area (see the matching rule in
    // styles.scss). `duration` is a defensive default: every existing call site sets its own (3–60s) and
    // overrides this via the per-call config merge, but any future call that forgets a duration still
    // auto-dismisses instead of lingering forever.
    {
      provide: MAT_SNACK_BAR_DEFAULT_OPTIONS,
      useValue: {
        horizontalPosition: 'center',
        verticalPosition: 'bottom',
        panelClass: 'soms-snack-bar',
        duration: 4000,
      },
    },
    provideTransloco({
      config: {
        availableLangs: [
          { id: 'en', label: 'English' },
          { id: 'zh-CN', label: '简体中文' },
        ],
        // LanguageService overrides this at runtime from the stored preference.
        defaultLang: 'en',
        // Pipe + selectTranslate re-emit on setActiveLang, so templates update
        // under zoneless with no manual change-detection tick.
        reRenderOnLangChange: true,
        prodMode: !isDevMode(),
        missingHandler: { logMissingKey: isDevMode() },
      },
      loader: InlineTranslocoLoader,
    }),
    // ICU {count, plural, …} / {…, select, …} support for the few pluralized strings.
    // CSP-safe transpiler: @jsverse/transloco-messageformat delegates to
    // @messageformat/core, which compiles each message via `new Function()` — that
    // needs 'unsafe-eval', forbidden by the bundled Tauri CSP, so it broke every
    // translation under the shell. This resolver uses Intl.PluralRules (no eval).
    provideTranslocoTranspiler(CspSafeIcuTranspiler),
    // PWA service worker (ngsw). Disabled in dev so HMR keeps working; the `application`
    // builder emits `ngsw-worker.js` (the SW script) + `ngsw.json` (its config) from
    // `ngsw-config.json` in the prod build. The arg is the SW SCRIPT path — `ngsw.json` is fetched by
    // the worker itself at runtime, NOT passed here (passing it makes Chrome refuse registration with
    // "unsupported MIME type application/json"). Disabled under Tauri: the shell serves assets from a
    // local non-HTTP origin (no network to cache, no deploy hash rotation) and would otherwise
    // intercept /api + /uploads navigation. See services/runtime.ts.
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode() && !isTauri(),
    }),
  ],
};
