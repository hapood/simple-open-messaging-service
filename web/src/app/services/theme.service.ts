import { computed, effect, Injectable, OnDestroy, signal } from '@angular/core';

/** User-facing preference. `'system'` follows the OS `prefers-color-scheme`. */
export type ThemeMode = 'system' | 'light' | 'dark';
/** The concrete theme actually painted. */
export type EffectiveTheme = 'light' | 'dark';

const THEME_KEY = 'soms.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** `<meta name="theme-color">`: brand in light, dark surface in dark, so mobile browser chrome blends. */
const META_THEME_COLOR: Record<EffectiveTheme, string> = {
  light: '#2196f3',
  dark: '#0b141a',
};

/**
 * App-wide light/dark theme controller.
 *
 * The dark-mode token overrides already live in `_tokens.scss` under
 * `[data-theme="dark"]`; this service is the single thing that decides which
 * attribute lands on `<html>`. Default mode is `'system'` (follows OS); the user
 * may override via {@link cycleMode}, and the choice persists in `localStorage`
 * under the project's `soms.*` prefix.
 *
 * A no-FOUC inline script in `index.html` paints the very first frame using the
 * same resolution; this service then owns runtime updates (mode change or OS
 * preference change) and keeps `<html data-theme>` + `<meta name="theme-color">`
 * in sync via an `effect`.
 *
 * `providedIn: 'root'`; eagerly instantiated by injecting it into `AppComponent`
 * so the effect + media-query listener are guaranteed live for the session.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService implements OnDestroy {
  private readonly mq: MediaQueryList | null =
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(DARK_QUERY) : null;

  /** User's preference, restored from storage (default `'system'`). */
  readonly mode = signal<ThemeMode>(this.readStored());

  /** Live OS preference; only consulted while `mode() === 'system'`. */
  private readonly systemDark = signal<boolean>(!!this.mq?.matches);

  /** Concrete theme to paint. */
  readonly effective = computed<EffectiveTheme>(() => {
    const m = this.mode();
    return m === 'system' ? (this.systemDark() ? 'dark' : 'light') : m;
  });

  constructor() {
    this.mq?.addEventListener('change', this.onSystemChange);

    // Reflect the resolved theme onto the document whenever it changes.
    effect(() => {
      const t = this.effective();
      document.documentElement.setAttribute('data-theme', t);
      const meta = document.querySelector('meta[name="theme-color"]');
      meta?.setAttribute('content', META_THEME_COLOR[t]);
    });
  }

  ngOnDestroy(): void {
    this.mq?.removeEventListener('change', this.onSystemChange);
  }

  /** Cycle system → light → dark → system (single-button toggle UX). */
  cycleMode(): void {
    const order: ThemeMode[] = ['system', 'light', 'dark'];
    this.setMode(order[(order.indexOf(this.mode()) + 1) % order.length]);
  }

  setMode(m: ThemeMode): void {
    this.mode.set(m);
    try {
      localStorage.setItem(THEME_KEY, m);
    } catch {
      // localStorage disabled (private mode) — keep the in-memory signal only.
    }
  }

  private readonly onSystemChange = (e: MediaQueryListEvent): void => {
    this.systemDark.set(e.matches);
  };

  private readStored(): ThemeMode {
    try {
      const v = localStorage.getItem(THEME_KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch {
      return 'system';
    }
  }
}
