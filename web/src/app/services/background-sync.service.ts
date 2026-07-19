import { Injectable, signal } from '@angular/core';

/** FCM status shape returned by the `SomsFcm.getFcmStatus` bridge (JSON-decoded). */
export interface FcmStatus {
  /** True when an FCM token has been obtained — the proxy for "FCM available on this device"
   *  (Google Play Services present). False on domestic devices without GMS, or before the first fetch. */
  hasToken: boolean;
  /** Epoch ms of the last FCM availability check. 0 = never. */
  lastCheck: number;
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

  setEnabled(enabled: boolean): void {
    this.enabled.set(enabled);
    window.SomsFcm?.setPollingEnabled?.(enabled);
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
}
