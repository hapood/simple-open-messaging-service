import {
  buildSettingsCategories,
  type SettingsCategoryDeps,
} from './settings-categories';
import { SettingsDesktopNotificationsComponent } from './settings-desktop-notifications.component';
import { SettingsNotificationsComponent } from './settings-notifications.component';

/**
 * Platform visibility is decided by the live window surfaces runtime.ts reads at call time
 * (`__TAURI_INTERNALS__` for Tauri, the user agent for Android). The Angular browser runner
 * bundles relative modules, so vi.mock cannot substitute them; installing the globals instead
 * exercises the real detection functions (same pattern as auth.service.native.spec.ts).
 */
describe('notification settings platform boundaries', () => {
  const permission = vi.fn(() => 'granted');
  const deps = {
    webPush: { permission },
    language: { lang: () => 'en' },
    transloco: { translate: (key: string) => key },
  } as unknown as SettingsCategoryDeps;
  let originalUserAgent: string;

  beforeEach(() => {
    originalUserAgent = navigator.userAgent;
  });
  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    Object.defineProperty(navigator, 'userAgent', {
      value: originalUserAgent,
      configurable: true,
    });
  });

  /** Install the platform combination under test: Tauri marker + Android/desktop user agent. */
  function platform(tauri: boolean, android: boolean): void {
    const w = window as { __TAURI_INTERNALS__?: unknown };
    if (tauri) w.__TAURI_INTERNALS__ = {};
    else delete w.__TAURI_INTERNALS__;
    Object.defineProperty(navigator, 'userAgent', {
      value: android
        ? 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36'
        : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      configurable: true,
    });
  }

  for (const [name, tauri, android, push, notifications] of [
    ['desktop browser', false, false, false, true],
    ['Android browser', false, true, false, true],
    ['native desktop', true, false, false, true],
    ['native Android', true, true, true, false],
  ] as const) {
    it(`selects appropriate categories for ${name}`, () => {
      platform(tauri, android);
      const categories = buildSettingsCategories(deps);
      expect(categories.find((entry) => entry.id === 'push')!.visible()).toBe(
        push,
      );
      const notification = categories.find(
        (entry) => entry.id === 'notifications',
      )!;
      expect(notification.visible()).toBe(notifications);
      if (notifications) {
        expect(notification.component).toBe(
          tauri
            ? SettingsDesktopNotificationsComponent
            : SettingsNotificationsComponent,
        );
        notification.summary();
        expect(permission).toHaveBeenCalledTimes(tauri ? 0 : 1);
      }
    });
  }
});
