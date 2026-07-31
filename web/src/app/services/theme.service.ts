import { computed, effect, inject, Injectable, OnDestroy, signal } from '@angular/core';
import { PreferenceStore } from './preference-store.service';

/** User-facing preference. `'system'` follows the OS `prefers-color-scheme`. */
export type ThemeMode = 'system' | 'light' | 'dark';
/** The concrete theme actually painted. */
export type EffectiveTheme = 'light' | 'dark';

const THEME_KEY = 'theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Quick-toggle cycle order for the single-button affordance (icon rail, nav drawer, auth toolbar). */
const THEME_CYCLE: readonly ThemeMode[] = ['system', 'light', 'dark'];

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
  private readonly preferences = inject(PreferenceStore);
  private writeRevision = 0;
  private readonly mq: MediaQueryList | null =
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(DARK_QUERY) : null;

  /** User's preference, restored from storage (default `'system'`). */
  readonly mode = signal<ThemeMode>('system');

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
      window.SomsShell?.setSystemBarTheme?.(t === 'dark');
    });
    void this.restore();
  }

  ngOnDestroy(): void {
    this.mq?.removeEventListener('change', this.onSystemChange);
  }

  /** Single-button cycle: `system → light → dark → system`. Exposing `system` from the
   *  quick-toggle buttons (icon rail, nav drawer, auth toolbar) — not only the Settings page —
   *  lets users return to OS-following without a detour into Settings. The one dead step is
   *  re-entering `system` while the OS already matches the current paint (e.g. OS dark: `dark`
   *  and `system` render identically); the CONTRAST icon + "System" label still flip, so every
   *  click yields visible affordance feedback. `system` is also the default initial mode and
   *  auto-follows the OS via `prefers-color-scheme`. */
  cycleMode(): void {
    const order = THEME_CYCLE;
    this.setMode(order[(order.indexOf(this.mode()) + 1) % order.length]);
  }

  setMode(m: ThemeMode): void {
    this.writeRevision++;
    this.mode.set(m);
    void this.preferences.set('global', THEME_KEY, m).catch(() => {});
  }

  private readonly onSystemChange = (e: MediaQueryListEvent): void => {
    this.systemDark.set(e.matches);
  };

  private async restore(): Promise<void> {
    const revision = this.writeRevision;
    const value = await this.preferences.get<ThemeMode>('global', THEME_KEY);
    if (revision !== this.writeRevision) return;
    if (value === 'system' || value === 'light' || value === 'dark') this.mode.set(value);
  }
}
