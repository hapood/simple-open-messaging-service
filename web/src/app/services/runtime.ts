/**
 * Runtime detection + URL rewriting for the Tauri desktop shell.
 *
 * The Angular app is built once and runs in two contexts:
 *  - Browser: served same-origin by NestJS; all URLs relative; media authenticated by the
 *    httpOnly `media_token` cookie set on login.
 *  - Tauri desktop webview: loaded from local assets at a non-HTTP origin (tauri://localhost on
 *    macOS, https://tauri.localhost on Windows, http://tauri.localhost on Linux). The backend origin
 *    is read from the platform persistence surface — the native `window.SomsSecureStore`
 *    (@JavascriptInterface, EncryptedSharedPreferences) on Android at seed time; on desktop it lives
 *    in the Rust app-data config file and reaches the signal via the config-guard self-heal —
 *    so API/SSE URLs resolve cross-origin. The backend's httpOnly `media_token` cookie is
 *    SameSite=Strict (so the webview can't auto-attach it cross-origin) and a bare `<img src>` / CSS
 *    `url()` can't carry an Authorization header anyway, so `/uploads/*` is rewritten to a
 *    platform-specific Tauri custom-protocol URL handled by a Rust-side proxy that injects the Bearer
 *    header (`http://media.localhost` on Android/Windows, `media://localhost` elsewhere).
 *
 * Browser behavior is bit-for-bit unchanged when the globals are absent: every helper falls back
 * to the same-origin relative path.
 */

import { signal } from '@angular/core';
import type { StandardMessage } from './realtime-transport';
import type { CallTerminalReason } from './call-adapter';

/**
 * The persistence surface for state that must survive WebView/renderer death and be readable with no
 * page alive (the backend origin today; the session token once the native-realtime rewrite lands).
 *  - Android: a Kotlin `@JavascriptInterface` (`window.SomsSecureStore`) backed by
 *    EncryptedSharedPreferences — the SAME store the native SSE (RealtimeService)
 *    reads, so the web and the native realtime layer can never disagree on the host.
 *  - Desktop / browser: `window.SomsSecureStore` is absent, so `secureStore` falls back to an inert
 *    stub (reads return null, writes no-op) — the desktop origin's persistence is the Rust app-data
 *    configuration file, synced into the signal by the config guard. The web
 *    talks to this single interface regardless of platform — no isAndroid() branching at the call sites.
 */
