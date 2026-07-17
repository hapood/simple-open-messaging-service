import { APP_INITIALIZER, ApplicationConfig, CSP_NONCE, isDevMode, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withInterceptorsFromDi, withFetch, HTTP_INTERCEPTORS } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideTransloco, provideTranslocoTranspiler } from '@jsverse/transloco';
import { provideServiceWorker } from '@angular/service-worker';
import { CspSafeIcuTranspiler } from './i18n/csp-safe-icu.transpiler';
import { AuthInterceptor } from './auth.interceptor';
import { AuthService } from './services/auth.service';
import { routes } from './app.routes';
import { InlineTranslocoLoader } from './i18n/transloco.loader';
import { isTauri } from './services/runtime';

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
  const el = document.querySelector('style[nonce], script[nonce]') as ({ nonce: string } & Element) | null;
  return el?.nonce || null;
}

export const appConfig: ApplicationConfig = {
  providers: [
    { provide: CSP_NONCE, useValue: readCspNonce() },
    // Restore the native session from OS secure storage (Android EncryptedSharedPreferences / desktop
    // keyring) BEFORE the router resolves, so isLoggedIn() + the HTTP interceptor see the restored token
    // with no race on a trusted-device cold start. No-op on the pure-httpOnly browser build.
    {
      provide: APP_INITIALIZER,
      multi: true,
      deps: [AuthService],
      useFactory: (auth: AuthService) => () => auth.restoreSession(),
    },
    provideZonelessChangeDetection(),
    {
      provide: HTTP_INTERCEPTORS,
      useClass: AuthInterceptor,
      multi: true
    },
    provideRouter(routes, withComponentInputBinding()),
    // withFetch(): use the Fetch backend instead of XHR. Required under the Tauri shell —
    // installNativeFetch() (runtime.ts, called before bootstrap) swaps globalThis.fetch for the
    // tauri-plugin-http reqwest client, and the Fetch backend is the only HttpClient backend that
    // reads globalThis.fetch; without it, API calls would still go out via XHR and hit the webview's
    // CORS gate. Auth: the browser auto-attaches the httpOnly `media_token` cookie same-origin (no
    // header needed), while native builds send `Authorization: Bearer` via this same fetch path. The
    // fetch backend's default credentials are correct for both. Upload-progress events are not consumed
    // anywhere, so the XHR→fetch switch is regression-free.
    provideHttpClient(withInterceptorsFromDi(), withFetch()),
    provideAnimationsAsync(),
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
    // PWA service worker (ngsw). Disabled in dev so HMR + eruda keep working; the `application`
    // builder emits `ngsw-worker.js` (the SW script) + `ngsw.json` (its config) from
    // `ngsw-config.json` in the prod build. The arg is the SW SCRIPT path — `ngsw.json` is fetched by
    // the worker itself at runtime, NOT passed here (passing it makes Chrome refuse registration with
    // "unsupported MIME type application/json"). Disabled under Tauri: the shell serves assets from a
    // local non-HTTP origin (no network to cache, no deploy hash rotation) and would otherwise
    // intercept /api + /uploads navigation. See services/runtime.ts.
    provideServiceWorker('ngsw-worker.js', { enabled: !isDevMode() && !isTauri() }),
  ],
};
