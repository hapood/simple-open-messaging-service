import { ApplicationConfig, isDevMode, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding, RouteReuseStrategy } from '@angular/router';
import { provideHttpClient, withInterceptorsFromDi, HTTP_INTERCEPTORS } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideTransloco } from '@jsverse/transloco';
import { provideTranslocoMessageformat } from '@jsverse/transloco-messageformat';
import { provideServiceWorker } from '@angular/service-worker';
import { AuthInterceptor } from './auth.interceptor';
import { routes } from './app.routes';
import { InlineTranslocoLoader } from './i18n/transloco.loader';
import { isTauri } from './services/runtime';
import { ChatReuseStrategy } from './chat-reuse-strategy';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    {
      provide: HTTP_INTERCEPTORS,
      useClass: AuthInterceptor,
      multi: true
    },
    provideRouter(routes, withComponentInputBinding()),
    // Always-mounted chat: reuse the ChatPane instance across `''` (list) ↔ `chat/:threadId` (open chat) so
    // the kernel never remounts on open/close. See chat-reuse-strategy.ts.
    { provide: RouteReuseStrategy, useClass: ChatReuseStrategy },
    provideHttpClient(withInterceptorsFromDi()),
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
    provideTranslocoMessageformat(),
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
