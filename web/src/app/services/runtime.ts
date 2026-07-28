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
 *    platform-specific Tauri custom-protocol URL handled by a Rust-side proxy that injects the Bearer
 *    header (`http://media.localhost` on Android/Windows, `media://localhost` elsewhere).
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
  getApiOrigin(): string | null;
  setApiOrigin(origin: string | null): void;
  /** Secondary (LAN) origin for native fallback — null when no fallback is configured. Same surface so the
   *  Android Kotlin SSE (RealtimeService) reads the same store the web writes. */
  getApiOriginSecondary(): string | null;
  setApiOriginSecondary(origin: string | null): void;
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
      core?: {
        invoke: (
          cmd: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
      /** The event surface (withGlobalTauri): emit an event the Rust side listens for, or subscribe to
       *  one Rust emits. Used by `listenEvent` (the OTA `web-download-progress` + the desktop SSE
       *  supervisor's `soms-sse-*` events) and `emitTauriEvent`. */
      event?: {
        emit: (event: string, payload?: unknown) => Promise<void> | void;
        listen?: (
          event: string,
          handler: (e: { payload: unknown }) => void,
        ) => Promise<() => void>;
      };
      /** The tauri-plugin-notification surface (registered in src-tauri/src/lib.rs), used by the DESKTOP
       *  NotificationAdapter (pc/mac/linux). `identifier` is the replace-by-id param — posting with the same
       *  identifier replaces the prior notification. Desktop-only: Android has its own Kotlin `SomsNotify`
       *  bridge (the Tauri notification plugin is deliberately not used on Android). */
      notification?: {
        sendNotification: (n: {
          title: string;
          body?: string;
          identifier?: string;
        }) => Promise<void> | void;
      };
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
      /** System notification status as a JSON string `{"enabled":boolean,"canRequest":boolean}`.
       *  `enabled` = the master app-level toggle (areNotificationsEnabled); `canRequest` = requesting now
       *  would surface the prompt (Android 13+, not yet enabled, not permanently denied). Android-only. */
      getNotificationStatus: () => string;
      /** Open the system per-app notification settings — the manual path when `canRequest` is false
       *  (permanently denied on 13+, or pre-13 where there's no runtime prompt at all). Android-only. */
      openNotificationSettings: () => void;
      /** Whether the POST_NOTIFICATIONS prompt has ever been shown (persisted by native's
       *  onRequestPermissionsResult). Seeds PushService's one-shot auto-prompt guard so it fires once
       *  EVER, not once per cold start. Android-only. */
      getNotifPermRequested: () => boolean;
      /** Away-notification grouping pref — "thread" (one card per conversation, default) or "all" (one folded
       *  card). Read by BackgroundSyncService to seed the Settings toggle; the native fetcher sends it as
       *  `grouping` on /notifications/missed. Android-only. */
      getNotifGrouping: () => string;
      /** Set the away-notification grouping pref ("thread" | "all"). Persists to SomsSecureStore; takes effect
       *  on the next background fetch. Android-only. */
      setNotifGrouping: (grouping: string) => void;
      /** Push the session token (POST /auth/login, app client) into Android encrypted storage so the
       *  native RealtimeService can authenticate /events and the background fetchers (FCM/WorkManager) can
       *  authenticate /notifications/missed while the WebView is suspended. Pass null/empty on logout to
       *  clear (and stop the native stream). Android-only. */
      setSessionToken: (token: string | null) => void;
      /** Push the threadlist's missed-summary high-water mark `{threadId, seq}` (the newest message it has
       *  accounted for) into EncryptedSharedPreferences — the SAME store the native background fetchers
       *  (FCM / WorkManager) read. They pass it as `since` to /notifications/missed while the WebView is
       *  suspended/destroyed, so the HWM MUST live in native durable storage (not just the WebView's IDB,
       *  which the native layer can't reach + which dies with the WebView). Webview→native, one-way: the
       *  webview owns + advances the HWM; native only reads. Passed as a JSON STRING (`{"threadId":..,"seq":..}`)
       *  because Android's @JavascriptInterface bridge doesn't reliably map JS objects to structured params
       *  (mirrors setFirebaseConfig). Pass null on logout. Android-only. */
      setMissedCursor: (cursor: string | null) => void;
      /** Synchronous read of the persisted session token from EncryptedSharedPreferences (the same store
       *  setSessionToken writes + the native RealtimeService reads). AuthService.restoreSession uses it to
       *  re-establish the session on a cold start with NO plaintext copy in JS storage. Returns null when
       *  no token is stored (logged out / first run). Android-only. */
      getSessionToken: () => string | null;
      /** Synchronous read of the RealtimeService's last-pushed connection state
       *  ('connecting'|'open'|'reconnecting'|'closed'), so a freshly-booted WebView can seed its
       *  connection-state signal before the next state transition. Android-only. */
      getConnState: () => string;
      /** User tapped the disconnected chip: cancel Kotlin's pending backoff + reconnect now (the JS→native
       *  retry channel — parity with the worker's retry-now and Rust's sse_net(online:true)). Delivered as
       *  an ACTION_RETRY Intent; a no-op if the stream is already open. Android-only. */
      retryNow: () => void;
      /** Force-reconnect the native /events stream even while it is OPEN — used by the client HELLO-timeout
       *  (an open stream that never delivered its HELLO handshake is unusable: the threadlist cannot build).
       *  Cancels the open EventSource and reopens it so the new connection re-pushes HELLO. This is the
       *  force-reconnect channel `retryNow` cannot serve — retryNow only cancels pending backoff and is a
       *  no-op against an already-open stream. Android-only. */
      forceReconnect: () => void;
      /** Replay the cached+merged HELLO to a freshly-attached webview (renderer reclaim / FGS-pre-connected
       *  cold start). A retained open stream does NOT re-push HELLO on its own (it is sent once per
       *  register); the native layer caches HELLO + merges every revision frame, and this hands the current
       *  merged value to the just-installed __SOMS_EVENT__ hook — no reconnect. No-op when the cache is
       *  empty. Android-only. */
      replayHello: () => void;
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
      /** Hand the server's Firebase client config (the 4 fields, folded into GET /shell/compat) to
       *  native so it persists it in EncryptedSharedPreferences and (re)initializes FirebaseApp. Pass a
       *  JSON string `{apiKey,projectId,appId,gcmSenderId}` to configure/reconfigure (a different project →
       *  deleteToken + deleteApp + re-init + new token, routed through __SOMS_FCM_TOKEN__), or null to clear
       *  (server has no FCM config → native tears down Firebase). Android-only. */
      setFirebaseConfig: (config: string | null) => void;
      /** Synchronous read of the currently-persisted Firebase client config JSON string (or null). Used to
       *  detect whether a freshly-fetched server config differs before reconfiguring native. Android-only. */
      getFirebaseConfig: () => string | null;
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
    SomsNotify?: {
      show: (text: string, replace: boolean) => void;
      showDescriptor: (json: string) => void;
      clear: () => void;
    };
    /** Kotlin `@JavascriptInterface` (MainActivity.SomsShellInterface): returns the per-device status-bar
     *  / gesture-bar insets as JSON `{"top":int,"bottom":int}` (CSS px). Android WebView is edge-to-edge
     *  but env(safe-area-inset-*) returns 0, so this is the only source of --soms-safe-top. Read once in
     *  main.ts before bootstrap for a FOUC-free first paint. Absent in browser/desktop. `getImeHeight()`
     *  (the current soft-keyboard height in CSS px, 0 when closed) lets the web seed the value at boot; the
     *  live source is {@link __SOMS_IME_HEIGHT__}. */
    SomsShell?: {
      getSafeInsets: () => string;
      getImeHeight?: () => number;
      /** Android native IME visibility controls. They preserve the focused contenteditable and caret. */
      showIme?: () => void;
      hideIme?: () => void;
    };
    /** Kotlin `@JavascriptInterface` (MainActivity.SomsCallInterface): the COMMAND direction of the native
     *  1:1-call bridge. On Android the RTCPeerConnection + the call lifecycle FSM live in native
     *  (CallController); the Angular layer is the call "chrome" and drives it through these. The EVENT
     *  direction rides the existing {@link __SOMS_EVENT__} (CALL_EVENT/CALL_SIGNAL, fanned by RealtimeService)
     *  PLUS the {@link __SOMS_CALL_EVENT__} snapshot push (phase/mediaState transitions the native FSM owns).
     *  Android-only; guaranteed present after the isAndroidNative() gate, so call sites use `!`. */
    SomsCall?: {
      initiate: (
        calleeUserId: number,
        callSid: string,
        callType: 'AUDIO' | 'VIDEO',
        peerName: string,
        peerAvatar: string,
        peerAvatarDataUrl: string,
      ) => void;
      accept: (callSid: string) => void;
      decline: (callSid: string) => void;
      cancel: (callSid: string) => void;
      end: (callSid: string, reason?: string) => void;
      signal: (
        callSid: string,
        toUserId: number,
        kind: string,
        payload: string,
      ) => void;
      setMuted: (muted: boolean) => void;
      /** One-way AUDIO→VIDEO upgrade on the existing RTCPeerConnection. Permission and SDP renegotiation
       *  are native-owned; failure leaves the audio leg connected. */
      upgradeToVideo?: () => void;
      /** Synchronous JSON snapshot of the live call (CallController.snapshotJson) — the web call UI
       *  re-derives its state from this on boot / WebView re-attach with no SSE wait. */
      getSnapshot: () => string;
      /** Toggle the capture between the front (self-view) + back cameras (like WhatsApp/FaceTime). A no-op
       *  on an AUDIO call. Native (Phase 4): swaps the VideoCapturer's CameraEnumerator lens + re-binds the
       *  local video track. */
      switchCamera: () => void;
      /** Camera on/off (mute video, keep audio). Disables the local video track + covers the self-view;
       *  the remote side sees a frozen/black frame. */
      setCameraEnabled: (enabled: boolean) => void;
      /** Report the on-screen rects of the remote + self video "holes" (JSON `{x,y,w,h}` in CSS px) so
       *  native positions its sibling SurfaceViewRenderer/TextureView overlays exactly over the transparent
       *  holes the Angular layout punches (the barcode-scanner overlay technique). Called on mount, resize,
       *  scroll, rotation; pass nulls to hide the surfaces. */
      setVideoRect: (remote: string | null, self: string | null) => void;
      /** High-frequency self-view drag path in absolute CSS px. Native uses translationX/Y only; the final
       *  position is committed through setVideoRect when the gesture ends. */
      setSelfVideoPosition: (x: number, y: number) => void;
      /** Swap which video is full-bleed vs PiP (a tap on the self PiP): the local camera ↔ the peer's swap
       *  renderers (mirrors follow). No-op on an AUDIO call. */
      swapVideo: () => void;
    };
    SomsUpload?: {
      pickPhotos: () => void;
      pickFile: () => void;
      upload: (
        uploadId: string,
        kind: string,
        clientMessageId: string | null,
        fieldsJson: string | null,
      ) => void;
      cancel: (uploadId: string) => void;
      discard: (uploadId: string) => void;
    };
    __SOMS_UPLOAD_PICKED__?: (payload: {
      items: import('./native-upload.service').NativeUploadSelection[];
    }) => void;
    __SOMS_UPLOAD_PROGRESS__?: (payload: {
      uploadId: string;
      loaded: number;
      total: number;
    }) => void;
    __SOMS_UPLOAD_COMPLETED__?: (payload: {
      uploadId: string;
      response: unknown;
    }) => void;
    __SOMS_UPLOAD_FAILED__?: (payload: {
      uploadId: string;
      message: string;
    }) => void;
    /** Kotlin→JS push (CallController.pushSnapshot): the native call FSM's current snapshot
     *  ({phase, callSid, …, mediaState, startedAt, muted}) whenever a transition the native layer owns
     *  fires (media connect/disconnect/failed, mute, phase changes). Installed by {@link CallEventService};
     *  absent on browser/desktop (no native call layer there). CallEventService merges this into its
     *  `callState` signal alongside the SSE CALL_EVENT lifecycle frames. */
    __SOMS_CALL_EVENT__?: (snapshot: {
      phase: string;
      callSid: string | null;
      threadId: number;
      peerUserId: number;
      callType: 'AUDIO' | 'VIDEO';
      isCaller: boolean;
      mediaState: string;
      startedAt: number;
      muted: boolean;
      /** The caller's display name — present only when the native side seeded it from the CALL_INCOMING FCM
       *  push (a cold-started callee has no live SSE, so it never got CALL_EVENT{incoming}). Empty for the
       *  foreground path (the SSE frame owns the name there). */
      peerName?: string;
      peerAvatar?: string;
    }) => void;
    /** Kotlin→JS push (MainActivity.onPictureInPictureModeChanged): fired with `true` when the activity
     *  enters PiP (a connected VIDEO call the user backgrounded) + `false` on exit. The call chrome hides
     *  itself in PiP (only the native remote video shows in the PiP window). Installed by CallScreenComponent. */
    __SOMS_PIP__?: (inPip: boolean) => void;
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
    /** Kotlin→JS push (RealtimeService.scheduleReopen): the scheduled ms until the native stream's next
     *  reconnect attempt, so the ConnectionBanner can render a live countdown (the facade owns the clock;
     *  this just delivers the one-shot deadline Kotlin computes before its `postDelayed` backoff). Installed
     *  by the NativeEventTransport; a no-op until then (Kotlin guards the call). */
    __SOMS_RECONNECT_IN__?: (ms: number) => void;
    /** Kotlin→JS push (RealtimeService.signalRust): the origin Kotlin decided is ACTIVE for the /events stream,
     *  so Rust's API transports follow it (Android = Kotlin-authoritative; Rust is passive there and accepts
     *  this via the `set_active_origin` command — no API⇄SSE origin split). Installed eagerly by
     *  {@link installActiveOriginBridge} before bootstrap, so Kotlin's very first decision (even ahead of the
     *  NativeEventTransport connecting) lands. A no-op outside Tauri. */
    __SOMS_SET_ACTIVE_ORIGIN__?: (origin: string) => void;
  }
}

