/**
 * Runtime detection + URL rewriting for the Tauri desktop shell.
 *
 * The Angular app is built once and runs in two contexts:
 *  - Browser: served same-origin by NestJS; all URLs relative; media authenticated by the
 *    httpOnly `media_token` cookie set on login.
 *  - Tauri desktop webview: loaded from local assets at a non-HTTP origin (tauri://localhost on
 *    macOS, https://tauri.localhost on Windows, http://tauri.localhost on Linux). The shell
 *    injects `window.__SOMS_API_ORIGIN__` (the absolute backend origin) via an initialization
 *    script that runs before any page script, so API/SSE URLs resolve cross-origin. Media can't
 *    use the cookie (SameSite=Strict suppresses it cross-origin) and a bare `<img src>` / CSS
 *    `url()` can't carry an Authorization header, so `/uploads/*` is rewritten to a
 *    `media://localhost` custom URI scheme handled by a Rust-side proxy that injects the header.
 *
 * Browser behavior is bit-for-bit unchanged when the globals are absent: every helper falls back
 * to the same-origin relative path.
 */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __SOMS_API_ORIGIN__?: string;
    /** Exposed by Tauri v2 when `app.withGlobalTauri` is true (see src-tauri/tauri.conf.json). Used
     *  instead of the `@tauri-apps/api` npm package so the browser build has zero extra deps and the
     *  Tauri surface is unreachable outside the shell. */
    __TAURI__?: {
      core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
      /** The tauri-plugin-notification surface (registered in src-tauri/src/lib.rs). Used by
       *  UnreadAttentionService to post desktop system notifications when a message arrives while the
       *  window is unfocused. Present on desktop; on Android the path is dormant (SSE is disconnected
       *  when backgrounded, so no NEW_MESSAGE fires while unfocused). */
      notification?: { sendNotification: (n: { title: string; body?: string }) => Promise<void> | void };
    };
    /** FCM bridge injected by the Android shell (SomsMessagingService / MainActivity). `SomsFcm` is a
     *  Kotlin `@JavascriptInterface` exposing the current FCM token + permission request. The two hooks
     *  are how Kotlin pushes the token (rotation) and a notification-tap deep link (warm start) into JS.
     *  `__SOMS_PENDING_THREAD_ID__` is the cold-start fallback: Kotlin sets it before Angular boots, so
     *  PushService.init() can recover a deep link that arrived before the live handler was registered.
     *  All absent in the browser build — guarded by isTauri() at every use. */
    SomsFcm?: {
      getToken: () => string | null;
      requestToken: () => void;
      requestNotificationPermission: () => void;
      /** Push the scoped notification token (POST /auth/notification-token) into Android encrypted
       *  storage so the WorkManager poller can authenticate /notifications/missed while the WebView is
       *  suspended. Pass null/empty on logout to clear. Android-only. */
      setNotificationToken: (token: string | null) => void;
      /** Push the resolved backend origin into Android storage — the poller can't read window globals
       *  (no WebView alive when it fires). Android-only. */
      setApiOrigin: (origin: string | null) => void;
      /** Read whether the 6-hour background-sync poller is enabled (stored in EncryptedSharedPreferences
       *  so the WorkManager worker can read it with no WebView alive). Defaults to true. Android-only;
       *  absent in the browser/desktop builds (guarded by isTauri() && isAndroid()). */
      getPollingEnabled: () => boolean;
      /** Enable/disable the 6-hour background-sync poller: persists the pref into EncryptedSharedPreferences
       *  AND cancels / re-enqueues the WorkManager schedule. Android-only. */
      setPollingEnabled: (enabled: boolean) => void;
      /** Whether the dataSync foreground service (MessageSyncService) is enabled (default false). Android-only. */
      getForegroundServiceEnabled: () => boolean;
      /** Enable/disable the foreground service: persists the pref AND starts/stops the service to match. Android-only. */
      setForegroundServiceEnabled: (enabled: boolean) => void;
      /** Next scheduled WorkManager poll time (epoch ms), or -1 if not scheduled. For the Settings display. Android-only. */
      getNextPullTime: () => number;
      /** FCM status snapshot as a JSON string `{"hasToken":boolean,"lastCheck":number}`. `hasToken` is the
       *  proxy for "FCM available" (a token was obtained → Google Play Services present). Android-only. */
      getFcmStatus: () => string;
      /** Manual FCM availability check — force a token fetch + refresh lastCheck, bypassing the daily gate. Android-only. */
      requestFcmCheck: () => void;
    };
    __SOMS_FCM_TOKEN__?: (token: string) => void;
    __SOMS_DEEP_LINK__?: (threadId: string) => void;
    __SOMS_PENDING_THREAD_ID__?: string;
  }
}

