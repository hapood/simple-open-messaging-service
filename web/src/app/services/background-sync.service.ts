import { Injectable, signal } from '@angular/core';

/** FCM status shape returned by the `SomsFcm.getFcmStatus` bridge (JSON-decoded). */
export interface FcmStatus {
  /** True when an FCM token has been obtained — the proxy for "FCM available on this device"
   *  (Google Play Services present). False on domestic devices without GMS, or before the first fetch. */
  hasToken: boolean;
  /** Epoch ms of the last FCM availability check. 0 = never. */
  lastCheck: number;
}

/** System notification-permission status returned by the `SomsFcm.getNotificationStatus` bridge. */
export interface NotifStatus {
  /** Master app-level notification toggle (areNotificationsEnabled) — covers pre-13 default-on and
   *  post-13 granted. False = the OS will suppress every one of our notifications. */
  enabled: boolean;
  /** Whether requesting the permission right now would surface the system prompt (Android 13+, not yet
   *  enabled, and not permanently denied). False → the panel must route the user to system settings. */
  canRequest: boolean;
}

/**
 * Controls Android's background message-delivery preferences — the WorkManager 6h poller and the
 * dataSync foreground service — plus the FCM availability readout. Mirrors the ThemeService /
 * LanguageService preference pattern, with the same justified storage exception: the native code is
 * the source of truth (SomsSecureStore for the toggles; the in-memory token + lastCheck for FCM),
 * because the WorkManager worker and FGS fire with no WebView alive. JS reads/writes via the
 * `SomsFcm` `@JavascriptInterface`.
 *
 * `providedIn: 'root'`; eagerly instantiated by injecting it into AppComponent so the preferences are
 * re-applied to the native schedules at every boot. A safe no-op outside the Tauri Android shell — the
 * toggle UI is hidden there (`isTauri() && isAndroid()`), and every bridge call is optional-chained.
 */
@Injectable({ providedIn: 'root' })
export class BackgroundSyncService {
  /** Whether the 6-hour WorkManager poll is enabled (Kotlin default true). */
  readonly enabled = signal<boolean>(
    typeof window !== 'undefined' ? (window.SomsFcm?.getPollingEnabled?.() ?? true) : true,
  );

  /** Whether the dataSync foreground service is enabled (Kotlin default true). */
  readonly fgsEnabled = signal<boolean>(
    typeof window !== 'undefined' ? (window.SomsFcm?.getForegroundServiceEnabled?.() ?? true) : true,
  );

  /** FCM availability snapshot, read once at boot. Refreshed by [requestFcmCheck]. */
  readonly fcmStatus = signal<FcmStatus>(this.readFcmStatus());

  /** System notification-permission snapshot, read once at boot. Refreshed by [refreshNotifStatus] (panel
   *  open, window focus after returning from system settings, and after [requestPermission]). */
  readonly notifStatus = signal<NotifStatus>(this.readNotifStatus());

  /** Away-notification grouping — "thread" (one card per conversation, Kotlin default) or "all" (one folded
   *  card). Read from native at boot; written through [setGrouping] (the next background fetch sends it). */
  readonly previewMode = signal<'message' | 'private'>(
    typeof window !== 'undefined'
      ? ((window.SomsFcm?.getNotificationPreviewMode?.() as 'message' | 'private') ?? 'message')
      : 'message',
  );

  readonly alertPolicy = signal<'cooldown_2s' | 'cooldown_5s' | 'once_per_thread'>(
    typeof window !== 'undefined'
      ? ((window.SomsFcm?.getNotificationAlertPolicy?.() as
          | 'cooldown_2s'
          | 'cooldown_5s'
          | 'once_per_thread') ?? 'cooldown_5s')
      : 'cooldown_5s',
  );

  setEnabled(enabled: boolean): void {
    this.enabled.set(enabled);
    window.SomsFcm?.setPollingEnabled?.(enabled);
  }

  /** Set the away-notification grouping pref — persists to SomsSecureStore; takes effect on the next fetch. */
  setPreviewMode(mode: 'message' | 'private'): void {
    this.previewMode.set(mode);
    window.SomsFcm?.setNotificationPreviewMode?.(mode);
  }

  setAlertPolicy(policy: 'cooldown_2s' | 'cooldown_5s' | 'once_per_thread'): void {
    this.alertPolicy.set(policy);
    window.SomsFcm?.setNotificationAlertPolicy?.(policy);
  }

  setFgsEnabled(enabled: boolean): void {
    this.fgsEnabled.set(enabled);
    window.SomsFcm?.setForegroundServiceEnabled?.(enabled);
  }

  /** Next scheduled WorkManager poll (epoch ms), or -1 if not scheduled. */
  nextPullTime(): number {
    return typeof window !== 'undefined' ? (window.SomsFcm?.getNextPullTime?.() ?? -1) : -1;
  }

  /** Manual "check now": force an FCM token fetch (bypassing the daily gate) and re-read the status.
   *  The Kotlin fetch is async, so the status is re-read after a short delay to reflect the result. */
  requestFcmCheck(): void {
    window.SomsFcm?.requestFcmCheck?.();
    window.setTimeout(() => this.fcmStatus.set(this.readFcmStatus()), 2500);
  }

  private readFcmStatus(): FcmStatus {
    const raw = typeof window !== 'undefined' ? window.SomsFcm?.getFcmStatus?.() : undefined;
    if (!raw) return { hasToken: false, lastCheck: 0 };
    try {
      const j = JSON.parse(raw) as Partial<FcmStatus>;
      return { hasToken: !!j.hasToken, lastCheck: Number(j.lastCheck) || 0 };
    } catch {
      return { hasToken: false, lastCheck: 0 };
    }
  }

  /** Re-read the system notification status from native. Call on panel open and on window focus (the user
   *  returns from system settings with a changed toggle). No-op off-Android (benign default). */
  refreshNotifStatus(): void {
    this.notifStatus.set(this.readNotifStatus());
  }

  /** Fire the system POST_NOTIFICATIONS prompt (Android 13+, only when `canRequest`). The prompt is modal
   *  and resolves on the user's timing, so the status is re-read after a short delay to catch the common
   *  fast-response case; the panel's focus listener catches a slower response or a system-settings round-trip. */
  requestPermission(): void {
    window.SomsFcm?.requestNotificationPermission?.();
    window.setTimeout(() => this.notifStatus.set(this.readNotifStatus()), 800);
  }

  /** Open the system per-app notification settings — the manual path when `canRequest` is false
   *  (permanently denied on 13+, or pre-13 where there's no runtime prompt). */
  openSystemSettings(): void {
    window.SomsFcm?.openNotificationSettings?.();
  }

  private readNotifStatus(): NotifStatus {
    const raw = typeof window !== 'undefined' ? window.SomsFcm?.getNotificationStatus?.() : undefined;
    if (!raw) return { enabled: true, canRequest: false };
    try {
      const j = JSON.parse(raw) as Partial<NotifStatus>;
      return { enabled: !!j.enabled, canRequest: !!j.canRequest };
    } catch {
      return { enabled: true, canRequest: false };
    }
  }
}