/** True when running inside the Tauri desktop webview. Detected via the IPC global Tauri injects
 *  before page scripts run — no SDK import needed. */
export function isTauri(): boolean {
  return (
    typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined
  );
}

/** True when the current Tauri shell is the Android APK (vs the desktop build). Used to gate the
 *  "disconnect SSE on background" rule — mobile Android should close the stream gracefully (the OS will
 *  kill it anyway), while PC/desktop keeps it alive. UA-based: the Android WebView UA carries "Android". */
export function isAndroid(): boolean {
  return (
    typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
  );
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

/** The SessionToken `client` kind for the CURRENT platform: `'app'` (Android native), `'desktop'` (Tauri
 *  desktop), or `'web'` (browser). The login flows send this so the issued session's `client` row — and
 *  therefore its trust/lifetime — matches the real platform (see `SessionTokenService.issue`: lifetime is
 *  driven by `trusted`, which defaults from `client`). */
export function sessionClient(): 'app' | 'web' | 'desktop' {
  if (isAndroidNative()) return 'app';
  if (isTauri()) return 'desktop';
  return 'web';
}

/** Invoke a Tauri command (only meaningful when `isTauri()`). Resolves the command's return value;
 *  rejects if not in Tauri or the command errors. Every rejection is surfaced to the webview console
 *  (`console.error`, visible via edge://inspect / `adb logcat`) as a side-effect BEFORE the rejection
 *  propagates — so Rust-side failures (capability rejections, command errors, network failures) always
 *  show up even when a caller swallows the rejection. Callers MUST still guard with `isTauri()` and
 *  swallow errors for non-critical handoffs (e.g. token sync to the media proxy). */
export function tauriInvoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const invoke =
    typeof window !== 'undefined' ? window.__TAURI__?.core?.invoke : undefined;
  if (!invoke) return Promise.reject(new Error('not in Tauri'));
  const p = invoke(cmd, args) as Promise<T>;
  p.catch((e) => console.error(`[tauri] ${cmd} failed:`, e));
  return p;
}

