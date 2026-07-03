import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import dayjs from 'dayjs';
// Side-effect imports: register the dayjs locales so `dayjs.locale(...)` can switch them.
import 'dayjs/locale/en';
import 'dayjs/locale/zh-cn';
import { translations } from '../i18n/transloco.loader';

/** Languages the app ships with. Add an entry here + a dictionary to extend. */
export type AppLang = 'en' | 'zh-CN';

const LANG_KEY = 'soms.lang';

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
 * `soms.*` localStorage preference exposed as a signal, with an `effect` that
 * reflects the resolved language onto the document and the active Transloco
 * language. The choice is restored from storage on construction (defaulting to
 * the browser language, then English) and can be changed at runtime via
 * {@link cycleLang} / {@link setLang}; runtime switches take effect immediately
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
  readonly lang = signal<AppLang>(this.resolveInitial());

  /** Native-script label for the switcher row (`'English'` / `'简体中文'`). */
  readonly langLabel = computed(() => NATIVE_LABEL[this.lang()]);

  private readonly transloco = inject(TranslocoService);

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
  }

  setLang(l: AppLang): void {
    this.lang.set(l);
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      // localStorage disabled (private mode) — keep the in-memory signal only.
    }
  }

  /** Cycle through available languages (single-button toggle UX). */
  cycleLang(): void {
    const order = this.availableLangs;
    this.setLang(order[(order.indexOf(this.lang()) + 1) % order.length]);
  }

  /** Reflect one language onto Transloco, `<html lang>`, and dayjs. */
  private apply(l: AppLang): void {
    this.transloco.setActiveLang(l);
    document.documentElement.setAttribute('lang', l);
    dayjs.locale(DAYJS_LOCALE[l]);
  }

  private resolveInitial(): AppLang {
    try {
      const stored = localStorage.getItem(LANG_KEY);
      if (stored === 'en' || stored === 'zh-CN') return stored;
    } catch {
      // localStorage disabled — fall through to browser-language detection.
    }
    const nav = typeof navigator !== 'undefined' ? navigator.language || '' : '';
    return nav.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
  }
}