interface SomsSecureStore {
  getApiOrigin(): string | null;
  recordServerOrigins(
    primary: string,
    secondary: string | null,
    mode: 'primary' | 'secondary',
  ): void;
  /** Secondary (LAN) origin for native fallback — null when no fallback is configured. Same surface so the
   *  Android Kotlin SSE (RealtimeService) reads the same store the web writes. */
  getApiOriginSecondary(): string | null;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    /** Native (Android) persistence surface (EncryptedSharedPreferences); absent on desktop/browser,
     *  where `secureStore` falls back to an inert stub. See `SomsSecureStore` + `secureStore`. */
    SomsSecureStore?: SomsSecureStore;
    /** Exposed by Tauri v2 when `app.withGlobalTauri` is true (see src-tauri/tauri.conf.json). Used
     *  instead of the `@tauri-apps/api` npm package so the browser build has zero extra deps and the
     *  Tauri surface is unreachable outside the shell. */
    __TAURI__?: {
      core?: {
        Channel?: new <T>(onmessage?: (message: T) => void) => {
          onmessage: (message: T) => void;
        };
        invoke: (
          cmd: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
      /** The event surface (withGlobalTauri): emit an event the Rust side listens for, or subscribe to
       *  one Rust emits. Used by `listenEvent` (the desktop SSE
       *  supervisor's `soms-sse-*` events) and `emitTauriEvent`. */
      event?: {
        emit: (event: string, payload?: unknown) => Promise<void> | void;
        listen?: (
          event: string,
          handler: (e: { payload: unknown }) => void,
        ) => Promise<() => void>;
      };
    };
    /** FCM bridge injected by the Android shell (SomsMessagingService / MainActivity). `SomsFcm` is a
     *  Kotlin `@JavascriptInterface` exposing the current FCM token + permission request. The two hooks
     *  are how Kotlin pushes the token (rotation) and a notification-tap deep link (warm start) into JS.
     *  Pending notification navigation stays in Kotlin until PushService opens and acknowledges it.
     *  All absent in the browser build — guarded by isTauri() at every use. */
    __SOMS_FCM_REGISTRATION__?: (result: {
      requestId: string;
      token?: string;
      error?: string;
    }) => void;
    SomsFcm?: {
      preparePushRegistration: (requestId: string, replace: boolean) => void;
      getToken: () => string | null;
      getPendingThreadId: () => string | null;
      acknowledgeThreadId: (threadId: string) => void;
      clearMessageNotifications: () => void;
      setActiveThreadId: (threadId: number) => void;
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
      /** Away-notification preview privacy mode used by the native fetcher. */
      getNotificationPreviewMode: () => string;
      /** Set the away-notification grouping pref ("thread" | "all"). Persists to SomsSecureStore; takes effect
       *  on the next background fetch. Android-only. */
      setNotificationPreviewMode: (mode: string) => void;
      getNotificationAlertPolicy: () => string;
      setNotificationAlertPolicy: (policy: string) => void;
      /** Push the session token (POST /auth/login, app client) into Android encrypted storage so the
       *  native RealtimeService can authenticate /events and the background fetchers (FCM/WorkManager) can
       *  authenticate native thread-feed synchronization while the WebView is suspended. Pass null/empty on logout to
       *  clear (and stop the native stream). Android-only. */
      setSessionToken: (token: string | null, sessionUuid: string) => void;
      discardResidualToken: () => void;
      /** Mirror the per-user integer message-feed cursor into native notification storage. */
      /** Synchronous read of the persisted session token from EncryptedSharedPreferences (the same store
       *  setSessionToken writes + the native RealtimeService reads). AuthService.restoreSession uses it to
       *  re-establish the session on a cold start with NO plaintext copy in JS storage. Returns null when
       *  no token is stored (logged out / first run). Android-only. */
      getSessionToken: () => string | null;
      /** Synchronous read of the RealtimeService's last-pushed connection state
       *  ('connecting'|'open'|'reconnecting'|'closed'), so a freshly-booted WebView can seed its
       *  connection-state signal before the next state transition. Android-only. */
      getConnState: () => string;
      /** Race the configured origins through Android's shared native selector. */
      pickActiveOrigin: () => string | null;
      /** User tapped the disconnected chip: request immediate retry in Rust (the JS→native
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
      /** Hand the server's Firebase client config (the 4 fields, folded into GET /client/compat) to
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
    __SOMS_DEEP_LINK__?: () => void;
    /** Android share-sheet notification. Pull from SomsShare so the payload remains recoverable until ack. */
    __SOMS_SHARE_AVAILABLE__?: () => void;
    SomsShare?: {
      getPending: () => string | null;
      acknowledge: (id: string) => boolean;
    };
    /** Android hardware-back hook: Kotlin's `OnBackPressedCallback` evals this on the webview. The handler
     *  peels one navigation layer via NavStateMachineService.back(); if nothing is left to peel it calls
     *  `SomsBack.exit()` (a Kotlin @JavascriptInterface) so the activity finishes. Absent on browser +
     *  desktop Tauri (browser-back naturally exits the flat history there). See NavStateMachineService. */
    __SOMS_BACK__?: () => void;
    /** Android Predictive Back lifecycle. Optional until the web navigation layer implements gesture-driven
     *  previews; native commit falls back to {@link __SOMS_BACK__} while this hook is absent. Coordinates are
     *  physical WebView pixels, progress is 0..1, and swipeEdge follows Android's LEFT/RIGHT constants. */
    __SOMS_PREDICTIVE_BACK__?: (
      event:
        | {
            kind: 'start' | 'progress';
            progress: number;
            touchX: number;
            touchY: number;
            swipeEdge: number;
          }
        | { kind: 'cancel' | 'commit' },
    ) => void;
    /** Kotlin `@JavascriptInterface` exposed by the Android shell: finishes the activity (clean app exit)
     *  when NavStateMachineService.back() has nothing left to peel. Android-only. */
    SomsBack?: { exit: () => void };
    /** Kotlin `@JavascriptInterface` (MainActivity.SomsShellInterface): returns the per-device status-bar
     *  / gesture-bar insets as JSON `{"top":int,"bottom":int}` (CSS px). Android WebView is edge-to-edge
     *  but env(safe-area-inset-*) returns 0, so this is the only source of --soms-safe-top. Read once in
     *  main.ts before bootstrap for a FOUC-free first paint. IME exposure is atomic: a snapshot seeds state,
     *  one command requests visibility, and runtime geometry arrives through {@link __SOMS_IME_EVENT__}. */
    SomsShell?: {
      getSafeInsets: () => string;
      /** Update the native-localized launch label using a small, allow-listed stage key. */
      setSplashStage?: (stage: 'session' | 'config' | 'interface') => void;
      /** Fade the native launch overlay after the initial route and stable content have painted. */
      finishSplash?: () => void;
      /** Match transparent Android system-bar icon contrast to the resolved web theme. */
      setSystemBarTheme?: (dark: boolean) => void;
      /** Raise/lower the Android Kotlin diagnostic sink with the shared runtime debug gate. */
      setDebugLogging?: (enabled: boolean) => void;
      getImeSnapshot?: () => string;
      setImeVisible?: (visible: boolean, requestId: number) => void;
      showComposer?: (contextJson: string) => void;
      setComposerBounds?: (boundsJson: string) => void;
      updateComposer?: (patchJson: string) => void;
      acknowledgeComposerAction?: (actionId: number, accepted: boolean) => void;
      hideComposer?: (contextId: number) => void;
      /** Clear Android WebView's HTTP memory/disk cache without touching cookies or web storage. */
      clearWebViewCache?: () => void;
    };
    __SOMS_COMPOSER_EVENT__?: (
      event: import('./native-composer.service').NativeComposerEvent,
    ) => void;
    /** Kotlin `@JavascriptInterface` (MainActivity.SomsCallInterface): commands enter the Rust-owned
     *  call lifecycle through this bridge. Kotlin adapts platform media and OS capabilities; Angular
     *  renders the call controls. Events arrive through {@link __SOMS_EVENT__} for server frames and
     *  {@link __SOMS_CALL_EVENT__} for Rust-owned snapshots.
     *  Android-only; guaranteed present after the isAndroidNative() gate, so call sites use `!`. */
    SomsCall?: {
      initiate: (
        threadId: number,
        callSid: string,
        callType: 'AUDIO' | 'VIDEO',
        peerAccount: string,
        peerNamespaceId: number,
      ) => void;
      accept: (callSid: string) => void;
      decline: (callSid: string) => void;
      cancel: (callSid: string) => void;
      end: (callSid: string, reason?: string) => void;
      setSpeakerEnabled: (enabled: boolean) => void;
      signal: (callSid: string, kind: string, payload: string) => void;
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
      pickPhotos: (requestId: string) => void;
      pickFile: (requestId: string) => void;
      upload: (
        uploadId: string,
        attemptId: string,
        kind: string,
        clientMessageId: string | null,
        fieldsJson: string | null,
      ) => void;
      cancel: (uploadId: string, attemptId: string) => void;
      release: (uploadId: string) => void;
      discard: (uploadId: string) => void;
      getState: (uploadId: string) => string;
      finish?: (
        uploadId: string,
        attemptId: string,
        succeeded: boolean,
      ) => void;
    };
    /** Android public-file bridge. Rust owns authenticated download + private cache; Kotlin only copies
     *  that verified app-cache file into MediaStore so it becomes visible in Gallery/Downloads. */
    SomsMedia?: {
      save: (
        requestId: string,
        cachePath: string,
        filename: string,
        mimeType: string,
      ) => string;
    };
    /** Android Media3 chat-video bridge. Only canonical CAS paths are accepted natively. */
    SomsVideo?: {
      open: (
        streamUrl: string,
        thumbnailUploadUrl: string,
        digest: string,
        hasThumbnail: boolean,
      ) => void;
    };
    /** Emitted after the native player has persisted the first rendered frame as a local WebP. */
    __SOMS_VIDEO_THUMBNAIL__?: (digest: string) => void;
    __SOMS_MEDIA_SAVE_RESULT__?: (payload: {
      requestId: string;
      success: boolean;
      cancelled?: boolean;
    }) => void;
    __SOMS_UPLOAD_PICKED__?: (payload: {
      requestId: string;
      items: import('./native-upload.service').NativeUploadSelection[];
    }) => void;
    __SOMS_UPLOAD_INSPECTING__?: (payload: { requestId: string }) => void;
    __SOMS_UPLOAD_PROGRESS__?: (payload: {
      uploadId: string;
      attemptId: string;
      loaded: number;
      total: number;
    }) => void;
    __SOMS_UPLOAD_COMPLETED__?: (payload: {
      uploadId: string;
      attemptId: string;
      response: unknown;
    }) => void;
    __SOMS_UPLOAD_FAILED__?: (payload: {
      uploadId: string;
      attemptId: string;
      category: import('./native-upload.service').NativeUploadErrorCategory;
      message: string;
      retryable: boolean;
      status?: number;
      code?: number;
      retryAfter?: number;
    }) => void;
    /** Native media adapter→JS push: the Rust call runtime's current snapshot
     *  ({phase, callSid, …, mediaState, startedAt, muted}) whenever a transition the native layer owns
     *  fires (media connect/disconnect/failed, mute, phase changes). Installed by {@link CallEventService};
     *  absent on browser/desktop (no native call layer there). CallEventService merges this into its
     *  `callState` signal alongside the SSE CALL_EVENT lifecycle frames. */
    __SOMS_CALL_EVENT__?: (snapshot: {
      phase: string;
      terminalReason?: CallTerminalReason | null;
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
    /** Atomic Kotlin→JS IME geometry event, installed before Angular bootstrap. */
    __SOMS_IME_EVENT__?: (event: {
      phase: 'prepare' | 'start' | 'progress' | 'end' | 'change';
      currentPx: number;
      targetPx: number | null;
      durationMs: number;
      animationId: number;
      requestId: number | null;
      visible: boolean;
      isFinal: boolean;
    }) => void;
    /** Android adapter→JS push: one `/events` frame forwarded from the Rust-owned
     *  SSE, so the Android WebView consumes realtime without opening its own worker. Installed by the
     *  NativeEventTransport; absent on browser/desktop (where the WebsocketService spawns sse.worker.ts).
     *  Kotlin guards the call (`window.__SOMS_EVENT__ && …`), so frames arriving before the transport
     *  installs the hook are silently dropped and recovered by the app-open HWM catch-up. */
    __SOMS_EVENT__?: (envelope: StandardMessage) => void;
    /** Android adapter→JS push: a connection-state transition
     *  ('connecting'|'open'|'reconnecting'|'closed') of the native /events stream, so the ConnectionBanner
     *  reflects the Rust-owned connection through the Android adapter. Installed by the NativeEventTransport; the current value is
     *  also readable synchronously via `SomsFcm.getConnState()` (Kotlin only pushes on transitions). */
    __SOMS_CONN_STATE__?: (state: string) => void;
    /** Android adapter→JS push: the scheduled ms until the native stream's next
     *  reconnect attempt, so the ConnectionBanner can render a live countdown (the facade owns the clock;
     *  this just delivers the one-shot deadline computed by the shared Rust runtime). Installed
     *  by the NativeEventTransport; a no-op until then (Kotlin guards the call). */
    __SOMS_RECONNECT_IN__?: (ms: number) => void;
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

/** Clear Android WebView's HTTP cache only. IndexedDB, cookies, and DOM storage are untouched. */
export function clearNativeMediaCache(): void {
  if (!isAndroidNative()) return;
  const clear = window.SomsShell?.clearWebViewCache;
  if (!clear)
    throw new Error('Android clearWebViewCache bridge is unavailable');
  clear();
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

/** Emit a Tauri event the Rust side listens for. No-op when not in the shell. */
export function emitTauriEvent(event: string, payload?: unknown): void {
  window.__TAURI__?.event?.emit?.(event, payload ?? null);
}

/** Subscribe to a Tauri event from Rust. Resolves to an unlisten function, or undefined
 *  outside the installed app. Uses the same global bridge as emitTauriEvent. */
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

/** The concrete persistence surface: the native `@JavascriptInterface` on Android; an inert stub
 *  (reads return null, writes no-op) on desktop/browser, where the origin's persistence is the Rust
 *  configuration file. Resolved once at module load — `window.SomsSecureStore` is injected before
 *  any page script by the Android shell (same window as the other @JavascriptInterface surfaces), so the
 *  native store is available synchronously at seed time, with no async and no race. */
const secureStore: SomsSecureStore =
  typeof window !== 'undefined' && window.SomsSecureStore
    ? window.SomsSecureStore
    : {
        getApiOrigin: () => null,
        recordServerOrigins: () => {},
        getApiOriginSecondary: () => null,
      };

/** Absolute backend origin for cross-origin clients (Tauri shell), or `''` for same-origin (browser) /
 *  not-yet-configured (Tauri first run). A LIVE writable signal — the single source of truth for where
 *  the data layer points. Seeded from the persisted store (`secureStore`), NOT from a frozen init-script
 *  global, so a renderer-reclaim reload after a server-config change re-reads the live value instead of
 *  a stale snapshot. `''` (not a localhost default) means "no server configured yet"; the server-config
 *  form pre-fills a placeholder. Updated from Rust's committed server configuration. */
export const apiOrigin = signal<string>(
  canonicalOrigin(secureStore.getApiOrigin() ?? ''),
);

/** The configured LAN (secondary) origin for native fallback, or null when no fallback is configured (dev /
 *  a server without SOMS_LAN_DOMAIN). Seeded from the same persistence surface as {@link apiOrigin}. This is
 *  the user's field-2 CONFIG — it does NOT track the swapping ACTIVE origin (Rust-internal; read
 *  {@link getOriginMode} for which is active). Updated from Rust's committed server configuration. */
export const apiOriginSecondary = signal<string | null>(
  ((): string | null => {
    const raw = secureStore.getApiOriginSecondary();
    return raw ? canonicalOrigin(raw) : null;
  })(),
);

/** Custom URI scheme the Tauri Rust side registers (see `src-tauri/src/lib.rs`) to proxy
 *  `/uploads/*` media with a Bearer header. */
const MEDIA_SCHEME = 'media';
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

/** Native chat-card image URL. The original `/uploads/*` URL remains the canonical detail/download
 * path; this alternate media-protocol path asks Rust for a 960px cached WebP and falls back to the
 * original bytes when the source cannot be decoded. Browser builds keep using the server URL unchanged. */
export function chatThumbnailUrl(path: string | null | undefined): string {
  if (!path) return '';
  if (!isTauri() || !path.startsWith('/uploads/')) return assetUrl(path);
  return assetUrl(`/chat-thumbnails${path}`);
}

/** Native cache-only chat thumbnail URL. Unlike chatThumbnailUrl(), a miss returns 404 and never fetches
 * the original, so oversized list-card images can probe the local cache without bypassing the size gate. */
export function cachedChatThumbnailUrl(
  path: string | null | undefined,
): string {
  if (!path || !isTauri() || !path.startsWith('/uploads/')) return '';
  return assetUrl(`/cached-chat-thumbnails${path}`);
}

const VIDEO_CAS_PATH =
  /^\/uploads\/shards\/[0-9a-f]{2}\/[0-9a-f]{2}\/([0-9a-f]{64})\.[A-Za-z0-9]+$/;

/** The server-side content digest is the only identity accepted for a native video or thumbnail. */
export function videoCasDigest(path: string | null | undefined): string | null {
  return path?.match(VIDEO_CAS_PATH)?.[1] ?? null;
}

/** Local thumbnail URL served by the existing Tauri media protocol. It legitimately returns 404 until
 * Android Media3 has rendered and captured this video's first frame. */
export function nativeVideoThumbnailUrl(
  path: string | null | undefined,
  revision = 0,
): string {
  const digest = videoCasDigest(path);
  if (!digest || !isTauri() || !isAndroid()) return '';
  return assetUrl(
    `/video-thumbnails${path}${revision > 0 ? `?v=${revision}` : ''}`,
  );
}

/** Kept as a rollback switch while Android uses the WebView player over the Rust loopback stream. */
export const ANDROID_MEDIA3_ENABLED = false;

export interface LocalVideoStream {
  streamUrl: string;
  thumbnailUploadUrl: string;
  hasThumbnail: boolean;
}

/** Allocate a capability route on the process-wide Rust loopback video server. */
export async function createLocalVideoStream(
  path: string,
): Promise<LocalVideoStream | null> {
  if (!isTauri() || !isAndroid() || !videoCasDigest(path)) return null;
  return tauriInvoke<LocalVideoStream>('create_native_video_stream', { path });
}

/** Open an authenticated chat video in Android's native Media3 player when enabled. */
export async function openNativeVideo(path: string): Promise<boolean> {
  if (
    !ANDROID_MEDIA3_ENABLED ||
    !isTauri() ||
    !isAndroid() ||
    !window.SomsVideo
  )
    return false;
  const digest = videoCasDigest(path);
  if (!digest) return false;
  const stream = await createLocalVideoStream(path);
  if (!stream) return false;
  window.SomsVideo.open(
    stream.streamUrl,
    stream.thumbnailUploadUrl,
    digest,
    stream.hasThumbnail,
  );
  return true;
}

/**
 * Attempt to open an external link target outside the app. On the web this uses `window.open`
 * (new tab, noopener); browsers may refuse unsupported schemes. Under Tauri the target is
 * passed to the OS URL handler through a Rust command (tauri-plugin-opener).
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
 *  origin for the user to edit. Once server setup persists a real origin this reads false. The browser
 *  build is same-origin (`''`) but never hits this gate — the guard requires `isTauri()`. */
export function apiOriginIsEmpty(): boolean {
  return apiOrigin() === '';
}

/** Mirror one committed Rust configuration. Android records the pair without sending an
 * intermediate configuration back into Rust; the Rust configuration is authoritative at restart. */
export function syncServerOrigins(
  primary: string,
  secondary: string | null,
  active: string,
): void {
  loginPickPromise = null;
  apiOrigin.set(primary);
  apiOriginSecondary.set(secondary);
  window.SomsSecureStore?.recordServerOrigins(
    primary,
    secondary,
    secondary === active ? 'secondary' : 'primary',
  );
}

/** Restore the presentation signal from Rust without writing configuration or platform mirrors. */
export function syncApiOriginSignal(origin: string): void {
  const c = canonicalOrigin(origin);
  apiOrigin.set(c);
}

/** Which origin is currently ACTIVE — `'primary'` (normal) or `'secondary'` (a switch moved to the LAN
 *  origin). For the "正在使用内网服务器" indicator. Tauri only; returns `'primary'` in the browser build. */
export async function getOriginMode(): Promise<'primary' | 'secondary'> {
  if (!isTauri()) return 'primary';
  const mode = await tauriInvoke<string>('get_origin_mode');
  return mode === 'secondary' ? 'secondary' : 'primary';
}

/** The exact backend endpoint currently used by native HTTP transports.
 *
 * Rust exposes the authoritative active `ProxyState.api_origin` directly so the Web layer follows
 * failover to the currently selected endpoint.
 */
export async function getActiveApiOrigin(): Promise<string> {
  if (!isTauri()) return apiOrigin();
  return canonicalOrigin(await tauriInvoke<string>('get_active_api_origin'));
}

/** The login-init concurrent race — probe both origins' `/client/compat`, pick the reachable one, set Rust's active
 *  origin. Call BEFORE the auth request so login targets a reachable origin (on the LAN the public origin is
 *  hairpin-unreachable — a boot-time pick could be stale if the network changed before login). ONCE per
 *  process (a QR-poll loop reuses the result instead of re-racing every tick); a failure clears the cache so
 *  a retry re-races. No-op outside Tauri (returns the configured primary). */
let loginPickPromise: Promise<string> | null = null;
export function pickLoginOrigin(force = false): Promise<string> {
  if (!isTauri()) return Promise.resolve(apiOrigin());
  if (force) loginPickPromise = null;
  if (!loginPickPromise) {
    const pick = tauriInvoke<string>('init_pick_origin');
    loginPickPromise = pick
      .then((origin) => {
        return origin;
      })
      .catch((e) => {
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