/** Post a system notification via the RAW Tauri shell bridge (`window.__TAURI__.notification.sendNotification`,
 *  registered by `tauri-plugin-notification` in `src-tauri/src/lib.rs`). The raw bridge access lives HERE — exposed
 *  as a flat, typed function carrying the plugin's native params (`title`, `body`, `identifier`) — so the JS
 *  adapter layer (`NotificationAdapter`) wraps this instead of reaching into `window.__TAURI__?.notification?.…`
 *  itself. `identifier` is the replace-by-id param (same identifier replaces the prior notification). No-op when
 *  not in a Tauri shell or the plugin global is absent. Desktop-only — Android uses the Kotlin `SomsNotify` bridge. */
export function tauriSendNotification(options: {
  title: string;
  body?: string;
  identifier?: string;
}): void {
  window.__TAURI__?.notification?.sendNotification(options);
}

/** Emit a Tauri event the Rust side listens for. No-op when not in the shell. */
export function emitTauriEvent(event: string, payload?: unknown): void {
  window.__TAURI__?.event?.emit?.(event, payload ?? null);
}

/** Subscribe to a Tauri event the Rust side emits (e.g. `web-download-progress` while streaming the web
 *  bundle in Settings→About). Resolves to an unlisten fn (call to stop), or undefined when not in the
 *  shell. Mirrors emitTauriEvent in riding the global `window.__TAURI__` (no @tauri-apps/api dep). */
