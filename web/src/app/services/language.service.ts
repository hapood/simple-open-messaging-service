import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import dayjs from 'dayjs';
// Side-effect imports: register the dayjs locales so `dayjs.locale(...)` can switch them.
import 'dayjs/locale/en';
import 'dayjs/locale/zh-cn';
import { translations } from '../i18n/transloco.loader';
import { PreferenceStore } from './preference-store.service';

/** Languages the app ships with. Add an entry here + a dictionary to extend. */
export type AppLang = 'en' | 'zh-CN';

const LANG_KEY = 'language';

/**
 * Native-script display names for the switcher row. Deliberately NOT translated:
 * each language should always self-identify in its own script, regardless of the
 * currently active language.
 */
const NATIVE_LABEL: Record<AppLang, string> = {
  en: 'English',
  'zh-CN': '简体中文',
};

/** dayjs locale id that corresponds to each app language. */
const DAYJS_LOCALE: Record<AppLang, string> = {
  en: 'en',
  'zh-CN': 'zh-cn',
};

/**
 * App-wide UI-language controller, mirroring {@link ThemeService}: a persisted
 * device-level preference (via {@link PreferenceStore}) exposed as a signal, with an `effect` that
 * reflects the resolved language onto the document and the active Transloco
 * language. The choice is restored from storage on construction (defaulting to
 * the browser language, then English) and can be changed at runtime via
 * {@link setLang}; runtime switches take effect immediately
 * without a reload.
 *
 * `providedIn: 'root'`; eagerly instantiated by injecting it into `AppComponent`
 * so the effect is guaranteed live for the session. The very first paint is
 * handled by a no-FOUC inline script in `index.html` that sets `<html lang>`.
 */
@Injectable({ providedIn: 'root' })
export class LanguageService {
  /** Languages offered, in cycle order. */
  readonly availableLangs: readonly AppLang[] = ['en', 'zh-CN'];

  /** User's preference, restored from storage / browser language (default `'en'`). */
  readonly lang = signal<AppLang>(this.browserDefault());

  /** Native-script label for the switcher row (`'English'` / `'简体中文'`). */
  readonly langLabel = computed(() => this.langLabelOf(this.lang()));

  /** Native-script label for an arbitrary language id — used to render each option in pickers
   *  that list every available language (e.g. the Settings dropdown). Deliberately not translated:
   *  each language self-identifies. */
  langLabelOf(l: AppLang): string {
    return NATIVE_LABEL[l];
  }

  private readonly transloco = inject(TranslocoService);
  private readonly preferences = inject(PreferenceStore);
  private writeRevision = 0;

  constructor() {
    // Eagerly warm both dictionaries in the cache so the very first translate() call (e.g. the first
    // template render, before any microtask) finds them. The inline loader returns `of(...)`, which still
    // resolves asynchronously enough to miss a synchronous read and briefly yield a raw key — populating
    // the cache directly removes that flash entirely.
    for (const [lang, dict] of Object.entries(translations)) {
      this.transloco.setTranslation(dict, lang);
    }
    // Apply synchronously at construction so the very first template render uses
    // the stored language (no English flash when the preference is zh-CN).
    this.apply(this.lang());
    // Own runtime updates (cycle/set) and re-apply on every change.
    effect(() => this.apply(this.lang()));
    void this.restore();
  }

  setLang(l: AppLang): void {
    this.writeRevision++;
    this.lang.set(l);
    void this.preferences.set('global', LANG_KEY, l).catch(() => {});
  }

  /** Reflect one language onto Transloco, `<html lang>`, and dayjs. */
  private apply(l: AppLang): void {
    this.transloco.setActiveLang(l);
    document.documentElement.setAttribute('lang', l);
    dayjs.locale(DAYJS_LOCALE[l]);
  }

  private browserDefault(): AppLang {
    const nav = typeof navigator !== 'undefined' ? navigator.language || '' : '';
    return nav.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
  }

  private async restore(): Promise<void> {
    const revision = this.writeRevision;
    const stored = await this.preferences.get<AppLang>('global', LANG_KEY);
    if (revision !== this.writeRevision) return;
    if (stored === 'en' || stored === 'zh-CN') this.lang.set(stored);
  }
}
