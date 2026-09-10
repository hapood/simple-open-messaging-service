import { Injectable, inject, isDevMode } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { apiPrefix } from './constants';
import { isAndroidNative, isTauri } from './runtime';
import { NavStateMachineService } from './nav-state.service';
import { firstValueFrom } from 'rxjs';
import { consumePendingThreadNavigation } from './pending-thread-navigation';

/**
 * FCM push registration + notification-tap deep linking for the Tauri Android shell. No-op in the
 * browser build (every entry point self-guards on isTauri()).
 *
 * The Android side (SomsMessagingService + MainActivity) owns the Firebase SDK and posts the visible
 * notifications; this service is the JS half of the bridge — it registers the device's FCM token with
 * the backend so the server knows where to send pushes, and routes notification-tap deep links to the
 * chat. Deliberately does NOT inject AuthService (that would form a DI cycle, since AuthService injects
 * this service for onLogin/unregister): register() fires the request and swallows a 401 if no session
 * is active yet, and AuthService calls onLogin() right after a successful login.
 *
 * The token handoff is robust to the boot race: Kotlin may emit the token via
 * window.__SOMS_FCM_TOKEN__ before Angular boots, so init() ALSO reads the current token back via
 * SomsFcm.getToken() (the @JavascriptInterface) — whichever fires first wins. The deep-link path uses
 * a native-owned pending target, drained both by the live hook and at boot, then acknowledged.
 */
/** The Firebase client config payload (folded into /shell/compat). `{configured:false}` when the server has
 *  no google-services.json; otherwise the 4 client fields an Android app needs to init FirebaseApp. */
export type FirebaseClientConfigPayload = {
  configured: boolean;
  apiKey?: string;
  projectId?: string;
  appId?: string;
  gcmSenderId?: string;
};

export type FcmProbeStatus = {
  probeId: string;
  stage: 'fcm_accepted' | 'device_received' | 'failed';
  createdAt: number;
  acceptedAt?: number;
  receivedAt?: number;
  latencyMs?: number;
  errorCode?: string;
};

type ApiEnvelope<T> = { code: number; message: string; data: T };