export async function listenEvent<T = unknown>(
  event: string,
  handler: (e: { payload: T }) => void,
): Promise<(() => void) | undefined> {
  const listen =
    typeof window !== 'undefined' ? window.__TAURI__?.event?.listen : undefined;
  if (!listen) return undefined;
  return listen(event, (e) => handler({ payload: e.payload as T }));
}

/** Canonicalize a backend origin: trim and strip trailing slash(es) so it is a safe path-concatenation
 *  base. A trailing slash turns `${apiOrigin()}/api/v1` into `${apiOrigin()}//api/v1`, which Fastify
 *  404s — and users DO type a trailing slash in the server-config form. Mirrors the Rust
 *  `validate_origin` strip; applied at the seed so the signal is canonical regardless of what was typed
 *  or what an older build persisted. */
export function canonicalOrigin(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/** True when `origin` is empty or not `https://` — used to flag the http/IP insecure posture (the
 *  cert-validation step is skipped there; not guaranteed secure). Mirrors the Rust validate_origin
 *  posture and the former shell-config bootstrap helper. */
export function originIsInsecure(origin: string): boolean {
  return !origin || !/^https:\/\//i.test(origin);
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
          try {
            return localStorage.getItem('api_origin');
          } catch {
            return null;
          }
        },
        setApiOrigin: (o) => {
          try {
            if (o) localStorage.setItem('api_origin', o);
            else localStorage.removeItem('api_origin');
          } catch {
            /* storage unavailable — best-effort */
          }
        },
        getApiOriginSecondary: () => {
          try {
            return localStorage.getItem('api_origin_secondary');
          } catch {
            return null;
          }
        },
        setApiOriginSecondary: (o) => {
          try {
            if (o) localStorage.setItem('api_origin_secondary', o);
            else localStorage.removeItem('api_origin_secondary');
          } catch {
            /* storage unavailable — best-effort */
          }
        },
      };

