import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, EMPTY, firstValueFrom, tap } from 'rxjs';
import { TranslocoService } from '@jsverse/transloco';
import { RouteService, RoutePage } from './route.service';
import { apiPrefix } from './constants';
import { isTauri, isAndroidNative, tauriInvoke, sessionClient } from './runtime';
import { PushService } from './push.service';
import { WebPushService } from './web-push.service';
import { UserService } from './user.service';
import { ToastService } from './toast.service';

const SESSION_TOKEN = 'session_token',
  IS_KEEP_LOGIN = 'is_keep_login',
  // Non-httpOnly presence cookie the backend sets/clears in lockstep with the httpOnly session cookie
  // (name mirrors src/auth/media-token.ts LOGGED_IN_COOKIE). On the pure-httpOnly browser build the
  // session token is JS-unreadable, so this flag is how the SPA tells whether a session exists.
  LOGGED_IN_COOKIE = 'logged_in'

/** On-screen duration (ms) for important auth notices (forced-logout / persist-failure) — longer than the
 *  default toast so a user looking away still catches why they're back at the sign-in screen. */
const IMPORTANT_NOTICE_MS = 6000

type LoginRes = { code: number, message: string, data?: { session_token?: string, mustChangePassword?: boolean } }
type LogoutRes = { code: number, message: string }

/**
 * One opaque per-device session token authenticates every request — carried as an httpOnly cookie
 * (browser: auto-attached same-origin, JS-unreadable) or an `Authorization: Bearer` header (native: the
 * interceptor + Rust media proxy + Kotlin SSE/FCM/Worker). The backend accepts cookie-or-Bearer on every
 * route. No access JWT, no refresh token, no renewal. Issued at login; revoked at logout / logout-all /
 * change-password (`invalidateAllSessions`); a 401 → re-login (`redoLoginAuth`).
 *
 * **Storage (no persistent plaintext copy on any platform):**
 *  - Browser (pure httpOnly): the token is NEVER held in JS — XSS can't exfiltrate it. Login state rides
 *    the non-httpOnly `logged_in` presence cookie (`document.cookie`). "Keep me logged in" maps to the
 *    cookie lifetime (14-day sliding vs session) via the login `persistent` flag; the httpOnly cookie can
 *    only be cleared by the backend (logout).
 *  - Android: the raw token lives in EncryptedSharedPreferences (Android-Keystore-backed), read/written
 *    via the `SomsFcm` bridge — the SAME store the native RealtimeService/FCM/Worker read. The webview
 *    keeps only an in-memory copy (never localStorage), so at rest the token is encrypted only.
 *  - Desktop (Tauri): a TRUSTED device persists the token in the OS credential store (Windows Credential
 *    Manager / macOS Keychain / Linux Secret Service) via the `secure_*` Tauri commands; an UNTRUSTED
 *    device keeps it in memory only (lost on restart → re-login). Either way the desktop media proxy
 *    (`set_session_token`) gets an in-memory copy for `/uploads/*` Bearer injection. No plaintext copy.
 */
