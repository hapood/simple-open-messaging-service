/**
 * Runtime detection + URL rewriting for the Tauri desktop shell.
 *
 * The Angular app is built once and runs in two contexts:
 *  - Browser: served same-origin by NestJS; all URLs relative; media authenticated by the
 *    httpOnly `media_token` cookie set on login.
 *  - Tauri desktop webview: loaded from local assets at a non-HTTP origin (tauri://localhost on
 *    macOS, https://tauri.localhost on Windows, http://tauri.localhost on Linux). The backend origin
 *    is read from the platform persistence surface — the native `window.SomsSecureStore`
 *    (@JavascriptInterface, EncryptedSharedPreferences) on Android, a localStorage shim on desktop —
 *    at seed time, so API/SSE URLs resolve cross-origin. Media can't
 *    use the cookie (SameSite=Strict suppresses it cross-origin) and a bare `<img src>` / CSS
 *    `url()` can't carry an Authorization header, so `/uploads/*` is rewritten to a
 *    `media://localhost` custom URI scheme handled by a Rust-side proxy that injects the header.
 *
 * Browser behavior is bit-for-bit unchanged when the globals are absent: every helper falls back
 * to the same-origin relative path.
 */

import { signal } from '@angular/core';

/**
 * The persistence surface for state that must survive WebView/renderer death and be readable with no
 * page alive (the backend origin today; the session token once the native-realtime rewrite lands).
 *  - Android: a Kotlin `@JavascriptInterface` (`window.SomsSecureStore`) backed by
 *    EncryptedSharedPreferences — the SAME store the native SSE (MessageSyncService / RealtimeService)
 *    reads, so the web and the native realtime layer can never disagree on the host.
 *  - Desktop / browser: `window.SomsSecureStore` is absent, so the web substitutes a JS shim over
 *    localStorage (see `secureStore` below). The web talks to this single interface regardless of
 *    platform — no isAndroid() branching at the call sites.
 */
