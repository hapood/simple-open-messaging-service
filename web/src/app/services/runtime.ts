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
 *    at seed time, so API/SSE URLs resolve cross-origin. The backend's httpOnly `media_token` cookie is
 *    SameSite=Strict (so the webview can't auto-attach it cross-origin) and a bare `<img src>` / CSS
 *    `url()` can't carry an Authorization header anyway, so `/uploads/*` is rewritten to a
 *    `media://localhost` custom URI scheme handled by a Rust-side proxy that injects the Bearer header.
 *
 * Browser behavior is bit-for-bit unchanged when the globals are absent: every helper falls back
 * to the same-origin relative path.
 */

import { signal } from '@angular/core';

/**
 * The persistence surface for state that must survive WebView/renderer death and be readable with no
 * page alive (the backend origin today; the session token once the native-realtime rewrite lands).
 *  - Android: a Kotlin `@JavascriptInterface` (`window.SomsSecureStore`) backed by
 *    EncryptedSharedPreferences — the SAME store the native SSE (RealtimeService)
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
      /** The event surface (withGlobalTauri): emit an event the Rust side listens for. The SPA emits
       *  `spa-ready` after its first paint so Rust can show the main window + close the init window
       *  (the two-window handoff in src-tauri/src/lib.rs handoff_to_spa). */
      event?: { emit: (event: string, payload?: unknown) => Promise<void> | void };
      /** The tauri-plugin-notification surface (registered in src-tauri/src/lib.rs), used by the DESKTOP
       *  NotificationAdapter (pc/mac/linux). `identifier` is the replace-by-id param — posting with the same
       *  identifier replaces the prior notification. Desktop-only: Android has its own Kotlin `SomsNotify`
       *  bridge (the Tauri notification plugin is deliberately not used on Android). */
      notification?: { sendNotification: (n: { title: string; body?: string; identifier?: string }) => Promise<void> | void };
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
      /** Push the session token (POST /auth/login, app client) into Android encrypted storage so the
       *  native RealtimeService can authenticate /events and the background fetchers (FCM/WorkManager) can
       *  authenticate /notifications/missed while the WebView is suspended. Pass null/empty on logout to
       *  clear (and stop the native stream). Android-only. */
      setSessionToken: (token: string | null) => void;
      /** Synchronous read of the persisted session token from EncryptedSharedPreferences (the same store
       *  setSessionToken writes + the native RealtimeService reads). AuthService.restoreSession uses it to
       *  re-establish the session on a cold start with NO plaintext copy in JS storage. Returns null when
       *  no token is stored (logged out / first run). Android-only. */
      getSessionToken: () => string | null;
      /** Synchronous read of the RealtimeService's last-pushed connection state
       *  ('connecting'|'open'|'reconnecting'|'closed'), so a freshly-booted WebView can seed its
       *  connection-state signal before the next state transition. Android-only. */
      getConnState: () => string;
      /** Read whether the 6-hour background-sync poller is enabled (stored in EncryptedSharedPreferences
       *  so the WorkManager worker can read it with no WebView alive). Defaults to true. Android-only;
       *  absent in the browser/desktop builds (guarded by isTauri() && isAndroid()). */
      getPollingEnabled: () => boolean;
      /** Enable/disable the 6-hour background-sync poller: persists the pref into EncryptedSharedPreferences
       *  AND cancels / re-enqueues the WorkManager schedule. Android-only. */
      setPollingEnabled: (enabled: boolean) => void;
      /** Whether the dataSync foreground service (RealtimeService) is enabled (default false). Android-only. */
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
    /** Kotlin `@JavascriptInterface` (MainActivity, registered alongside SomsFcm/SomsShell/SomsBack): exposes the
     *  Android NATIVE notification method's parameters to JS. `show(text, replace)` posts on CHANNEL_MESSAGES at
     *  the stable AWAY_NOTIF_ID when `replace` is true (replace-by-id), else a fresh id; `clear` cancels it. The
     *  AndroidNotificationAdapter wraps this — it maps the unified `merge` param onto `replace` (smoothing the
     *  platform difference into one JS adapter function). Android-only; guaranteed present after the
     *  isAndroidNative() gate, so call sites use `!`. */
    SomsNotify?: { show: (text: string, replace: boolean) => void; clear: () => void };
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
    /** Kotlin→JS push (RealtimeService.forwardToJs): one `/events` frame forwarded from the native-owned
     *  SSE, so the Android WebView consumes realtime without opening its own worker. Installed by the
     *  NativeEventTransport; absent on browser/desktop (where the WebsocketService spawns sse.worker.ts).
     *  Kotlin guards the call (`window.__SOMS_EVENT__ && …`), so frames arriving before the transport
     *  installs the hook are silently dropped and recovered by the app-open HWM catch-up. */
    __SOMS_EVENT__?: (type: string, data: any) => void;
    /** Kotlin→JS push (RealtimeService.pushConnState): a connection-state transition
     *  ('connecting'|'open'|'reconnecting'|'closed') of the native /events stream, so the ConnectionBanner
     *  reflects the Kotlin-owned connection. Installed by the NativeEventTransport; the current value is
     *  also readable synchronously via `SomsFcm.getConnState()` (Kotlin only pushes on transitions). */
    __SOMS_CONN_STATE__?: (state: string) => void;
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

/** True when running in the Android Tauri shell — the platform whose realtime connection is owned
 *  natively (Kotlin's RealtimeService) and which exposes the `SomsFcm` / `SomsSecureStore` / `SomsShell`
 *  `@JavascriptInterface` surfaces. The single discriminator for "consume the native bridge" vs "run the
 *  browser/desktop code path".
 *
 *  IMPORTANT for call sites: the Android shell injects `window.SomsFcm` BEFORE any page script, so after
 *  gating on this, the bridge is guaranteed present — a missing one is a shell wiring bug. At such gated
 *  sites prefer an early `return` on the false branch and a direct `window.SomsFcm!.method()` call (so a
 *  genuine absence throws and surfaces) over `window.SomsFcm?.method()` (which silently swallows the bug).
 *  Reserve `?.` for sites gated only on `isTauri()` (desktop + Android), where `SomsFcm` is legitimately
 *  absent on desktop. */
export function isAndroidNative(): boolean {
  return isTauri() && isAndroid();
}

/** Invoke a Tauri command (only meaningful when `isTauri()`). Resolves the command's return value;
 *  rejects if not in Tauri or the command errors. Callers MUST guard with `isTauri()` and swallow
 *  errors for non-critical handoffs (e.g. token sync to the media proxy). */
export function tauriInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = typeof window !== 'undefined' ? window.__TAURI__?.core?.invoke : undefined;
  if (!invoke) return Promise.reject(new Error('not in Tauri'));
  return invoke(cmd, args) as Promise<T>;
}

