package com.soms.client

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/** logcat tag for this otherwise-headless service. The FGS runs with no WebView and used to
 *  be a total black box — these calls (onOpen / onEvent / onClosed / onFailure) are the only way to see
 *  whether the native SSE is connecting, receiving frames, and why it drops. Native `Log.*` → logcat is
 *  the legitimate debug surface for a headless service (distinct from the web no-console.log rule). */
private const val TAG = "SomsFgs"

/** Coalesce window for the background away-notification: a burst of NEW_MESSAGE frames collapses into one
 *  summary fetch + one notification (cancel + reschedule on each new frame). */
private const val COALESCE_DELAY_MS = 500L

/**
 * The single native-owned realtime channel. A (optionally foreground) service holding a long-lived SSE
 * to `GET /events` with the no-expiry session token, **continuous across fg/bg**. This is the Android half
 * of "one connection, native-owned": the WebView does NOT open its own `/events` worker on Android — it
 * consumes the frames this service forwards via `window.__SOMS_EVENT__`. (Web/desktop still run their own
 * `sse.worker.ts`.) Supersedes `MessageSyncService`, which held a *parallel* `/notifications/stream`
 * alongside the WebView's `/events` — two connections swapping on fg/bg, neither handing data to the
 * other. One session token now authenticates both this stream and the background `/notifications/missed`
 * fetchers (FCM / WorkManager).
 *
 * **Lifecycle (the service must run while foregrounded — the WebView's only event source is this stream):**
 *  - Started right after login (`SomsFcm.setSessionToken`) and on every `onResume`, with
 *    `ACTION_FOREGROUND`: while the app is visible the process already has foreground priority, so the
 *    connection survives as a plain service with NO persistent notification.
 *  - `onStop` + the background toggle on re-delivers `ACTION_BACKGROUND`, promoting the already-running
 *    service to a `dataSync` foreground service (persistent notification) so the system keeps it alive in
 *    the background. Toggle off → `stopService` (background delivery falls back to FCM / WorkManager).
 *  - A `START_STICKY` system restart (null intent) also promotes, so a killed-and-restarted service
 *    survives on its own — it re-reads the session token from [SomsSecureStore] and reconnects with no
 *    help from the WebView or Rust (a system-restarted service cannot bring the Tauri runtime back up).
 *
 * **Foreground** ([SomsMessagingService.appInForeground] true): every named event is forwarded to the
 * WebView via `window.__SOMS_EVENT__(type, data)` — the JS `WebsocketService` feeds the existing
 * `eventSubject`, so all downstream consumers are unchanged. OkHttp's built-in `Last-Event-ID` resume
 * (NEW_MESSAGE frames carry `id` = message id) bridges transient drops; a fresh connect after a process
 * restart is backstopped by the WebView's HWM catch-up on resume.
 *
 * **Background:** the WebView is suspended, so forwarding is pointless; a NEW_MESSAGE instead triggers a
 * debounced fetch (`/notifications/missed` — the server-authored descriptor) rendered as ONE coalesced
 * away-notification via [SomsMessagingService.renderAwayNotification]. Non-message events are UI-only
 * and dropped — the WebView's HWM catch-up + threadlist refresh cover them on resume, so no frame is lost.
 * FORCE_LOGOUT is forwarded (so JS logs out) then stops the service.
 *
 * Connection state is pushed to the WebView via `window.__SOMS_CONN_STATE__` so the ConnectionBanner
 * reflects Kotlin-owned connect/reconnect/close (the JS side cannot observe the native socket).
 */
