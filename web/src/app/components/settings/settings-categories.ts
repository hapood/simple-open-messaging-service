import { type Type } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { AppIconType } from '../icon/model';
import { ThemeService } from '../../services/theme.service';
import { LanguageService } from '../../services/language.service';
import { MediaSizeThresholdService } from '../../services/media-size-threshold.service';
import { BackgroundSyncService } from '../../services/background-sync.service';
import { WebPushService } from '../../services/web-push.service';
import { WebsocketService } from '../../services/websocket.service';
import { isAndroid, isTauri } from '../../services/runtime';
import { appVersion } from '../../version';
import { SettingsAppearanceComponent } from './settings-appearance.component';
import { SettingsLanguageComponent } from './settings-language.component';
import { SettingsMediaComponent } from './settings-media.component';
import { SettingsPushComponent } from './settings-push.component';
import { SettingsNotificationsComponent } from './settings-notifications.component';
import { SettingsConnectionComponent } from './settings-connection.component';
import { SettingsAboutComponent } from './settings-about.component';
import { SettingsDevicesComponent } from './settings-devices.component';

/** Identifiers for the Settings categories (drives the aside-stack `params.category` on mobile, and the
 *  local selection signal in the desktop/tablet dialog). */
export type SettingsCategoryId =
  | 'appearance'
  | 'language'
  | 'media'
  | 'devices'
  | 'connection'
  | 'push'
  | 'notifications'
  | 'about';

/**
 * One row on the Settings category list. `summary`/`visible` close over the injected preference services
 * so the list previews each category's current value (and hides platform-specific categories). Mirrors
 * the `PopupType` + `componentDict` registry pattern in `RouteService`, but built via a factory so the
 * callbacks can read services. Adding a setting = append an entry in {@link buildSettingsCategories} +
 * write a body-only component.
 */
export interface SettingsCategory {
  readonly id: SettingsCategoryId;
  readonly icon: AppIconType;
  readonly titleKey: string;
  /** One-line preview of the category's current value (shown under the title on the lists). */
  readonly summary: () => string;
  /** The body-only sub-page component rendered for this category. */
  readonly component: Type<unknown>;
  /** Whether the category is shown on this platform (Push is Android/Tauri-only). */
  readonly visible: () => boolean;
  readonly order: number;
}

/** Services the category summaries/visibility read. Passed in by each host component. */
export interface SettingsCategoryDeps {
  readonly theme: ThemeService;
  readonly language: LanguageService;
  readonly mediaSize: MediaSizeThresholdService;
  readonly bgSync: BackgroundSyncService;
  readonly webPush: WebPushService;
  readonly ws: WebsocketService;
  readonly transloco: TranslocoService;
}

/**
 * Build the shared Settings category registry. Consumed by BOTH {@link SettingsComponent} (mobile aside,
 * drill-in) and {@link SettingsDialogComponent} (desktop/tablet, two-column flat) — the single source of
 * truth for what categories exist, their order, icons, summaries, and sub-page components.
 */
export function buildSettingsCategories(d: SettingsCategoryDeps): readonly SettingsCategory[] {
  // Category summary helpers — read their service's signal (and the language signal, so a language
  // switch re-renders the translated summary) keeping the list reactive.
  const themeModeLabel = (): string => {
    void d.language.lang();
    const m = d.theme.mode();
    const key =
      m === 'system' ? 'settings.themeSystem' : m === 'light' ? 'settings.themeLight' : 'settings.themeDark';
    return d.transloco.translate(key);
  };
  const thresholdLabel = (kb: number): string => {
    void d.language.lang();
    if (kb <= 0) return d.transloco.translate('settings.noLimit');
    if (kb >= 1024) return `${kb / 1024} MB`;
    return `${kb} KB`;
  };
  const pushSummary = (): string => {
    void d.language.lang();
    return d.transloco.translate(
      d.bgSync.fcmStatus().hasToken ? 'settings.fcmActive' : 'settings.fcmUnavailable',
    );
  };
  const notifSummary = (): string => {
    void d.language.lang();
    const p = d.webPush.permission();
    if (p === 'granted') return d.transloco.translate('settings.notifOn');
    if (p === 'unsupported') return d.transloco.translate('settings.notifUnavailable');
    return d.transloco.translate('settings.notifOff'); // 'default' | 'denied'
  };
  const connectionSummary = (): string => {
    void d.language.lang();
    const key =
      d.ws.state() === 'open'
        ? 'settings.connStatusOpen'
        : d.ws.state() === 'connecting'
          ? 'settings.connStatusConnecting'
          : d.ws.state() === 'reconnecting'
            ? 'settings.connStatusReconnecting'
            : 'settings.connStatusClosed';
    return d.transloco.translate(key);
  };

  return [
    {
      id: 'appearance',
      icon: AppIconType.CONTRAST,
      titleKey: 'settings.appearance',
      summary: themeModeLabel,
      component: SettingsAppearanceComponent,
      visible: () => true,
      order: 0,
    },
    {
      id: 'language',
      icon: AppIconType.GLOBE,
      titleKey: 'settings.language',
      summary: () => d.language.langLabel(),
      component: SettingsLanguageComponent,
      visible: () => true,
      order: 1,
    },
    {
      id: 'media',
      icon: AppIconType.IMAGE,
      titleKey: 'settings.media',
      summary: () => thresholdLabel(d.mediaSize.kb()),
      component: SettingsMediaComponent,
      visible: () => true,
      order: 2,
    },
    {
      // Active sessions / logged-in devices — revocable per-device (industry-standard session management).
      // Visible everywhere: web, desktop, and the Android WebView app all share this one component.
      id: 'devices',
      icon: AppIconType.DEVICES,
      titleKey: 'settings.devices',
      summary: () => {
        void d.language.lang();
        return d.transloco.translate('settings.devicesHint');
      },
      component: SettingsDevicesComponent,
      visible: () => true,
      order: 2,
    },
    {
      id: 'push',
      icon: AppIconType.NOTIFICATIONS,
      titleKey: 'settings.push',
      summary: pushSummary,
      component: SettingsPushComponent,
      visible: () => isTauri() && isAndroid(),
      order: 3,
    },
    {
      // Browser build only (PC browser + iOS PWA). Android uses FCM (the `push` category above); the
      // Tauri desktop shell posts via window.__TAURI__.notification with no browser permission needed.
      id: 'notifications',
      icon: AppIconType.NOTIFICATIONS,
      titleKey: 'settings.notifications',
      summary: notifSummary,
      component: SettingsNotificationsComponent,
      visible: () => !isTauri(),
      order: 3,
    },
    {
      // Diagnostics: realtime SSE connection state (+ retry) and a manual server health probe. Visible
      // everywhere — every platform has a realtime stream to inspect. Sits after the push/notifications
      // pair (same order, later in the array) and before About.
      id: 'connection',
      icon: AppIconType.SERVER,
      titleKey: 'settings.connection',
      summary: connectionSummary,
      component: SettingsConnectionComponent,
      visible: () => true,
      order: 3,
    },
    {
      id: 'about',
      icon: AppIconType.INFO,
      titleKey: 'settings.about',
      summary: () => appVersion,
      component: SettingsAboutComponent,
      visible: () => true,
      order: 4,
    },
  ];
}
