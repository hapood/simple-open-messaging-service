import { Injectable } from '@angular/core';
import { of, Observable } from 'rxjs';
import { Translation, TranslocoLoader } from '@jsverse/transloco';

import en from './en.json';
import zhCN from './zh-CN.json';

/**
 * Inline translation source.
 *
 * Both dictionaries are statically imported, so they already live in the JS
 * bundle. `getTranslation` resolves them synchronously — `of(...)` emits on
 * subscription, which means the active language is cached in the same tick
 * `setActiveLang` runs. There is no HTTP request to `/assets/i18n` and no
 * window where a key is missing on first paint (the project's no-FOUC ethos,
 * matching the theme inline script). Re-exported as `translations` so the
 * date formatter and any TS-side consumer can read the raw dictionary.
 */
export const translations: Record<string, Translation> = {
  en: en as Translation,
  'zh-CN': zhCN as Translation,
};

@Injectable({ providedIn: 'root' })
export class InlineTranslocoLoader implements TranslocoLoader {
  getTranslation(lang: string): Observable<Translation> {
    return of(translations[lang] ?? translations['en']);
  }
}