/** True when running inside the Tauri desktop webview. Detected via the IPC global Tauri injects
 *  before page scripts run — no SDK import needed. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;
}

/** True when the current Tauri shell is the Android APK (vs the desktop build). Used to gate the
 *  "disconnect SSE on background" rule — mobile Android should close the stream gracefully (the OS will
 *  kill it anyway), while PC/desktop keeps it alive. UA-based: the Android WebView UA carries "Android". */
export function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}

/** Invoke a Tauri command (only meaningful when `isTauri()`). Resolves the command's return value;
 *  rejects if not in Tauri or the command errors. Callers MUST guard with `isTauri()` and swallow
 *  errors for non-critical handoffs (e.g. token sync to the media proxy). */
export function tauriInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = typeof window !== 'undefined' ? window.__TAURI__?.core?.invoke : undefined;
  if (!invoke) return Promise.reject(new Error('not in Tauri'));
  return invoke(cmd, args) as Promise<T>;
}

/** Absolute backend origin for cross-origin clients (Tauri shell), or `''` for same-origin
 *  (browser). Read once at module load; the Tauri initialization script runs before any module is
 *  evaluated, so this is always populated under Tauri and always empty in the browser. */
const API_ORIGIN: string =
  typeof window !== 'undefined' && typeof window.__SOMS_API_ORIGIN__ === 'string'
    ? window.__SOMS_API_ORIGIN__
    : '';

export { API_ORIGIN as apiOrigin };

/** Custom URI scheme the Tauri Rust side registers (see `src-tauri/src/lib.rs`) to proxy
 *  `/uploads/*` media with a Bearer header. */
export const MEDIA_SCHEME = 'media';
const MEDIA_HOST = 'localhost';

/**
 * Rewrite a server-relative media URL for the current runtime.
 *  - Browser → the bare path (same-origin; the httpOnly `media_token` cookie authenticates it).
 *  - Tauri   → `media://localhost<path>`, served by the Rust URI-scheme proxy, which forwards to
 *              `${apiOrigin}${path}` with `Authorization: Bearer` (the cookie can't cross origins
 *              and a bare `<img src>`/CSS `url()` can't set headers).
 * Already-absolute URLs (`data:`, `blob:`, `http:`, `https:`) pass through unchanged.
 */
export function assetUrl(path: string | null | undefined): string {
  if (!path) return '';
  if (!path.startsWith('/')) return path; // absolute (data:/blob:/http(s):) — leave as-is
  if (!isTauri()) return path;
  return `${MEDIA_SCHEME}://${MEDIA_HOST}${path}`;
}

/** True when the resolved backend origin is a loopback localhost URL. Under Tauri this means "no real
 *  server configured yet": the bundled APK ships with the `http://localhost:3000` default, which is
 *  unreachable from a phone, so the app gates first-run on this to force the server-config page before
 *  login. `tauri dev` (SOMS_API_ORIGIN set to a real host) and a persisted real origin both read as
 *  non-localhost → skip the gate. */
export function apiOriginIsLocalhost(): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(API_ORIGIN);
}

/**
 * Persist a new backend origin (Tauri only). Rust validates it is a clean http(s) URL, writes it to a
 * config file in the app-data dir (so it survives restarts and is injected before Angular boots on the
 * next launch), and updates the media proxy's live origin. Returns the normalized origin Rust stored.
 *
 * Because `apiOrigin` is captured once at module load (`constants.ts` → `apiPrefix`/`sseUrl`), the
 * caller MUST `location.reload()` after this resolves so every HTTP/SSE/media URL re-resolves against
 * the new origin — hot-swapping in-flight would leave the SSE worker and the HTTP interceptors pinned
 * to the old origin.
 */
export async function setApiOrigin(url: string): Promise<string> {
  if (!isTauri()) throw new Error('setApiOrigin is only available under the Tauri shell');
  return tauriInvoke<string>('set_api_origin', { url });
}