/** Post a system notification via the RAW Tauri shell bridge (`window.__TAURI__.notification.sendNotification`,
 *  registered by `tauri-plugin-notification` in `src-tauri/src/lib.rs`). The raw bridge access lives HERE — exposed
 *  as a flat, typed function carrying the plugin's native params (`title`, `body`, `identifier`) — so the JS
 *  adapter layer (`NotificationAdapter`) wraps this instead of reaching into `window.__TAURI__?.notification?.…`
 *  itself. `identifier` is the replace-by-id param (same identifier replaces the prior notification). No-op when
 *  not in a Tauri shell or the plugin global is absent. Desktop-only — Android uses the Kotlin `SomsNotify` bridge. */
export function tauriSendNotification(options: { title: string; body?: string; identifier?: string }): void {
  window.__TAURI__?.notification?.sendNotification(options);
}

/** Emit a Tauri event the Rust side listens for. The SPA emits `spa-ready` after its first paint so
 *  Rust can show the main window + close the init window (the two-window handoff). No-op when not in
 *  the shell. */
export function emitTauriEvent(event: string, payload?: unknown): void {
  window.__TAURI__?.event?.emit?.(event, payload ?? null);
}

/** Marker so {@link installNativeFetch} swaps `globalThis.fetch` exactly once per renderer. */
let nativeFetchInstalled = false;

/**
 * Under the Tauri shell, replace the webview's `globalThis.fetch` with one that routes http(s)
 * requests through `tauri-plugin-http`'s reqwest-backed fetch — so the bundled app can reach ANY
 * user-configured backend, not just ones that echo the webview origin. The webview origin
 * (https://tauri.localhost) is cross-origin to every real backend, so the webview's own fetch() is
 * CORS-gated; unlike dev (where the ng dev-server proxy keeps every request same-origin — see
 * web/proxy.conf.json), the APK has no proxy, so a cross-origin read is blocked when the backend
 * doesn't echo that Origin. The plugin performs the request from Rust, which never crosses the
 * webview origin, so CORS does not apply — the same reason `/uploads` rides the `media://` proxy.
 *
 * HttpClient reaches the override via `withFetch()` (app.config.ts); the raw-fetch call sites (the
 * server-config probe, web-push vapid-key, settings-connection /health) reach it directly. Only
 * http/https URLs are redirected — `media:`, `data:`, `blob:`, `ipc:`, and relative/same-origin
 * paths fall through to the original webview fetch. The plugin's fetch is a drop-in: it builds a
 * `Request` and reads `arrayBuffer()` (so FormData/multipart uploads serialize with a correct
 * boundary), forwards all headers, honors `init.signal` (the probe's AbortController timeout), and
 * returns a real `Response`.
 *
 * No-op outside the Tauri shell (the browser build is bit-for-bit unchanged). Idempotent. MUST run
 * before `bootstrapApplication` so Angular's `HttpFetchBackend` binds the override before its first
 * request. The plugin is dynamically imported so the browser bundle keeps zero Tauri deps (it lands
 * in a lazy chunk the browser build never loads — `isTauri()` is false there).
 */
export async function installNativeFetch(): Promise<void> {
  if (nativeFetchInstalled || !isTauri()) return;
  nativeFetchInstalled = true;
  try {
    const { fetch: nativeFetch } = await import('@tauri-apps/plugin-http');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        // Hand the request to the native client (reqwest, outside the webview → no CORS).
        return nativeFetch(input, init as RequestInit | undefined);
      }
      // media:/data:/blob:/ipc:/relative — stay in the webview.
      return originalFetch.call(globalThis, input, init);
    }) as typeof globalThis.fetch;
  } catch (e) {
    // The plugin chunk ships with the app, so a load failure is a build/wiring bug — but we must
    // not block bootstrap over it. Leave the webview fetch in place (the app boots; cross-origin
    // calls will then surface real errors instead of a blank screen).
    console.error('installNativeFetch: failed to load @tauri-apps/plugin-http', e);
  }
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
 *              `${apiOrigin}${path}` with `Authorization: Bearer` (the webview can't auto-attach the
 *              SameSite=Strict cookie cross-origin, and a bare `<img src>`/CSS `url()` can't set headers).
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