@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly http = inject(HttpClient);
  private readonly nav = inject(NavStateMachineService);

  /** The FCM token currently registered with the backend (null = not yet registered). */
  private registeredToken: string | null = null;
  /** The most recently seen FCM token (from Kotlin), regardless of registration state. */
  private currentToken: string | null = null;
  /** One-shot guard so the POST_NOTIFICATIONS prompt is asked at most once. Seeded from the persisted
   *  native flag (set by MainActivity.onRequestPermissionsResult) so the auto-prompt fires only on the
   *  first login EVER — not the first login of every cold start (which would re-prompt users who merely
   *  dismissed/denied-without-"don't ask again" on each session). */
  private permissionPrompted =
    typeof window !== 'undefined'
      ? !!window.SomsFcm?.getNotifPermRequested?.()
      : false;

  /** Wire up at app boot (AppComponent). Self-guards to a no-op outside the Tauri shell. */
  init() {
    if (!isTauri()) return;
    // Kotlin → JS: token rotation (onNewToken / first fetch). Store + attempt registration.
    window.__SOMS_FCM_TOKEN__ = (t) => this.onToken(t);
    // Kotlin → JS: warm-start deep link (notification tap while the app is already running).
    window.__SOMS_DEEP_LINK__ = () => this.openPendingThread();
    // Recover anything emitted before Angular booted. getToken() is a synchronous @JavascriptInterface
    // read; if Kotlin already has a token, use it (the live hook may have been missed).
    const token = window.SomsFcm?.getToken() ?? null;
    if (token) this.onToken(token);
    else window.SomsFcm?.requestToken();
    // Read native pending navigation after registering the live wake handler.
    this.openPendingThread();
    // The native Firebase client config is NOT synced here at boot — it is applied in the server-config
    // flow (server-config-page.finalize) from the config folded into /shell/compat, and the native
    // SomsApplication.onCreate cold-start reader covers boot from the persisted value. No separate fetch.
  }

  /** Apply a server-provided Firebase client config to native so the Android shell (re)initializes
   *  FirebaseApp. Called from the server-config flow with the config folded into /shell/compat (the APK
   *  ships without google-services.json; each server publishes its own — no separate /push/firebase-config
   *  fetch). Android-only (desktop has no Firebase). The 4 fields are only re-pushed when they actually
   *  change (avoids needless token churn on identical config); an explicit {configured:false} clears native
   *  Firebase. Sync + never throws. */
  applyFirebaseConfig(
    data: FirebaseClientConfigPayload | null | undefined,
  ): void {
    if (!isAndroidNative()) {
      if (isDevMode())
        console.info('firebase config: skipped (not Android native)');
      return;
    }
    if (isDevMode()) {
      console.info('firebase config: bridge read start', {
        configured: !!data?.configured,
      });
    }
    if (!data || !data.configured) {
      // Server explicitly has no FCM client config → clear native Firebase.
      const current = window.SomsFcm!.getFirebaseConfig();
      if (isDevMode()) {
        console.info('firebase config: bridge read complete', {
          hasCurrentConfig: current !== null,
        });
      }
      if (current !== null) {
        window.SomsFcm!.setFirebaseConfig(null);
        if (isDevMode())
          console.info('firebase config: native clear dispatched');
      } else if (isDevMode()) {
        console.info('firebase config: unchanged (already clear)');
      }
      return;
    }
    const next = JSON.stringify({
      apiKey: data.apiKey,
      projectId: data.projectId,
      appId: data.appId,
      gcmSenderId: data.gcmSenderId,
    });
    const current = window.SomsFcm!.getFirebaseConfig();
    if (isDevMode()) {
      console.info('firebase config: bridge read complete', {
        hasCurrentConfig: current !== null,
        changed: current !== next,
      });
    }
    if (current !== next) {
      window.SomsFcm!.setFirebaseConfig(next);
      if (isDevMode())
        console.info('firebase config: native reconfigure dispatched');
    } else if (isDevMode()) {
      console.info('firebase config: unchanged');
    }
  }

  /** Called by AuthService after a successful login — the access token is now in the interceptor, so
   *  the register POST will carry the Authorization header. (The Android background fetchers no longer
   *  need a scoped notification token — Rust authenticates thread-feed synchronization with the session token,
   *  which AuthService pushes to Kotlin via SomsFcm.setSessionToken.) */
  onLogin() {
    if (!isTauri()) return;
    this.maybePromptPermission();
    this.register();
  }

  /** Called by AuthService.logout BEFORE it clears the session token, so the DELETE still carries the
   *  Authorization header. (The token the Android background fetchers use — in EncryptedSharedPreferences —
   *  is cleared separately by AuthService.clearToken → SomsFcm.setSessionToken(null).) */
  unregister() {
    if (!isTauri()) return;
    // SomsFcm is absent on desktop (this runs under isTauri = desktop + Android), so `?.` is correct
    // here — getToken() legitimately no-ops on desktop.
    const token =
      this.registeredToken ??
      this.currentToken ??
      window.SomsFcm?.getToken() ??
      null;
    if (token) {
      this.http
        .delete(`${apiPrefix()}/devices/register/${encodeURIComponent(token)}`)
        .subscribe({
          error: () => {
            /* best-effort: a stale token is pruned server-side on next send */
          },
        });
    }
    this.registeredToken = null;
  }

  /** New token from Kotlin (first fetch or rotation). Stash it and try to register. */
  private onToken(token: string) {
    this.currentToken = token;
    this.register();
  }

  /** POST the current token to the backend (idempotent upsert). Swallows errors: a 401 means no
   *  session yet (login will retry via onLogin); other failures retry on the next rotation. */
  private register() {
    const token = this.currentToken;
    if (!token || token === this.registeredToken) return;
    this.http
      .post<{ code: number }>(`${apiPrefix()}/devices/register`, {
        token,
        platform: 'ANDROID',
      })
      .subscribe({
        next: (r) => {
          if (r.code === 0) this.registeredToken = token;
        },
        error: () => {
          /* see method doc */
        },
      });
  }

  /** Start and poll the authenticated current-device FCM delivery probe. The settings UI owns the
   * one-second cadence and 15-second deadline; these methods only expose the two server operations. */
  async createFcmProbe(token: string): Promise<FcmProbeStatus> {
    await this.ensureTokenRegistered(token);
    const response = await firstValueFrom(
      this.http.post<ApiEnvelope<FcmProbeStatus>>(
        `${apiPrefix()}/devices/fcm-probes`,
        { token },
      ),
    );
    return this.unwrap(response);
  }

  async getFcmProbe(probeId: string): Promise<FcmProbeStatus> {
    const response = await firstValueFrom(
      this.http.get<ApiEnvelope<FcmProbeStatus>>(
        `${apiPrefix()}/devices/fcm-probes/${encodeURIComponent(probeId)}`,
      ),
    );
    return this.unwrap(response);
  }

  private async ensureTokenRegistered(token: string): Promise<void> {
    if (this.registeredToken === token) return;
    const response = await firstValueFrom(
      this.http.post<ApiEnvelope<null>>(`${apiPrefix()}/devices/register`, {
        token,
        platform: 'ANDROID',
      }),
    );
    if (response.code !== 0) throw new Error(response.message);
    this.currentToken = token;
    this.registeredToken = token;
  }

  private unwrap<T>(response: ApiEnvelope<T>): T {
    if (response.code !== 0 || response.data == null) {
      throw new Error(response.message || 'FCM health check failed');
    }
    return response.data;
  }

  /** Ask for POST_NOTIFICATIONS once, after the first login (Android 13+). The native side handles the
   *  actual system prompt; this is the contextual trigger point (not cold launch). */
  private maybePromptPermission() {
    if (this.permissionPrompted) return;
    this.permissionPrompted = true;
    window.SomsFcm?.requestNotificationPermission();
  }

  /** Open the tapped thread via the nav state machine (the URL mirror updates `/chat/:id`; ChatPane renders
   *  from ConversationListService.openThreadId which the home shell syncs from the state machine). */
  private openPendingThread() {
    consumePendingThreadNavigation(window.SomsFcm, (threadId) =>
      this.nav.openChat(threadId),
    );
  }
}