class RealtimeService : Service() {

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS) // long-lived stream — no read timeout
        .pingInterval(25, TimeUnit.SECONDS) // TCP keepalive; mirrors the backend's 25s SSE heartbeat
        .build()
    private val sseFactory = EventSources.createFactory(client)

    @Volatile private var stopping = false
    // @Volatile: written on the main looper (openStream / reopenTask), read on OkHttp's SSE dispatcher
    // thread (the onClosed/onFailure identity check). Without it the SSE thread can see a stale reference
    // and mis-fire the FORCE_RECONNECT race guard (null the fresh socket → a duplicate stream opens).
    @Volatile private var eventSource: EventSource? = null
    private val handler = Handler(Looper.getMainLooper())

    /** Single-thread executor for the background away-notification fetch+render — keeps the SYNCHRONOUS
     *  /notifications/missed call (and the icon fetch) off the main thread. Android forbids network on the
     *  UI thread (NetworkOnMainThreadException); [awayCoalesceTask] is posted to the main-looper [handler]
     *  for debounce timing, so it hops the actual work onto here. Serial so a burst of coalesces can't race
     *  the notification's replace-by-id. Shut down in [onDestroy]. */
    private val ioExecutor = Executors.newSingleThreadExecutor { r -> Thread(r, "SomsAwayIo") }
    private var attempt = 0

    /** Single-flight lock for [establishConnection]. Probes + the open decision are serialized through this so
     *  two concurrent triggers (e.g. onFailure firing while ConnectivityManager.onAvailable races in) launch at
     *  most ONE resolve+open cycle, not two divergent streams. Guards [establishing] + the eventSource!=null
     *  re-check at the open step. */
    private val establishLock = Any()
    /** True while an [establishConnection] cycle is mid-flight (between accepting the trigger and finishing the
     *  resolve+open / scheduleReopen). Read+written under [establishLock]. */
    private var establishing = false
    /** The OS network is up (a default network is present). Flipped by [networkCallback]: onLost→false (push
     *  Disconnected, stop attempting — a probe would only fail), onAvailable→true (race + reconnect). Read in
     *  [establishConnection]'s guard so no doomed probe/open runs while the device is offline. @Volatile: written
     *  on the ConnectivityManager binder thread, read on ioExecutor / the main looper. */
    @Volatile private var networkOnline = true
    /** The system connectivity service, held so [onDestroy] can unregister [networkCallback]. Null only before
     *  [onCreate] / when the service has no Context (never in practice). */
    private var connectivityManager: ConnectivityManager? = null

    /** OS network-state observer (the default network). `onLost` = device went offline → Disconnected (distinct
     *  from server-unreachable Reconnecting — no backoff countdown, no point retrying); `onAvailable` = network
     *  (re)gained → race both origins and reconnect. Registered in [onCreate]; registerDefaultNetworkCallback
     *  fires `onAvailable` immediately on register when online (harmless — [establishConnection] single-flights
     *  the dedup vs the onStartCommand open). */
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onLost(network: Network) {
            SomsLog.i("Rt") { "network onLost → disconnected (stop attempting)" }
            networkOnline = false
            handler.removeCallbacks(reopenTask)
            eventSource?.cancel()
            eventSource = null
            pushConnState("disconnected")
        }

        override fun onAvailable(network: Network) {
            SomsLog.i("Rt") { "network onAvailable → race + reconnect" }
            networkOnline = true
            attempt = 0
            establishConnection("reconnecting")
        }
    }

    override fun onCreate() {
        super.onCreate()
        // Observe OS connectivity so the banner distinguishes "device offline" (Disconnected) from "server
        // unreachable" (Reconnecting), and so [establishConnection] stops launching doomed probes while offline.
        // registerDefaultNetworkCallback tracks the DEFAULT network — onLost fires only when the device loses
        // its last default route (true offline), not on a Wi-Fi↔cellular handoff (that's onAvailable for the new
        // default). Normal permission (ACCESS_NETWORK_STATE); registered for the service's lifetime.
        connectivityManager = getSystemService(ConnectivityManager::class.java)
        connectivityManager?.registerDefaultNetworkCallback(networkCallback)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        SomsLog.i("Rt") { "onStartCommand action=${intent?.action} (null=sticky-restart) streamOpen=${eventSource != null} startId=$startId" }
        when (intent?.action) {
            ACTION_FOREGROUND -> {
                // App visible: the process has foreground priority, so the connection survives without FGS
                // status — cancel any background NEW_MESSAGE debounce, drop the persistent notification
                // (annoying while in use), but keep the stream.
                SomsLog.i("Rt") { "onStartCommand foreground (cancel away debounce + drop persistent notification)" }
                handler.removeCallbacks(awayCoalesceTask)
                dropForegroundNotification()
            }
            ACTION_RETRY -> {
                // User tapped the disconnected chip (SomsFcm.retryNow → this action): cancel the pending
                // backoff + reset the attempt counter so the immediate retry starts fresh, then let the
                // openStream() below reconnect at once. openStream() is a no-op if a stream is already open,
                // so a retry while healthy is harmless. Parity with the worker's retry-now / Rust's sse_net.
                SomsLog.i("Rt") { "onStartCommand retry-now (cancel backoff + reconnect)" }
                handler.removeCallbacks(reopenTask)
                attempt = 0
            }
            ACTION_FORCE_RECONNECT -> {
                // HELLO-timeout (SomsFcm.forceReconnect → this action): the open stream is unusable — no
                // HELLO within the deadline — so CANCEL it + reopen, so the fresh connection re-pushes HELLO.
                // Unlike ACTION_RETRY (which openStream() no-ops when already open), this tears down the
                // dead-open socket first. JS cannot close the native socket, so the WebView asks Kotlin. The
                // listener's identity check ensures the canceled socket's late onClosed/onFailure can't
                // clobber the fresh socket establishConnection() opens below.
                SomsLog.i("Rt") { "onStartCommand force-reconnect (cancel open stream + reopen)" }
                handler.removeCallbacks(reopenTask)
                attempt = 0
                if (eventSource != null) {
                    eventSource?.cancel()
                    eventSource = null
                }
                // Re-resolve (probe + race) + reopen on the chosen origin; establishConnection surfaces
                // "reconnecting" itself. Return early so the tail openStream() — which establishes as a calm
                // "connecting" — can't override this path's urgent reconnect label.
                establishConnection("reconnecting")
                return START_STICKY
            }
            else -> {
                // ACTION_BACKGROUND (app backgrounded + toggle on) OR a START_STICKY system restart:
                // promote to a dataSync foreground service so the system keeps the connection alive.
                SomsLog.i("Rt") { "onStartCommand background/sticky (promote to foreground service)" }
                startForegroundCompat()
            }
        }
        openStream()
        return START_STICKY
    }

    /** Bound-mode is unused (this is a started service); satisfy the abstract base. */
    override fun onBind(intent: Intent?): IBinder? = null

    /** Promote to foreground with the persistent notification. The typed `dataSync` startForeground is
     *  required on Android 14+ (UPSIDE_DOWN_CAKE); older versions fall back to the 2-arg overload and
     *  rely on the manifest-declared type. No-op-safe to call repeatedly. */
    private fun startForegroundCompat() {
        val notif = SomsMessagingService.buildForegroundNotification(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                SomsMessagingService.FGS_PERSISTENT_ID,
                notif,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(SomsMessagingService.FGS_PERSISTENT_ID, notif)
        }
    }

    /** Leave foreground service state and remove the persistent notification. Used on resume so the
     *  "Background sync" notification isn't shown while the user is in the app. The stream is unaffected
     *  (foreground state is only about process priority / survivability, not the connection itself). */
    private fun dropForegroundNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION") stopForeground(true)
        }
    }

    /** Open the /events stream if it isn't already. Idempotent: a re-delivered intent (fg/bg cycle) never
     *  tears down a healthy connection. Delegates the origin decision + the actual open to
     *  [establishConnection] (the probe→flip→race state machine) — the boot/resume path establishes as a calm
     *  "connecting"; failure paths call [establishConnection] directly with "reconnecting". */
    private fun openStream() {
        if (eventSource != null) {
            SomsLog.d("Rt") { "openStream no-op (eventSource already open)" }
            return // already connected
        }
        establishConnection("connecting")
    }

    /** The single origin-selection + open entry point — Kotlin is the origin AUTHORITY on Android (it owns the
     *  FGS, including background; Rust is passive and accepts whatever Kotlin signals via [signalRust]).
     *
     *  Single-flight ([establishLock]): at most one resolve+open cycle runs at a time, so two concurrent
     *  triggers (onFailure racing ConnectivityManager.onAvailable) launch one stream, not two. The resolve is
     *  off-main ([ioExecutor]) because it does blocking health probes; the open ([openStreamOn]) is non-blocking
     *  and safe off-main.
     *
     *  - `asState` is the banner state to surface while resolving ("connecting" for boot, "reconnecting" for a
     *    failure/retry). Overridden to "disconnected" when the OS network is down.
     *  - [OriginSelector] races both origins and returns the first healthy one (both-down ⇒ null).
     *    null ⇒ [scheduleReopen] (backoff, whose retry re-runs this).
     *  - On a chosen origin: [signalRust] so Rust's API transports follow (no API⇄SSE origin split), then open. */
    private fun establishConnection(asState: String) {
        synchronized(establishLock) {
            if (establishing || eventSource != null) return
            if (!networkOnline) { pushConnState("disconnected"); return }
            establishing = true
        }
        pushConnState(asState)
        ioExecutor.execute {
            try {
                val token = SomsSecureStore.getSessionToken(this)
                if (token == null) {
                    SomsLog.w("Rt") { "establish abort (no token) → stopSelf" }
                    stopSelf(); return@execute
                }
                val origin = OriginSelector.select(this)
                if (origin == null) {
                    // Both origins down (or the single configured origin is down) → backoff; the retry re-runs
                    // establishConnection (which races again). The "reconnecting" + countdown are pushed by
                    // scheduleReopen. Don't clear `establishing` before scheduleReopen — it's cleared in finally.
                    scheduleReopen(); return@execute
                }
                // Re-check under the lock: the network may have dropped, or another path may have opened a
                // stream, during the probe. If so, abandon this open (no duplicate stream, no doomed connect).
                synchronized(establishLock) {
                    if (!networkOnline || eventSource != null) return@execute
                }
                signalRust(origin)
                openStreamOn(origin, token)
            } finally {
                synchronized(establishLock) { establishing = false }
            }
        }
    }

    /** Build + open the /events EventSource on the resolved origin. Non-blocking (OkHttp connects on its
     *  dispatcher thread; the listener fires there), so this is safe to call from [ioExecutor]. The [eventSource]
     *  assignment is the single writer the listener's identity check reads (@Volatile). Does NOT push state — the
     *  banner keeps the [establishConnection] `asState` ("connecting" boot / "reconnecting" failure) until onOpen
     *  flips it to "open", so a recovery doesn't flicker reconnecting→connecting→open (expand→collapse→gone). */
    private fun openStreamOn(origin: String, token: String) {
        val request = Request.Builder()
            .url("$origin${SomsSecureStore.API_PREFIX}/events")
            .addHeader("Authorization", "Bearer $token")
            .addHeader("Accept", "text/event-stream")
            .cacheControl(okhttp3.CacheControl.FORCE_NETWORK)
            .build()
        SomsLog.i("Rt") { "openStreamOn url=${request.url} attempt=$attempt" }
        eventSource = sseFactory.newEventSource(request, listener)
    }

    /** Signal Rust the origin Kotlin decided is active, so Rust's API transports ([api_request] / media / upload)
     *  follow it — no API⇄SSE origin split. Rust is passive on Android ([runtime_switch] is a no-op there); it
     *  accepts this via the `set_active_origin` command. Foreground-only in effect: [SomsBridge.eval] is a no-op
     *  while no WebView is attached (background), which is fine — background has no API traffic to diverge from,
     *  and the next foreground [openStreamOn] re-signals. */
    private fun signalRust(origin: String) {
        SomsBridge.eval("window.__SOMS_SET_ACTIVE_ORIGIN__ && window.__SOMS_SET_ACTIVE_ORIGIN__(${SomsBridge.jsonStr(origin)});")
    }

    private val listener = object : EventSourceListener() {
        override fun onOpen(eventSource: EventSource, response: Response) {
            SomsLog.i("Rt") { "onOpen connected code=${response.code}" }
            this@RealtimeService.pushConnState("open")
        }

        override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
            // The 25s liveness heartbeat is a NAMED `ping` event (data "{}") — not a payload, skip it. Logged
            // at debug (NOT returned silently): in a background no-message window this is the single proof the
            // stream is still alive — one line every ~25s. If these stop while the device is backgrounded, the
            // connection is silently dead even though the service process is alive.
            if (type == "ping") {
                SomsLog.d("Rt") { "ping (liveness) appInFg=${SomsMessagingService.appInForeground}" }
                return
            }
            attempt = 0 // any real frame resets the reconnect backoff
            // Cache HELLO + merge incremental revision frames (runs in fg AND bg, so the cache stays fresh
            // while the WebView is suspended). SomsFcm.replayHello hands a re-attached WebView this merged
            // HELLO — a retained open stream does not re-push HELLO on its own.
            cacheHelloFrame(type, data)
            if (type == "HELLO") reconcileActiveCall(data)
            // THE diagnostic line: `appInFg` here is the ground-truth branch selector. If a backgrounded
            // device shows appInFg=true, the foreground branch runs on a suspended WebView (frame vanishes,
            // no notification) — that's the bug. If appInFg=false + branch=background but no notification
            // appears, the failure is downstream in fetchDescriptors/renderDescriptors (see Soms/Notif).
            SomsLog.i("Rt") {
                "onEvent type=$type id=$id dataLen=${data.length} appInFg=${SomsMessagingService.appInForeground}"
            }

            // FORCE_LOGOUT: the session was invalidated (all-device logout / password change / admin
            // purge). Forward so the JS layer performs the logout, then stop — the token is dead and
            // reconnecting would just 401-loop.
            if (type == "FORCE_LOGOUT") {
                SomsLog.i("Rt") { "FORCE_LOGOUT → forward + stopSelf" }
                forwardToJs(type, data)
                stopSelf()
                return
            }

            // CALL_SIGNAL / CALL_EVENT: hand to the native WebRTC owner IN ADDITION to the WebView mirror
            // below. This runs in BOTH fg and bg (above the appInForeground gate, like cacheHelloFrame) — a
            // CALL_SIGNAL ICE candidate MUST reach the native RTCPeerConnection even while the WebView is
            // suspended (the whole point of native-owned media: the media leg must not die when the chrome
            // does). forwardToJs (the fg branch) mirrors the frame to the Angular call UI; CallController
            // owns the actual peer connection. A no-op when no live call matches (CallController.onFrame
            // drops a stray frame after the call ended).
            if (type == "CALL_SIGNAL" || type == "CALL_EVENT") {
                CallController.onFrame(type, data)
            }

            if (SomsMessagingService.appInForeground) {
                // Foreground: hand every event to the WebView. It dispatches via WebsocketService exactly
                // as the sse.worker would, so all downstream consumers (chat-box, threadlist, …) are
                // unchanged. `data` is the server-serialized JSON, valid as a JS expression.
                SomsLog.d("Rt") { "branch=foreground → forwardToJs (WebView is suspended if appInFg lags reality)" }
                forwardToJs(type, data)
            } else if (type == "NEW_MESSAGE") {
                // Background: the WebView is suspended. Coalesce a burst of messages into ONE away-
                // notification via a debounced summary fetch (the same surface FCM/WorkManager use).
                SomsLog.d("Rt") { "branch=background NEW_MESSAGE → scheduleAwayCoalesce" }
                scheduleAwayCoalesce()
            } else {
                // Background non-message events are UI-only; the HWM catch-up + threadlist refresh cover them
                // on resume, so they're deliberately dropped here.
                SomsLog.d("Rt") { "branch=background non-message → dropped (resume catch-up covers it)" }
            }
        }

        override fun onClosed(eventSource: EventSource) {
            // Stale callback (a FORCE_RECONNECT-canceled socket's late close): ignore ENTIRELY — the fresh
            // socket is already open, so no nulling, no "reconnecting" push (no banner flicker), no reopen.
            if (this@RealtimeService.eventSource !== eventSource) return
            SomsLog.i("Rt") { "onClosed → scheduleReopen" }
            this@RealtimeService.eventSource = null
            this@RealtimeService.pushConnState("reconnecting")
            scheduleReopen()
        }

        override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
            Log.w(TAG, "onFailure code=${response?.code} ${t?.javaClass?.simpleName}: ${t?.message}")
            // Stale callback (a FORCE_RECONNECT-canceled socket's late failure): ignore entirely (see onClosed).
            if (this@RealtimeService.eventSource !== eventSource) return
            this@RealtimeService.eventSource = null
            // 401 → the session token is dead (revoked / password change / admin purge / all-device logout).
            // Clear it so onResume's token-presence check stops reconnecting into a 401 loop, AND forward a
            // synthetic FORCE_LOGOUT so the WebView runs its logout flow (the same path the in-band
            // FORCE_LOGOUT event uses). The eval is best-effort — a suspended/absent WebView is a no-op; the
            // cleared token still terminates the reconnect cycle on the next foreground.
            if (response?.code == 401) {
                SomsSecureStore.setSessionToken(this@RealtimeService, null)
                SomsBridge.eval("window.__SOMS_EVENT__ && window.__SOMS_EVENT__('FORCE_LOGOUT', {});")
                stopSelf()
                return
            }
            // Network failure (not 401): re-resolve + reopen via establishConnection. OriginSelector races both
            // configured addresses, immediately adopts the first healthy one, and cancels the loser. If both are
            // down, establishConnection falls through to scheduleReopen (backoff, whose retry races again).
            // Kotlin owns this decision and signals Rust (signalRust) so the API
            // transports follow — no origin split. (401 is handled above — session-dead.)
            this@RealtimeService.establishConnection("reconnecting")
        }
    }

    /** Forward one event to the WebView. `type` is quoted via [SomsBridge.jsonStr]; `data` is the raw JSON
     *  the server serialized (valid as a JS expression), defaulted to `{}` if the frame carried none. */
    private fun forwardToJs(type: String?, data: String) {
        val safeType = type ?: "message"
        val safeData = if (data.isBlank()) "{}" else data
        // webViewAttached=false → SomsBridge.eval is a no-op (no activity attached). webViewAttached=true
        // while the activity is STOPPED → evaluateJavascript is accepted but the JS engine is paused, so the
        // call queues and may never flush. Both look like "frame vanished." This line distinguishes
        // "forwarding ran" from "the background branch never ran" — pair it with the onEvent branch log.
        SomsLog.d("Rt") {
            "forwardToJs type=$safeType webViewAttached=${SomsBridge.webView != null} appInFg=${SomsMessagingService.appInForeground}"
        }
        SomsBridge.eval("window.__SOMS_EVENT__ && window.__SOMS_EVENT__(${SomsBridge.jsonStr(safeType)}, $safeData);")
    }

    /** Cache HELLO / merge one incremental revision frame into the cached HELLO (the value
     *  [SomsFcmInterface.replayHello] hands a re-attached WebView). Delegates the pure merge rules to
     *  [HelloMerger] (JVM-testable); runs in foreground AND background (called from onEvent before the fg/bg
     *  forwarding branch) so the cache stays fresh while the WebView is suspended. [synchronized][helloLock]
     *  against [replayCachedHello] so a concurrent replay never sees a mid-mutation toString. */
    private fun cacheHelloFrame(type: String?, data: String) {
        val t = type ?: return
        synchronized(helloLock) { cachedHello = HelloMerger.merge(cachedHello, t, data) }
    }

    /** HELLO activeCall recovery: a reconnecting / freshly-booted callee that MISSED the CALL_EVENT{incoming}
     *  (the SSE was down when it fired) re-derives the incoming state from the HELLO's activeCall summary. If
     *  the call is still ringing + this is the callee + the native FSM is idle, re-seed incoming (ring + notify
     *  + arm accept) — otherwise the user could never answer a call that arrived while offline / reconnecting,
     *  and the caller would stall on connecting with no answer. The caller (isCaller) + post-ringing states
     *  (accepted/connected) are skipped: the caller initiates, and an already-accepted call belongs to another
     *  device. */
    private fun reconcileActiveCall(helloData: String) {
        try {
            val active = JSONObject(helloData).optJSONObject("activeCall") ?: return
            val sid = active.optString("callSid", "")
            val state = active.optString("state", "")
            val peerId = active.optInt("peerUserId", 0)
            val isCaller = active.optBoolean("isCaller", false)
            val callType = active.optString("callType", "AUDIO")
            if (sid.isEmpty() || peerId == 0) return
            if (state == "ringing" && !isCaller && CallController.phase == "idle") {
                SomsLog.i("Rt") { "HELLO activeCall: re-seeding incoming (missed CALL_EVENT) sid=$sid peer=$peerId" }
                // name/avatar/threadId are absent from the summary → name-only notification; seedIncoming is
                // idempotent + rings (the user missed the original ring).
                CallController.seedIncoming(sid, peerId, "", "", 0, callType)
                // The recovery missed the original incoming (SSE was down) → if backgrounded, ALSO post the
                // call notification (seedIncoming rings but doesn't notify). startIncoming's seedIncoming is a
                // no-op now (already seeded); its startIncomingForeground posts the notification.
                if (!SomsMessagingService.appInForeground) {
                    CallService.startIncoming(this, sid, peerId, "", "", 0, callType)
                }
            }
        } catch (e: Exception) {
            SomsLog.w("Rt") { "reconcileActiveCall failed: ${e.message}" }
        }
    }

    /** Push the native connection state to the WebView so the ConnectionBanner reflects Kotlin-owned
     *  connect/reconnect/close (the JS side cannot observe the native socket itself — the worker transport
     *  infers this from its own loop, but the native transport only receives what Kotlin tells it). Mirrors
     *  the worker's `state` messages; a no-op until the native transport installs the hook. */
    private fun pushConnState(state: String) {
        connState = state
        SomsLog.i("Rt") { "connState=$state" }
        SomsBridge.eval("window.__SOMS_CONN_STATE__ && window.__SOMS_CONN_STATE__(${SomsBridge.jsonStr(state)});")
    }

    /** Debounced away-notification: collapse a burst of background NEW_MESSAGE frames into one summary
     *  fetch + one coalesced notification (cancel + reschedule on each new frame). */
    private fun scheduleAwayCoalesce() {
        handler.removeCallbacks(awayCoalesceTask)
        handler.postDelayed(awayCoalesceTask, COALESCE_DELAY_MS)
        SomsLog.d("Rt") { "scheduleAwayCoalesce posted (debounce ${COALESCE_DELAY_MS}ms)" }
    }

    private val awayCoalesceTask = Runnable {
        // The app may have resumed during the debounce. Activity lifecycle is authoritative on Android;
        // never start a stale /notifications/missed fetch after foregrounding.
        if (SomsMessagingService.appInForeground) {
            SomsLog.d("Rt") { "awayCoalesceTask skipped: app is foreground" }
            return@Runnable
        }
        // renderAwayNotification does a SYNCHRONOUS network fetch — it MUST run off the main thread
        // (NetworkOnMainThreadException otherwise). This Runnable is on the main-looper handler for the
        // debounce timing; hop the fetch+render onto ioExecutor. NotificationManager.notify is thread-safe,
        // so rendering stays on the bg thread (no hop back to main). Shared entry point with FCM/WorkManager.
        SomsLog.d("Rt") { "awayCoalesceTask firing → renderAwayNotification (off-main)" }
        ioExecutor.execute {
            SomsMessagingService.renderAwayNotification(this@RealtimeService, allowAlert = true)
        }
    }

    /** The pending backoff-driven reopen, posted by [scheduleReopen] and cancelled by the ACTION_RETRY /
     *  onLost paths so neither a manual retry nor an offline transition races the scheduled one. Re-resolves via
     *  [establishConnection] (probe + concurrent race) so a reconnect after both origins were down finds the one
     *  that came back. A named Runnable (not an anonymous lambda) so removeCallbacks can target it selectively
     *  without clearing the unrelated away-coalesce task. */
    private val reopenTask = Runnable { establishConnection("reconnecting") }

    /** Re-open the stream after exponential backoff (capped ~32s). okhttp-sse already retries some
     *  transient failures; this covers server-initiated closes + the rest. No-op once stopping. */
    private fun scheduleReopen() {
        if (stopping) return
        handler.removeCallbacks(reopenTask) // never stack two pending reopens
        attempt = (attempt + 1).coerceAtMost(6)
        val delayMs = (1000L shl attempt.coerceAtMost(5)).coerceAtMost(30_000)
        // Announce the scheduled delay so the WebView's countdown chip can tick (the JS side owns the live
        // clock). Both call sites push "reconnecting" immediately before this, so the order is
        // state→deadline. openStream() pushes the next state (open/reconnecting), which clears it.
        pushReconnectIn(delayMs)
        handler.postDelayed(reopenTask, delayMs)
    }

    /** Push the scheduled-ms-until-next-reconnect to the WebView so the ConnectionBanner can render a live
     *  countdown (mirrors [pushConnState]; a no-op until the native transport installs the hook). */
    private fun pushReconnectIn(ms: Long) {
        SomsBridge.eval("window.__SOMS_RECONNECT_IN__ && window.__SOMS_RECONNECT_IN__($ms);")
    }

    /** Android 15 (API 35) dataSync time budget exhausted (~6h/24h). Stop cleanly; the WorkManager
     *  poller (if its toggle is on) continues the long tail. The system calls this only on API 35+. */
    override fun onTimeout(startId: Int) {
        stopSelf()
    }

    override fun onDestroy() {
        stopping = true
        connectivityManager?.unregisterNetworkCallback(networkCallback)
        handler.removeCallbacksAndMessages(null)
        ioExecutor.shutdownNow()
        eventSource?.cancel()
        eventSource = null
        pushConnState("closed")
        super.onDestroy()
    }

    companion object {
        /** App resumed → run as a plain service (the process has foreground priority); drop the
         *  persistent notification. Delivered by MainActivity.onResume + SomsFcm.setSessionToken. */
        const val ACTION_FOREGROUND = "com.soms.client.action.FOREGROUND"
        /** App backgrounded + toggle on → promote to a dataSync foreground service so the connection
         *  survives in the background. Delivered by MainActivity.onStop. */
        const val ACTION_BACKGROUND = "com.soms.client.action.BACKGROUND"
        /** User tapped the disconnected chip → cancel the pending backoff + reconnect now (the JS→native
         *  retry channel, parity with the worker's retry-now and Rust's sse_net(online:true)). Delivered
         *  by SomsFcm.retryNow. */
        const val ACTION_RETRY = "com.soms.client.action.RETRY"
        /** HELLO-timeout (the open stream sent no HELLO within the deadline) → cancel the open socket +
         *  reopen so the fresh connection re-pushes HELLO. Unlike ACTION_RETRY (a no-op when open), this
         *  tears down the dead-open socket. Delivered by SomsFcm.forceReconnect. */
        const val ACTION_FORCE_RECONNECT = "com.soms.client.action.FORCE_RECONNECT"
        /** The most recently pushed connection state. Process-global so the SomsFcm @JavascriptInterface
         *  can read it synchronously (a freshly-booted WebView needs the current state, but [pushConnState]
         *  only fires on transitions). Volatile: written on the SSE thread, read on the JS bridge thread. */
        @Volatile
        var connState: String = "closed"
        /** The last HELLO frame merged with every incremental revision frame (STATE_REV_UPDATED /
         *  NEW_MESSAGE) — the FRESH handshake a re-attached
         *  WebView needs, since a retained open `/events` stream does NOT re-push HELLO on its own (it is
         *  sent once per register). Stored as a NATIVE JSONObject (deserialized once on HELLO, mutated in
         *  place by [cacheHelloFrame], serialized once by [replayCachedHello]) — no per-frame parse/reserialize.
         *  Process-global so the bridge reads it; @Volatile for the cross-thread ref read. */
        @Volatile
        var cachedHello: JSONObject? = null
        /** Serializes [cacheHelloFrame]'s in-place JSONObject mutations against [replayCachedHello]'s
         *  toString, so a concurrent replay never observes a mid-mutation (torn) JSON. */
        private val helloLock = Any()

        /** Serialize the cached HELLO once (at replay time), under [helloLock] so a concurrent SSE-frame
         *  merge can't tear it. Null when no HELLO has been cached yet (the caller then no-ops + the facade's
         *  HELLO-timeout backstop force-reconnects for a fresh one). */
        fun replayCachedHello(): String? = synchronized(helloLock) { cachedHello?.toString() }
    }
}