/** Absolute backend origin for cross-origin clients (Tauri shell), or `''` for same-origin (browser) /
 *  not-yet-configured (Tauri first run). A LIVE writable signal — the single source of truth for where
 *  the data layer points. Seeded from the persisted store (`secureStore`), NOT from a frozen init-script
 *  global, so a renderer-reclaim reload after a server-config change re-reads the live value instead of
 *  a stale snapshot. `''` (not a localhost default) means "no server configured yet"; the server-config
 *  form pre-fills a placeholder. Read via `apiOrigin()`; only `setApiOrigin` writes it. */
export const apiOrigin = signal<string>(
  canonicalOrigin(secureStore.getApiOrigin() ?? ''),
);

/** The configured LAN (secondary) origin for native fallback, or null when no fallback is configured (dev /
 *  a server without SOMS_LAN_DOMAIN). Seeded from the same persistence surface as {@link apiOrigin}. This is
 *  the user's field-2 CONFIG — it does NOT track the swapping ACTIVE origin (Rust-internal; read
 *  {@link getOriginMode} for which is active). Written only by {@link setApiOriginSecondary}. */
export const apiOriginSecondary = signal<string | null>(
  ((): string | null => {
    const raw = secureStore.getApiOriginSecondary();
    return raw ? canonicalOrigin(raw) : null;
  })(),
);

