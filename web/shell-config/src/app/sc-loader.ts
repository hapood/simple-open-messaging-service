import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';
import { Translation, TranslocoLoader } from '@jsverse/transloco';
import { translations } from './translations';

/**
 * Inline transloco loader for the bootstrap — returns the statically-imported dictionary synchronously
 * (same pattern as the main app's InlineTranslocoLoader, web/src/app/i18n/transloco.loader.ts). No HTTP
 * request, so the active language is cached in the same tick setActiveLang runs (no missing-key window
 * on first paint).
 */
@Injectable({ providedIn: 'root' })
export class ScLoader implements TranslocoLoader {
  getTranslation(lang: string): Observable<Translation> {
    return of((translations[lang] ?? translations['en']) as Translation);
  }
}
