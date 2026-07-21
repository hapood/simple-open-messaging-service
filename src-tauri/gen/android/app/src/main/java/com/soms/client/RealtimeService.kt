package com.soms.client

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
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
import java.util.concurrent.TimeUnit

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
    private var eventSource: EventSource? = null
    private val handler = Handler(Looper.getMainLooper())
    private var attempt = 0

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_FOREGROUND -> {
                // App visible: the process has foreground priority, so the connection survives without FGS
                // status — drop the persistent notification (annoying while in use) but keep the stream.
                Log.i(TAG, "onStartCommand foreground (drop persistent notification)")
                dropForegroundNotification()
            }
            ACTION_RETRY -> {
                // User tapped the disconnected chip (SomsFcm.retryNow → this action): cancel the pending
                // backoff + reset the attempt counter so the immediate retry starts fresh, then let the
                // openStream() below reconnect at once. openStream() is a no-op if a stream is already open,
                // so a retry while healthy is harmless. Parity with the worker's retry-now / Rust's sse_net.
                Log.i(TAG, "onStartCommand retry-now (cancel backoff + reconnect)")
                handler.removeCallbacks(reopenTask)
                attempt = 0
            }
            else -> {
                // ACTION_BACKGROUND (app backgrounded + toggle on) OR a START_STICKY system restart:
                // promote to a dataSync foreground service so the system keeps the connection alive.
                Log.i(TAG, "onStartCommand background/sticky (promote to foreground service)")
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

    /** Open the /events stream if it isn't already. Stops the service if the credentials aren't present
     *  (logged out / not configured) — nothing to stream. Idempotent: a re-delivered intent (fg/bg cycle)
     *  never tears down a healthy connection. */
    private fun openStream() {
        if (eventSource != null) return // already connected
        val token = SomsSecureStore.getSessionToken(this) ?: run { stopSelf(); return }
        val origin = SomsSecureStore.getApiOrigin(this) ?: run { stopSelf(); return }
        pushConnState("connecting")
        val request = Request.Builder()
            .url("$origin${SomsSecureStore.API_PREFIX}/events")
            .addHeader("Authorization", "Bearer $token")
            .addHeader("Accept", "text/event-stream")
            .cacheControl(okhttp3.CacheControl.FORCE_NETWORK)
            .build()
        Log.i(TAG, "openStream url=${request.url} attempt=$attempt")
        eventSource = sseFactory.newEventSource(request, listener)
    }

    private val listener = object : EventSourceListener() {
        override fun onOpen(eventSource: EventSource, response: Response) {
            Log.i(TAG, "onOpen connected code=${response.code}")
            this@RealtimeService.pushConnState("open")
        }

        override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
            // The 25s liveness heartbeat is a NAMED `ping` event (data "{}") — not a payload, skip it.
            if (type == "ping") return
            attempt = 0 // any real frame resets the reconnect backoff

            // FORCE_LOGOUT: the session was invalidated (all-device logout / password change / admin
            // purge). Forward so the JS layer performs the logout, then stop — the token is dead and
            // reconnecting would just 401-loop.
            if (type == "FORCE_LOGOUT") {
                forwardToJs(type, data)
                stopSelf()
                return
            }

            if (SomsMessagingService.appInForeground) {
                // Foreground: hand every event to the WebView. It dispatches via WebsocketService exactly
                // as the sse.worker would, so all downstream consumers (chat-box, threadlist, …) are
                // unchanged. `data` is the server-serialized JSON, valid as a JS expression.
                forwardToJs(type, data)
            } else if (type == "NEW_MESSAGE") {
                // Background: the WebView is suspended. Coalesce a burst of messages into ONE away-
                // notification via a debounced summary fetch (the same surface FCM/WorkManager use).
                scheduleAwayCoalesce()
            }
            // Background non-message events are UI-only; the HWM catch-up + threadlist refresh cover them
            // on resume, so they're deliberately dropped here.
        }

        override fun onClosed(eventSource: EventSource) {
            Log.i(TAG, "onClosed → scheduleReopen")
            this@RealtimeService.eventSource = null
            this@RealtimeService.pushConnState("reconnecting")
            scheduleReopen()
        }

        override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
            Log.w(TAG, "onFailure code=${response?.code} ${t?.javaClass?.simpleName}: ${t?.message}")
            this@RealtimeService.eventSource = null
            // 401 → token expired/revoked; the next foreground login re-issues. Stop rather than spin.
            if (response?.code == 401) {
                stopSelf()
                return
            }
            this@RealtimeService.pushConnState("reconnecting")
            scheduleReopen()
        }
    }

    /** Forward one event to the WebView. `type` is quoted via [SomsBridge.jsonStr]; `data` is the raw JSON
     *  the server serialized (valid as a JS expression), defaulted to `{}` if the frame carried none. */
    private fun forwardToJs(type: String?, data: String) {
        val safeType = type ?: "message"
        val safeData = if (data.isBlank()) "{}" else data
        SomsBridge.eval("window.__SOMS_EVENT__ && window.__SOMS_EVENT__(${SomsBridge.jsonStr(safeType)}, $safeData);")
    }

    /** Push the native connection state to the WebView so the ConnectionBanner reflects Kotlin-owned
     *  connect/reconnect/close (the JS side cannot observe the native socket itself — the worker transport
     *  infers this from its own loop, but the native transport only receives what Kotlin tells it). Mirrors
     *  the worker's `state` messages; a no-op until the native transport installs the hook. */
    private fun pushConnState(state: String) {
        connState = state
        SomsBridge.eval("window.__SOMS_CONN_STATE__ && window.__SOMS_CONN_STATE__(${SomsBridge.jsonStr(state)});")
    }

    /** Debounced away-notification: collapse a burst of background NEW_MESSAGE frames into one summary
     *  fetch + one coalesced notification (cancel + reschedule on each new frame). */
    private fun scheduleAwayCoalesce() {
        handler.removeCallbacks(awayCoalesceTask)
        handler.postDelayed(awayCoalesceTask, COALESCE_DELAY_MS)
    }

    private val awayCoalesceTask = Runnable {
        // Fetch the server-authored descriptors + render the coalesced away-notification (one entry point
        // shared with the FCM + WorkManager paths).
        SomsMessagingService.renderAwayNotification(this@RealtimeService)
    }

    /** The pending backoff-driven reopen, posted by [scheduleReopen] and cancelled by the ACTION_RETRY
     *  path so a manual retry never races the scheduled one. A named Runnable (not an anonymous lambda) so
     *  removeCallbacks can target it selectively without clearing the unrelated away-coalesce task. */
    private val reopenTask = Runnable { openStream() }

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
        handler.removeCallbacksAndMessages(null)
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
        /** The most recently pushed connection state. Process-global so the SomsFcm @JavascriptInterface
         *  can read it synchronously (a freshly-booted WebView needs the current state, but [pushConnState]
         *  only fires on transitions). Volatile: written on the SSE thread, read on the JS bridge thread. */
        @Volatile
        var connState: String = "closed"
    }
}
