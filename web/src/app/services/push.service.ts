import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { apiPrefix } from './constants';
import { isTauri } from './runtime';

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
  private readonly router = inject(Router);

  /** The FCM token currently registered with the backend (null = not yet registered). */
  private registeredToken: string | null = null;
  /** The most recently seen FCM token (from Kotlin), regardless of registration state. */
  private currentToken: string | null = null;
  /** One-shot guard so the POST_NOTIFICATIONS prompt is asked at most once. */
  private permissionPrompted = false;

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
  }

  /** Called by AuthService after a successful login — the access token is now in the interceptor, so
   *  the register POST will carry the Authorization header. */
  onLogin() {
    if (!isTauri()) return;
    this.maybePromptPermission();
    this.register();
  }

  /** Called by AuthService.logout BEFORE it clears the access token, so the DELETE still carries the
   *  Authorization header. */
  unregister() {
    if (!isTauri()) return;
    const token = this.registeredToken ?? this.currentToken ?? window.SomsFcm?.getToken() ?? null;
    if (!token) return;
    this.http
      .delete(`${apiPrefix}/devices/register/${encodeURIComponent(token)}`)
      .subscribe({ error: () => { /* best-effort: a stale token is pruned server-side on next send */ } });
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
      .post<{ code: number }>(`${apiPrefix}/devices/register`, {
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

  /** Navigate to the tapped thread. The `chat/:threadId` route is always-mounted (ChatReuseStrategy),
   *  and ChatPane renders from ConversationListService.openThreadId which the home shell syncs from the
   *  URL — so a plain navigate is all the deep link needs. */
  private openThread(threadId: string) {
    this.router.navigate(['chat', threadId]).catch(() => { /* navigation races during boot are benign */ });
  }
}
