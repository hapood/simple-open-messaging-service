import { PreferenceStorage } from './preference-storage';

export type ThemeMode = 'system' | 'light' | 'dark';
export type EffectiveTheme = 'light' | 'dark';

export const META_THEME_COLOR: Record<EffectiveTheme, string> = {
  light: '#f3f3f1',
  dark: '#11161b',
};

export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function resolveTheme(
  mode: ThemeMode,
  systemDark: boolean,
): EffectiveTheme {
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
}

let bootMode: ThemeMode = 'system';

export function initialThemeMode(): ThemeMode {
  return bootMode;
}

/** Read device preferences before constructing Angular services or rendering application content. */
export async function prepareTheme(): Promise<void> {
  const preferences = new PreferenceStorage();
  try {
    bootMode = normalizeThemeMode(await preferences.get('global', 'theme'));
  } catch {
    bootMode = 'system';
  } finally {
    await preferences.close().catch(() => {});
  }
  const systemDark = !!window.matchMedia?.('(prefers-color-scheme: dark)')
    .matches;
  const theme = resolveTheme(bootMode, systemDark);
  document.documentElement.setAttribute('data-theme', theme);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', META_THEME_COLOR[theme]);
  // Native adapters render this resolved decision; they must not read a second preference store.
  window.SomsShell?.setSplashTheme?.(theme === 'dark');
  window.SomsShell?.setSystemBarTheme?.(theme === 'dark');
  document.documentElement.removeAttribute('data-theme-pending');
}