/** Custom URI scheme the Tauri Rust side registers (see `src-tauri/src/lib.rs`) to proxy
 *  `/uploads/*` media with a Bearer header. */
export const MEDIA_SCHEME = 'media';
const MEDIA_HOST = 'localhost';

/**
 * Rewrite a server-relative media URL for the current runtime.
 *  - Browser → the bare path (same-origin; the httpOnly `media_token` cookie authenticates it).
 *  - Tauri Android/Windows → `http://media.localhost<path>`.
 *  - Other Tauri platforms → `media://localhost<path>`.
 * Both native forms are served by the Rust URI-scheme proxy, which forwards to `${apiOrigin}${path}`
 * with `Authorization: Bearer` (the webview can't auto-attach the SameSite=Strict cookie cross-origin,
 * and a bare `<img src>`/CSS `url()` can't set headers).
 * Already-absolute URLs (`data:`, `blob:`, `http:`, `https:`) pass through unchanged.
 */
export function assetUrl(path: string | null | undefined): string {
  if (!path) return '';
  if (!path.startsWith('/')) return path; // absolute (data:/blob:/http(s):) — leave as-is
  if (!isTauri()) return path;
  // Tauri maps registered custom protocols onto an HTTP localhost subdomain on Android and Windows;
  // those WebViews do not recognize `media://` and fail before the Rust handler can run.
  if (
    typeof navigator !== 'undefined' &&
    /(Android|Windows)/i.test(navigator.userAgent)
  ) {
    return `http://${MEDIA_SCHEME}.${MEDIA_HOST}${path}`;
  }
  return `${MEDIA_SCHEME}://${MEDIA_HOST}${path}`;
}

/**
 * Open an external URL outside the app. On the web it is a normal `window.open` (new tab, noopener).
 * Under the Tauri shell the webview's navigation guard blocks external document navigation, so it is
 * routed to a Rust command that hands the URL to the OS's system-browser opener (tauri-plugin-opener).
 * Used by the link-card row to open the shared page on tap.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  await tauriInvoke('open_external_url', { url });
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
  if (!isTauri())
    throw new Error('setApiOrigin is only available under the Tauri shell');
  const normalized = await tauriInvoke<string>('set_api_origin', { url });
  apiOrigin.set(normalized);
  secureStore.setApiOrigin(normalized);
  return normalized;
}

/** Sync the apiOrigin signal + secureStore from an authoritative value WITHOUT re-persisting to Rust
 *  (the origin is already in the Rust config file — this is the self-heal path the configGuard uses when
 *  `is_origin_configured` is true but the SPA signal is empty, i.e. secureStore drift on a device that
 *  configured via an older build). Cheaper than `setApiOrigin`, which would re-run the Rust writer. */
export function syncApiOriginSignal(origin: string): void {
  const c = canonicalOrigin(origin);
  apiOrigin.set(c);
  secureStore.setApiOrigin(c);
}

/** Persist the LAN (secondary) origin (field-2) and mirror it into {@link apiOriginSecondary} (Tauri only).
 *  `null`/empty clears it (disables fallback). Rust validates + persists it (a separate file from the
 *  primary) and `select_origin` begins using it; the same value is written to the platform store (Android
 *  EncryptedSharedPreferences — the store RealtimeService reads). Returns the canonical value Rust stored. */
