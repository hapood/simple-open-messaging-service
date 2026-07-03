import { ApplicationConfig, isDevMode, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withInterceptorsFromDi, HTTP_INTERCEPTORS } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideTransloco } from '@jsverse/transloco';
import { provideTranslocoMessageformat } from '@jsverse/transloco-messageformat';
import { AuthInterceptor } from './auth.interceptor';
import { routes } from './app.routes';
import { InlineTranslocoLoader } from './i18n/transloco.loader';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    {
      provide: HTTP_INTERCEPTORS,
      useClass: AuthInterceptor,
      multi: true
    },
    provideRouter(routes, withComponentInputBinding()),
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
  ],
};