interface SomsSecureStore {
  getApiOrigin(): string | null
  setApiOrigin(origin: string | null): void
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    /** Native (Android) persistence surface (EncryptedSharedPreferences); absent on desktop/browser,
     *  where the web substitutes a localStorage shim. See `SomsSecureStore` + `secureStore`. */
    SomsSecureStore?: SomsSecureStore;
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
    /** Android hardware-back hook: Kotlin's `OnBackPressedCallback` evals this on the webview. The handler
     *  peels one navigation layer via NavStateMachineService.back(); if nothing is left to peel it calls
     *  `SomsBack.exit()` (a Kotlin @JavascriptInterface) so the activity finishes. Absent on browser +
     *  desktop Tauri (browser-back naturally exits the flat history there). See NavStateMachineService. */
    __SOMS_BACK__?: () => void;
    /** Kotlin `@JavascriptInterface` exposed by the Android shell: finishes the activity (clean app exit)
     *  when NavStateMachineService.back() has nothing left to peel. Android-only. */
    SomsBack?: { exit: () => void };
    /** Kotlin `@JavascriptInterface` (MainActivity.SomsShellInterface): returns the per-device status-bar
     *  / gesture-bar insets as JSON `{"top":int,"bottom":int}` (CSS px). Android WebView is edge-to-edge
     *  but env(safe-area-inset-*) returns 0, so this is the only source of --soms-safe-top. Read once in
     *  main.ts before bootstrap for a FOUC-free first paint. Absent in browser/desktop. `getImeHeight()`
     *  (the current soft-keyboard height in CSS px, 0 when closed) lets the web seed the value at boot; the
     *  live source is {@link __SOMS_IME_HEIGHT__}. */
    SomsShell?: { getSafeInsets: () => string; getImeHeight?: () => number };
    /** Kotlin→JS push (`MainActivity.pushImeHeight`): native calls this with the current IME (keyboard)
     *  height in CSS px on every keyboard open/close and per animation frame on API 30+. Installed before
     *  bootstrap by `installKeyboardInsetBridge()`; drives `KeyboardInsetService.inset`, which
     *  `KbdOffsetDirective` reads on Android. Absent in browser/desktop (never called there). Follows the
     *  `__SOMS_<NAME>__` bridge-hook convention. */
    __SOMS_IME_HEIGHT__?: (px: number) => void;
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

/** Canonicalize a backend origin: trim and strip trailing slash(es) so it is a safe path-concatenation
 *  base. A trailing slash turns `${apiOrigin()}/api/v1` into `${apiOrigin()}//api/v1`, which Fastify
 *  404s — and users DO type a trailing slash in the server-config form. Mirrors the Rust
 *  `validate_origin` strip; applied at the seed so the signal is canonical regardless of what was typed
 *  or what an older build persisted. */
export function canonicalOrigin(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/** The concrete persistence surface: the native `@JavascriptInterface` on Android, or a localStorage
 *  shim on desktop/browser. Resolved once at module load — `window.SomsSecureStore` is injected before
 *  any page script by the Android shell (same window as the other @JavascriptInterface surfaces), so the
 *  native store is available synchronously at seed time, with no async and no race. */
const secureStore: SomsSecureStore =
  typeof window !== 'undefined' && window.SomsSecureStore
    ? window.SomsSecureStore
    : {
        getApiOrigin: () => {
          try { return localStorage.getItem('api_origin') } catch { return null }
        },
        setApiOrigin: (o) => {
          try {
            if (o) localStorage.setItem('api_origin', o)
            else localStorage.removeItem('api_origin')
          } catch { /* storage unavailable — best-effort */ }
        },
      }

/** Absolute backend origin for cross-origin clients (Tauri shell), or `''` for same-origin (browser) /
 *  not-yet-configured (Tauri first run). A LIVE writable signal — the single source of truth for where
 *  the data layer points. Seeded from the persisted store (`secureStore`), NOT from a frozen init-script
 *  global, so a renderer-reclaim reload after a server-config change re-reads the live value instead of
 *  a stale snapshot. `''` (not a localhost default) means "no server configured yet"; the server-config
 *  form pre-fills a placeholder. Read via `apiOrigin()`; only `setApiOrigin` writes it. */
export const apiOrigin = signal<string>(canonicalOrigin(secureStore.getApiOrigin() ?? ''));

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

/** True when no backend origin is configured yet (the signal is empty). Under Tauri the app gates
 *  first-run on this to force the server-config page before login; the form pre-fills a placeholder
 *  origin for the user to edit. Once `setApiOrigin` persists a real origin this reads false. The browser
 *  build is same-origin (`''`) but never hits this gate — the guard requires `isTauri()`. */
export function apiOriginIsEmpty(): boolean {
  return apiOrigin() === '';
}

/**
 * Persist a new backend origin and repoint the live data layer to it (Tauri only). Rust validates +
 * canonicalizes the URL, writes the app-data config file, AND updates the media proxy's live Arc (so
 * `/uploads/*` immediately uses the new host); here we persist the same value into the platform store
 * (Android EncryptedSharedPreferences via `window.SomsSecureStore`, localStorage on desktop) — the same
 * store the native SSE reads — and mirror it into the {@link apiOrigin} signal so every in-process
 * consumer (HttpClient via `apiPrefix()`, the SSE worker's reconnect, the guest guard, the Settings
 * label) picks up the new host at once, with NO page reload. Returns the canonical origin Rust stored.
 */
export async function setApiOrigin(url: string): Promise<string> {
  if (!isTauri()) throw new Error('setApiOrigin is only available under the Tauri shell');
  const normalized = await tauriInvoke<string>('set_api_origin', { url });
  apiOrigin.set(normalized);
  secureStore.setApiOrigin(normalized);
  return normalized;
}

/**
 * Apply the native system-bar insets to :root as --soms-safe-top / --soms-safe-bottom, so the auth shell
 * and the app shell can pad content below the status bar (Android WebView is edge-to-edge and
 * env(safe-area-inset-*) returns 0 there). Reads SomsShell.getSafeInsets() — the Kotlin @JavascriptInterface
 * — synchronously; MUST run before bootstrapApplication() so the first paint already has the insets
 * (FOUC-free). No-op in the browser build (no SomsShell): the CSS default env() applies there.
 */
export function applySafeInsets(): void {
  if (typeof window === 'undefined' || !window.SomsShell) return;
  try {
    const { top, bottom } = JSON.parse(window.SomsShell.getSafeInsets()) as { top: number; bottom: number };
    const root = document.documentElement;
    root.style.setProperty('--soms-safe-top', `${top}px`);
    root.style.setProperty('--soms-safe-bottom', `${bottom}px`);
  } catch {
    // SomsShell present but the call failed — leave the CSS default (env(), 0 on Android).
  }
}
