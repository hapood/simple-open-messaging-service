import {
  computed,
  effect,
  inject,
  Injectable,
  OnDestroy,
  signal,
} from '@angular/core';
import { PreferenceStore } from './preference-store.service';

import {
  EffectiveTheme,
  initialThemeMode,
  META_THEME_COLOR,
  resolveTheme,
  ThemeMode,
} from './theme-bootstrap';
export type { EffectiveTheme, ThemeMode } from './theme-bootstrap';

const THEME_KEY = 'theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Quick-toggle cycle order for the single-button affordance (icon rail, nav drawer, auth toolbar). */
const THEME_CYCLE: readonly ThemeMode[] = ['system', 'light', 'dark'];

/**
 * App-wide light/dark theme controller.
 *
 * The dark-mode token overrides already live in `_tokens.scss` under
 * `[data-theme="dark"]`; this service is the single thing that decides which
 * attribute lands on `<html>`. Default mode is `'system'` (follows OS); the user
 * may override via {@link cycleMode}, and the choice persists device-level via
 * {@link PreferenceStore}.
 *
 * The synchronous boot script supplies a system-theme fallback. Before Angular starts,
 * prepareTheme restores the database preference and applies the resolved theme. This service
 * starts with that same mode and owns subsequent preference and OS updates.
 *
 * `providedIn: 'root'`; eagerly instantiated by injecting it into `AppComponent`
 * so the effect + media-query listener are guaranteed live for the session.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService implements OnDestroy {
  private readonly preferences = inject(PreferenceStore);
  private readonly mq: MediaQueryList | null =
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(DARK_QUERY)
      : null;

  /** User's preference, restored from storage (default `'system'`). */
  readonly mode = signal<ThemeMode>(initialThemeMode());

  /** Live OS preference; only consulted while `mode() === 'system'`. */
  private readonly systemDark = signal<boolean>(!!this.mq?.matches);

  /** Concrete theme to paint. */
  readonly effective = computed<EffectiveTheme>(() => {
    return resolveTheme(this.mode(), this.systemDark());
  });

  constructor() {
    this.mq?.addEventListener('change', this.onSystemChange);

    // Reflect the resolved theme onto the document whenever it changes.
    effect(() => {
      const t = this.effective();
      document.documentElement.setAttribute('data-theme', t);
      const meta = document.querySelector('meta[name="theme-color"]');
      meta?.setAttribute('content', META_THEME_COLOR[t]);
      window.SomsShell?.setSplashTheme?.(t === 'dark');
      window.SomsShell?.setSystemBarTheme?.(t === 'dark');
    });
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
    this.mode.set(m);
    void this.preferences.set('global', THEME_KEY, m).catch(() => {});
  }

  private readonly onSystemChange = (e: MediaQueryListEvent): void => {
    this.systemDark.set(e.matches);
  };
}
