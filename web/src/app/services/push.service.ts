import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { apiPrefix } from './constants';
import { isAndroidNative, isTauri } from './runtime';
import { NavStateMachineService } from './nav-state.service';
import { firstValueFrom } from 'rxjs';

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
 * the same belt-and-braces pattern: a live __SOMS_DEEP_LINK__ handler for warm start, plus a
 * __SOMS_PENDING_THREAD_ID__ boot-fallthrough for cold start.
 */
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
    typeof window !== 'undefined' ? !!window.SomsFcm?.getNotifPermRequested?.() : false;

  /** Wire up at app boot (AppComponent). Self-guards to a no-op outside the Tauri shell. */
  init() {
    if (!isTauri()) return;
    // Kotlin → JS: token rotation (onNewToken / first fetch). Store + attempt registration.
    window.__SOMS_FCM_TOKEN__ = (t) => this.onToken(t);
    // Kotlin → JS: warm-start deep link (notification tap while the app is already running).
    window.__SOMS_DEEP_LINK__ = (tid) => this.openThread(tid);
    // Recover anything emitted before Angular booted. getToken() is a synchronous @JavascriptInterface
    // read; if Kotlin already has a token, use it (the live hook may have been missed).
    const token = window.SomsFcm?.getToken() ?? null;
    if (token) this.onToken(token);
    else window.SomsFcm?.requestToken();
    // Cold-start deep-link fallback (set by Kotlin before this handler could be registered).
    const pending = window.__SOMS_PENDING_THREAD_ID__;
    if (pending) {
      window.__SOMS_PENDING_THREAD_ID__ = undefined;
      this.openThread(pending);
    }
    // Sync the native Firebase client config with the current server (the APK ships without
    // google-services.json; each server publishes its own at GET /push/firebase-config). Fire-and-forget —
    // it self-gates on isAndroidNative() and never throws; if it reconfigures Firebase, the new token
    // flows back through __SOMS_FCM_TOKEN__ → onToken → register() (installed above).
    void this.refreshFirebaseConfig();
  }

  /** Fetch the server's Firebase client config and hand it to native so the Android shell (re)initializes
   *  FirebaseApp. Called at boot (init) and on server switch (server-config-page, after setApiOrigin).
   *  Android-only (desktop has no Firebase). Robust to transients: a network failure leaves the cached
   *  native config intact — only an explicit {configured:false} from the server clears it, so a blip never
   *  silently kills FCM. The 4 fields are only re-pushed when they actually change (avoids needless
   *  token churn on identical config). */
  async refreshFirebaseConfig(): Promise<void> {
    if (!isAndroidNative()) return;
    let data: {
      configured: boolean;
      apiKey?: string;
      projectId?: string;
      appId?: string;
      gcmSenderId?: string;
    } | null = null;
    try {
      const json = await firstValueFrom(this.http.get<{ data?: { configured: boolean; apiKey?: string; projectId?: string; appId?: string; gcmSenderId?: string } | null }>(`${apiPrefix()}/push/firebase-config`));
      data = json?.data ?? null;
    } catch {
      // Network error / server unreachable — keep the current native config (best-effort, don't kill FCM).
      return;
    }
    if (!data) return;
    if (!data.configured) {
      // Server explicitly has no FCM client config → clear native Firebase.
      if (window.SomsFcm!.getFirebaseConfig() !== null) window.SomsFcm!.setFirebaseConfig(null);
      return;
    }
    const next = JSON.stringify({
      apiKey: data.apiKey,
      projectId: data.projectId,
      appId: data.appId,
      gcmSenderId: data.gcmSenderId,
    });
    if (window.SomsFcm!.getFirebaseConfig() !== next) window.SomsFcm!.setFirebaseConfig(next);
  }

  /** Called by AuthService after a successful login — the access token is now in the interceptor, so
   *  the register POST will carry the Authorization header. (The Android background fetchers no longer
   *  need a scoped notification token — they authenticate /notifications/missed with the session token,
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
    const token = this.registeredToken ?? this.currentToken ?? window.SomsFcm?.getToken() ?? null;
    if (token) {
      this.http
        .delete(`${apiPrefix()}/devices/register/${encodeURIComponent(token)}`)
        .subscribe({ error: () => { /* best-effort: a stale token is pruned server-side on next send */ } });
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
    const deviceId = localStorage.getItem('device_id') ?? undefined;
    this.http
      .post<{ code: number }>(`${apiPrefix()}/devices/register`, {
        token,
        platform: 'ANDROID',
        deviceId,
      })
      .subscribe({
        next: (r) => { if (r.code === 0) this.registeredToken = token; },
        error: () => { /* see method doc */ },
      });
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
  private openThread(threadId: string) {
    this.nav.openChat(Number(threadId));
  }
}