@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private _isKeep = localStorage.getItem(IS_KEEP_LOGIN) === '1' || false
  /** Whether this session's token is durable — kept in OS secure storage (Android EncryptedSharedPreferences,
   *  or the desktop OS keyring) and therefore server-issued as permanent (revocation-only). False on web
   *  (cookie-only) and on an untrusted desktop (memory-only, sliding). */
  private _trusted = false
  /** Whether THIS client is capable of being a trusted device — i.e. it has a working OS secure store
   *  (Android EncryptedSharedPreferences always; the desktop OS keyring when a boot-time probe reaches it;
   *  never on web). Gates the "Trust this device" toggle so a desktop without a usable keyring can't request
   *  a permanent token it then can't persist (which would orphan a server-side permanent session). */
  private _canTrust = false
  /** The session token: in-memory copy of the credential (null when logged out / pre-login). On native it
   *  is restored from OS secure storage by {@link restoreSession} (an APP_INITIALIZER, awaited before
   *  routing) so a cold start re-establishes the session with no plaintext JS copy. */
  private _sessionToken: string | null = null
  get sessionToken(): string | null { return this._sessionToken }
  /** True when this client has a working OS secure store and may therefore be trusted (hold a permanent
   *  token). Probed once at boot by {@link restoreSession}. */
  get canTrust(): boolean { return this._canTrust }
  /** Reactive view of the session token for the realtime transport: the SSE worker is spawned at boot
   *  (pre-login) and asks for the token via `need-token` — it must BLOCK until login provides one, so the
   *  transport awaits the first non-null emission here rather than busy-looping. Emits the current value
   *  to new subscribers (so a post-login spawn resolves at once). */
  private readonly _sessionTokenSub = new BehaviorSubject<string | null>(this._sessionToken)
  readonly sessionToken$ = this._sessionTokenSub.asObservable()
  /** Reactive login state — true while a session is active. Drives the realtime transport's
   *  connect/disconnect lifecycle (WebsocketService's login effect). Initialized from {@link isLoggedIn}
   *  and flipped in {@link activateSession}/{@link setRestored} (→true) and {@link clearToken} (→false).
   *  On the browser this mirrors the non-httpOnly `logged_in` presence cookie (the session credential
   *  itself is JS-unreadable); on native it mirrors the restored/held token. */
  readonly loggedIn = signal<boolean>(this.isLoggedIn())

  constructor(
    private http: HttpClient,
    private routeService: RouteService,
    private push: PushService,
    private webPush: WebPushService,
    private userService: UserService,
    private transloco: TranslocoService,
    private toast: ToastService,
  ) {}

  /** Resolve a transloco key to the active-locale string (falls back to the key). Mirrors WebPushService.t. */
  private t(key: string): string {
    return this.transloco.translate(key) ?? key;
  }

  /** True when logged in. Native: a raw token is held in JS storage. Browser (pure httpOnly): the
   *  token is JS-unreadable, so login state is the non-httpOnly `logged_in` presence cookie the backend
   *  sets/clears in lockstep with the session cookie. */
  isLoggedIn(): boolean {
    return isTauri() ? this._sessionToken !== null : this.hasPresenceCookie()
  }

  private hasPresenceCookie(): boolean {
    return typeof document !== 'undefined'
      && document.cookie.split(';').some((c) => c.trim().startsWith(`${LOGGED_IN_COOKIE}=`))
  }

  /** Drop the non-httpOnly presence cookie (JS can clear this; the httpOnly session cookie is cleared
   *  server-side on logout, or overwritten on next login). Used on logout / 401 so isLoggedIn() flips
   *  false immediately — avoids a stale-logged-in redirect loop with the guest guard. */
  private clearPresenceCookie() {
    if (typeof document !== 'undefined') {
      document.cookie = `${LOGGED_IN_COOKIE}=; Max-Age=0; Path=/; SameSite=Strict`
    }
  }

  login(params: { account: string, password: string, isKeep: boolean, trustDevice?: boolean }) {
    const { isKeep, trustDevice, ...credentials } = params
    // `client` is the device platform (badge in the device list); the token's lifetime is driven by
    // `trusted`, not `client`. `trusted`: the native app is always trusted (its token lives in OS secure
    // storage); a desktop is trusted only on explicit opt-in (OS keyring); web can never be trusted.
    // `persistent` maps "keep me logged in" to the cookie lifetime on the pure-httpOnly browser path.
    const client = this.resolveClient()
    const trusted = client === 'app' || (client === 'desktop' && trustDevice === true)
    return this.http.post<LoginRes>(
      `${apiPrefix()}/auth/login`, {
        ...credentials,
        client,
        device: this.getDeviceLabel(),
        persistent: isKeep,
        trusted,
      }).pipe(tap((res) => {
        if (res.code === 0 && res.data?.session_token) {
          this.activateSession(res.data.session_token, { isKeep, trusted })
        }
      }))
  }

  /** One-time-code (admin-issued) login → a session whose lifetime follows the platform's trust: a trusted
   *  native client (app/desktop) keeps a permanent session (token in OS secure storage); the browser gets a
   *  14-day sliding one. `client` is sent so the backend issues the matching session kind. */
  otpLogin(params: { account: string, code: string, device?: string }) {
    const client = sessionClient();
    return this.http.post<LoginRes>(
      `${apiPrefix()}/auth/otp/login`, {
        account: params.account,
        code: params.code,
        client,
        device: params.device ?? this.getDeviceLabel(),
      }).pipe(tap((res) => {
        if (res.code === 0 && res.data?.session_token) {
          this.activateSession(res.data.session_token, { isKeep: true, trusted: client !== 'web' })
        }
      }))
  }

  /** QR-login: a client mints a sign-in token to render as a QR. `client` is the real platform
   *  ('app'/'web'/'desktop' — see {@link sessionClient}); `trusted` opts a desktop into a permanent session
   *  (its token kept in OS keyring), is implicit-true for 'app', and ignored for 'web' (never trusted). */
  qrCreate(client: 'app' | 'web' | 'desktop', trusted = false) {
    return this.http.post<{ code: number, data?: { qrToken: string, expiresAt: number } }>(
      `${apiPrefix()}/auth/qr/create`, { client, trusted },
    )
  }

  /** QR-login: poll the sign-in token's status. On 'confirmed' the response carries the session token,
   *  which activates a permanent session (if `trusted` was chosen at create) or a 14-day sliding one. */
  qrPoll(qrToken: string, device?: string, trusted = false) {
    return this.http.post<{ code: number, data?: { status: string, session_token?: string, mustChangePassword?: boolean } }>(
      `${apiPrefix()}/auth/qr/poll`, { qrToken, device: device ?? this.getDeviceLabel() },
    ).pipe(tap((res) => {
      if (res.code === 0 && res.data?.session_token) {
        this.activateSession(res.data.session_token, { isKeep: true, trusted })
      }
    }))
  }

  /** QR-login: the phone (already logged in) scans a desktop QR → marks it 'scanned'. Authenticated. */
  qrScan(qrToken: string) {
    return this.http.post<{ code: number }>(`${apiPrefix()}/auth/qr/scan`, { qrToken })
  }

  /** QR-login: the phone confirms a scanned QR → the desktop's next poll receives its session. Authenticated. */
  qrConfirm(qrToken: string) {
    return this.http.post<{ code: number }>(`${apiPrefix()}/auth/qr/confirm`, { qrToken })
  }

  /** Activate a freshly obtained session token (login/OTP/QR success). Persists it to OS secure storage
   *  (Android EncryptedSharedPreferences / desktop keyring) when trusted, sets the in-memory copy + media
   *  proxy, and fires the push + web-push login hooks. Extracted so the password, OTP, and QR login paths
   *  activate identically. */
  private activateSession(token: string, opts: { isKeep: boolean, trusted: boolean }) {
    this._isKeep = opts.isKeep
    this._trusted = opts.trusted
    if (opts.isKeep) localStorage.setItem(IS_KEEP_LOGIN, '1')
    else localStorage.removeItem(IS_KEEP_LOGIN)
    if (isTauri()) this.setSessionToken(token)
    // Browser (pure httpOnly): the backend set the httpOnly session cookie + presence cookie; no token is
    // held in JS.
    this.loggedIn.set(true)
    this.push.onLogin()
    void this.webPush.onLogin()
  }

  /** Drop the session and route to login. The kick `reason` (e.g. 'device_revoke', 'all_devices') is
   *  accepted for call-site compatibility with the realtime transport's FORCE_LOGOUT handler but no longer
   *  maps to a tailored login notice (the one-app-session 'app_session_replaced' notice was removed when
   *  multiple trusted devices became allowed); the login page itself signals the session ended. */
  redoLoginAuth(_reason?: string) {
    void this.clearToken()
    this.routeService.redirect(RoutePage.AUTH_LOGIN)
  }

  /** Activate a freshly obtained session token (login/restore): set the in-memory copy (synchronous, so
   *  the interceptor + SSE worker can use it at once), then persist to the platform's OS secure storage
   *  when trusted. No persistent plaintext copy is ever written (no localStorage/sessionStorage of the
   *  token). */
  private setSessionToken(token: string) {
    this._sessionToken = token
    this._sessionTokenSub.next(token)
    if (isAndroidNative()) {
      // Android: the app is always trusted — persist to EncryptedSharedPreferences (the store the native
      // RealtimeService/FCM/Worker read) via the SomsFcm bridge.
      this._trusted = true
      window.SomsFcm!.setSessionToken(token)
    } else if (isTauri()) {
      // Desktop: persist to the OS keyring when the session should survive a restart — "keep me logged in"
      // (isKeep) OR a trusted (permanent) token. `isKeep` controls WHETHER it's stored; `trusted` (sent at
      // login) controls HOW LONG the server keeps it. The two are decoupled so e.g. the register flow
      // (isKeep:true, untrusted) persists a sliding token, while a desktop login with trust unchecked stays
      // memory-only (the "shared computer" contract). The Rust media proxy gets an in-memory copy regardless
      // so /uploads/* carry the Bearer header. Fire-and-forget — the in-memory copy above is already live.
      if (this._isKeep || this._trusted) {
        tauriInvoke('secure_set_token', { token }).catch(() => {
          if (this._trusted) {
            // A trusted (permanent) token couldn't be persisted to the keyring. Revoke it server-side so no
            // orphan permanent row survives (it would live forever, only removable from the device page),
            // then bounce to login with a notice — the user re-signs in (the accepted cost of zero orphans).
            void this.revokeAndBounce(token, 'auth.notice.trustPersistFailed')
          } else {
            // Keep-only (sliding) token: it's valid in-memory for THIS session and self-expires server-side
            // in 14d, so there's no permanent orphan and no reason to revoke or bounce. But the keyring write
            // failed, so the token is memory-only — the next restart finds nothing and the user must re-login.
            // Warn them now. (Do NOT advise enabling "Trust this device": the keyring is the broken piece, so
            // a trusted write would ALSO fail and take the revoke+bounce path above — strictly worse. The token
            // is never downgraded to plaintext storage.)
            this.toast.warn(this.t('auth.notice.keepPersistFailed'))
          }
        })
      }
      tauriInvoke('set_session_token', { token }).catch(() => {})
    }
    // Browser (pure httpOnly): no JS token storage — the backend holds the credential in the cookie.
  }

  /** Re-establish the session on a cold start by reading the token back from OS secure storage (Android
   *  EncryptedSharedPreferences via the SomsFcm bridge; desktop OS keyring via the `secure_*` commands).
   *  Wired as an APP_INITIALIZER so it completes before the router resolves — `isLoggedIn()` and the
   *  interceptor then see the restored token with no race. No-op on the pure-httpOnly browser build (the
   *  cookie carries the session; there is no JS token to restore). Also purges any legacy plaintext
   *  `session_token` left in localStorage by an older desktop build (now stored in the keyring instead). */
  async restoreSession(): Promise<void> {
    try { localStorage.removeItem(SESSION_TOKEN) } catch { /* storage unavailable */ }
    if (isAndroidNative()) {
      try {
        this._canTrust = true // EncryptedSharedPreferences is always available on Android
        const t = window.SomsFcm!.getSessionToken() // synchronous JNI
        if (t) this.setRestored(t)
      } catch {
        // SomsFcm bridge missing (shell wiring bug / renderer reclaimed before the @JavascriptInterface
        // registered). Stay logged out + canTrust false rather than reject the APP_INITIALIZER — a rejection
        // aborts bootstrap → a blank webview with no recovery path.
        this._canTrust = false
      }
    } else if (isTauri()) {
      try {
        const t = await tauriInvoke<string | null>('secure_get_token')
        this._canTrust = true // keyring reachable → this desktop CAN be trusted (the boot probe)
        if (t) this.setRestored(t)
      } catch {
        // Keyring unavailable (e.g. headless Linux without Secret Service): this desktop CANNOT be
        // trusted → the trust toggle stays hidden, so the user can't request a permanent token the client
        // then can't persist (which would orphan a server-side permanent session).
        this._canTrust = false
      }
    }
    // Browser: _canTrust stays false (web can never be trusted).
  }

  /** Apply a token restored from secure storage: in-memory copy + media proxy. A restored token is by
   *  definition durable/trusted (it came from the keyring / EncryptedSharedPreferences). */
  private setRestored(token: string) {
    this._sessionToken = token
    this._trusted = true
    this._isKeep = true
    this._sessionTokenSub.next(token)
    this.loggedIn.set(true)
    if (isAndroidNative()) window.SomsFcm!.setSessionToken(token)
    else if (isTauri()) tauriInvoke('set_session_token', { token }).catch(() => {})
  }

  /** Revoke the just-issued session server-side (POST /auth/logout carries the raw token → the backend
   *  revokes its hash) and bounce to the login page, surfacing the reason as a global toast. Used when a
   *  trusted (permanent) token couldn't be persisted to the keyring: revoking eliminates the orphan permanent
   *  row (it would otherwise live forever); the toast tells the user why they're back at the sign-in screen.
   *  The toast is routing-independent, so it shows even though the bounce redirects away from the current
   *  route (the old per-page notice signal was dropped when the login page redirected under APP_OTP_AND_QR). */
  private async revokeAndBounce(token: string, noticeKey: string): Promise<void> {
    try {
      await firstValueFrom(this.http.post<{ code: number }>(`${apiPrefix()}/auth/logout`, { sessionToken: token }))
    } catch { /* best-effort: if the revoke itself fails, the row is still revocable from the device page */ }
    this.toast.warn(this.t(noticeKey), IMPORTANT_NOTICE_MS)
    void this.clearToken()
    this.userService.clearSession()
    this.routeService.redirect(RoutePage.AUTH_LOGIN)
  }

  /** Clear local session state + the native secure-store token. The local in-memory state is cleared
   *  synchronously (before the native clear resolves) so isLoggedIn() flips at once. Returns whether the
   *  NATIVE clear succeeded (browser: always true — no JS-side store; native: false if the keyring/bridge
   *  delete failed, e.g. the keyring was locked) — logout() surfaces a notice when this is false.
   *
   *  Residual (accepted, no retry): if the native clear fails the token stays in the OS store; on the next
   *  boot restoreSession rehydrates a token the SERVER has already revoked → a brief authenticated flash
   *  until the first request 401s → redoLoginAuth self-corrects. The token is server-revoked by /auth/logout
   *  regardless, so this is a transient UX flash, not a security issue. */
  async clearToken(): Promise<boolean> {
    this._sessionToken = null
    this._trusted = false
    this.loggedIn.set(false)
    let nativeOk = true
    if (isAndroidNative()) {
      try { window.SomsFcm!.setSessionToken(null) } catch { nativeOk = false } // clears EncryptedSharedPreferences
    } else if (isTauri()) {
      // Clear the persistent keyring + the in-memory media proxy independently — a locked keyring must not
      // skip the proxy clear. nativeOk tracks the persistent keyring (the failure that leaves a stale token).
      try { await tauriInvoke('secure_clear_token') } catch { nativeOk = false } // idempotent: NoEntry → Ok
      try { await tauriInvoke('clear_session_token') } catch { /* media-proxy in-memory copy */ }
    } else {
      this.clearPresenceCookie()
    }
    this._sessionTokenSub.next(null)
    return nativeOk
  }

  logout() {
    if (!this.isLoggedIn()) return EMPTY
    // Native: unregister push BEFORE clearing the token, so DELETE /devices/register still carries the
    // credential (the interceptor injects it from _sessionToken). Best-effort — a stale token is pruned
    // server-side on the next send anyway. Browser: push/webpush are no-ops in the shell.
    this.push.unregister()
    void this.webPush.unregister()
    // Capture the raw token before clearing (native only — null on browser, where the backend resolves
    // the session from the httpOnly cookie).
    const sessionToken = this._sessionToken
    // clearToken's local-state clear is synchronous (isLoggedIn flips at once); the .then fires once the
    // native keyring/bridge clear resolves. If it failed (keyring locked) the OS store may still hold the
    // token → tell the user (the next boot could briefly re-restore it; it self-corrects via 401). No retry:
    // /auth/logout below revokes the token server-side regardless.
    this.clearToken().then((nativeOk) => {
      if (!nativeOk) this.toast.warn(this.t('auth.notice.logoutClearFailed'), IMPORTANT_NOTICE_MS)
    })
    // Drop the in-memory session → UserService's lifecycle effect closes + deletes this user's DB.
    this.userService.clearSession()
    return this.http.post<LogoutRes>(
      `${apiPrefix()}/auth/logout`,
      sessionToken ? { sessionToken } : {},
    )
  }

  /** Change password: the server invalidates ALL sessions (`invalidateAllSessions` revokes every session
   *  token row + bumps tokenVersion) and returns a legacy access/refresh pair — but NO new session token.
   *  The current device's session token is dead, so drop it + re-login for a fresh one. (Online clients
   *  also receive a FORCE_LOGOUT frame, whose handler calls redoLoginAuth too — this is the immediate
   *  path for the device that initiated the change.) */
  changePassword(params: { oldPassword: string, newPassword: string }) {
    return this.http.post<LogoutRes>(
      `${apiPrefix()}/auth/change-password`, params
    ).pipe(tap((res) => {
      if (res.code === 0) this.redoLoginAuth()
    }))
  }

  /** Set the user's OWN password — the forced first-time set right after an admin-generated initial
   *  password. The backend clears `mustChangePassword` and KEEPS this session (no sessions are invalidated,
   *  unlike {@link changePassword}); the caller is already session-authenticated, so no old password is
   *  sent. On success the app unlocks — the caller routes to HOME. */
  setPassword(newPassword: string) {
    return this.http.post<{ code: number, message: string }>(
      `${apiPrefix()}/auth/set-password`, { newPassword },
    )
  }

  /** List the current user's active sessions. Every request carries the session token (the interceptor),
   *  so the server can flag the requesting row `isCurrent`. */
  getSessions() {
    return this.http.post<{ code: number, message: string, data?: SessionInfo[] }>(
      `${apiPrefix()}/auth/sessions`, {},
    )
  }

  /** Revoke a single session by its device-list row id. Ownership is verified server-side. */
  revokeSession(id: number) {
    return this.http.post<{ code: number, message: string }>(
      `${apiPrefix()}/auth/revoke-session`, { id },
    )
  }

  /** Client kind for the session-token lifetime policy + the device-list badge: the Android Tauri shell is
   *  'app' (no-expiry, native secure store), the desktop Tauri shell is 'desktop', the browser is 'web'. */
  private resolveClient(): SessionClient {
    if (isAndroidNative()) return 'app'
    if (isTauri()) return 'desktop'
    return 'web'
  }

  /** Human-readable label for this device/browser, sent on login so the Active-sessions list shows a
   *  recognizable name instead of an opaque uuid. Best-effort navigator.userAgent parse (dependency-free);
   *  stable per device so re-login keeps the same label. */
  private getDeviceLabel(): string {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
    const os =
      /Windows NT/i.test(ua) ? 'Windows'
        : /iPhone|iPad|iPod|iOS/i.test(ua) ? 'iOS'
          : /Mac OS X/i.test(ua) ? 'macOS'
            : /Android/i.test(ua) ? 'Android'
              : /CrOS/i.test(ua) ? 'ChromeOS'
                : /Linux/i.test(ua) ? 'Linux'
                  : (typeof navigator !== 'undefined' && navigator.platform) || 'Unknown'
    if (isAndroidNative()) return 'Android'        // native app — the OS is the device identity
    if (isTauri()) return `Desktop · ${os}`         // Tauri desktop shell
    const browser =
      /Edg\//i.test(ua) ? 'Edge'
        : /OPR\//i.test(ua) ? 'Opera'
          : /Chrome\//i.test(ua) ? 'Chrome'
            : /Firefox\//i.test(ua) ? 'Firefox'
              : /Safari\//i.test(ua) ? 'Safari'
                : 'Browser'
    return `${browser} · ${os}`
  }
}

/** The client kind, selecting the session-token lifetime policy server-side and shown as a badge in the
 *  device list. Mirrors the backend LoginDto.client union. */
export type SessionClient = 'app' | 'web' | 'desktop';

/** One row of GET /auth/sessions — the active-session credential behind the "Devices" settings page.
 *  Dates arrive as ISO strings (Prisma DateTime over the wire); `expiresAt` is null for trusted (permanent)
 *  devices. `trusted` flags a device whose token lives in OS secure storage. `isCurrent` is server-stamped
 *  against the requesting session token. */
export interface SessionInfo {
  id: number;
  client: SessionClient;
  device: string | null;
  userAgent: string | null;
  ip: string | null;
  lastSeenIp: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string | null;
  trusted: boolean;
  isCurrent: boolean;
}