export async function setApiOriginSecondary(
  url: string | null,
): Promise<string | null> {
  if (!isTauri())
    throw new Error(
      'setApiOriginSecondary is only available under the Tauri shell',
    );
  const normalized = await tauriInvoke<string | null>(
    'set_api_origin_secondary',
    { url },
  );
  const canonical = normalized ? canonicalOrigin(normalized) : null;
  apiOriginSecondary.set(canonical);
  secureStore.setApiOriginSecondary(canonical);
  return canonical;
}

/** Sync {@link apiOriginSecondary} from an authoritative value WITHOUT re-persisting to Rust (the value is
 *  already in the Rust config — the self-heal path). */
export function syncApiOriginSecondarySignal(origin: string | null): void {
  const canonical = origin ? canonicalOrigin(origin) : null;
  apiOriginSecondary.set(canonical);
  secureStore.setApiOriginSecondary(canonical);
}

/** Which origin is currently ACTIVE — `'primary'` (normal) or `'secondary'` (a switch moved to the LAN
 *  origin). For the "正在使用内网服务器" indicator. Tauri only; returns `'primary'` in the browser build. */
export async function getOriginMode(): Promise<'primary' | 'secondary'> {
  if (!isTauri()) return 'primary';
  const mode = await tauriInvoke<string>('get_origin_mode');
  return mode === 'secondary' ? 'secondary' : 'primary';
}

/** The login-init concurrent race — probe both origins' `/health`, pick the reachable one, set Rust's active
 *  origin. Call BEFORE the auth request so login targets a reachable origin (on the LAN the public origin is
 *  hairpin-unreachable — a boot-time pick could be stale if the network changed before login). ONCE per
 *  process (a QR-poll loop reuses the result instead of re-racing every tick); a failure clears the cache so
 *  a retry re-races. No-op outside Tauri (returns the configured primary). */
let loginPickPromise: Promise<string> | null = null;
export function pickLoginOrigin(): Promise<string> {
  if (!isTauri()) return Promise.resolve(apiOrigin());
  if (!loginPickPromise) {
    loginPickPromise = tauriInvoke<string>('init_pick_origin').catch((e) => {
      loginPickPromise = null; // allow a retry to re-race
      throw e;
    });
  }
  return loginPickPromise;
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
    const { top, bottom } = JSON.parse(window.SomsShell.getSafeInsets()) as {
      top: number;
      bottom: number;
    };
    const root = document.documentElement;
    root.style.setProperty('--soms-safe-top', `${top}px`);
    root.style.setProperty('--soms-safe-bottom', `${bottom}px`);
  } catch {
    // SomsShell present but the call failed — leave the CSS default (env(), 0 on Android).
  }
}

/**
 * Install the `window.__SOMS_SET_ACTIVE_ORIGIN__` sink — Kotlin's RealtimeService signals the origin it chose
 * for the /events stream (Android is Kotlin-authoritative; Rust is passive there), and this forwards it to the
 * Rust `set_active_origin` command so the API transports follow the same origin (no API⇄SSE origin split).
 *
 * Installed EAGERLY (before bootstrap, like {@link installKeyboardInsetBridge}) rather than in the
 * NativeEventTransport, because it is a thin pass-through to a Tauri command independent of the realtime
 * transport — eager install means Kotlin's first decision (which can fire ahead of transport.connect, e.g. the
 * login-time openStream) is not lost. A no-op outside Tauri (Kotlin never calls it there); a no-op on desktop
 * (Rust decides the origin itself there and never receives this push).
 */
export function installActiveOriginBridge(): void {
  if (typeof window === 'undefined') return;
  window.__SOMS_SET_ACTIVE_ORIGIN__ = (origin: string) => {
    if (!isTauri() || !origin) return;
    // Rust accepts without probing/deciding (it is not the authority on Android). Rejections are logged by
    // tauriInvoke; a swallowed rejection is harmless — the next signalRust (every openStreamOn) re-syncs.
    void tauriInvoke('set_active_origin', { url: origin });
  };
}
