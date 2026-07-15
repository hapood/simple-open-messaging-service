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
import org.json.JSONArray
import java.util.concurrent.TimeUnit

/** logcat tag for this otherwise-headless foreground service. The FGS runs with no WebView and used to
 *  be a total black box — these calls (onOpen / onEvent / onClosed / onFailure) are the only way to see
 *  whether the native SSE is connecting, receiving frames, and why it drops. Native `Log.*` → logcat is
 *  the legitimate debug surface for a headless service (distinct from the web no-console.log rule). */
private const val TAG = "SomsFgs"

/**
 * The domestic real-time background path: a `dataSync` foreground service holding a native SSE to
 * `/notifications/stream` so messages reach the device in near-real-time when FCM is unavailable (no
 * Google Play Services, mainland China). Complements the WorkManager 6h poller — the FGS covers the
 * active "just backgrounded" window (until Android 15's ~6h/day dataSync cap), WorkManager takes the
 * long tail.
 *
 * Two notifications, deliberately separate:
 *  - The FGS persistent notification ([SomsMessagingService.buildForegroundNotification], IMPORTANCE_LOW,
 *    ongoing) — exists only to satisfy the FGS "a notification must be shown" requirement. NOT a message
 *    surface; stays minimal/unobtrusive.
 *  - The coalesced away-notification ([SomsMessagingService.notifyAwaySummary], on the "messages"
 *    channel) — the actual message alert, updated in place as snapshots arrive. One notification, never
 *    per-message spam. Shared with the FCM + WorkManager paths via the dedup cursor.
 *
 * Auth: the scoped 30-day notification token (NOT the access token — that's short-lived and the WebView
 * owns its renewal). Read from SomsSecureStore; a 401 from the stream means the token expired/revoked →
 * the next foreground login re-issues, so the service stops rather than spinning.
 *
 * Lifecycle: started by MainActivity.onStop when the FGS toggle is on + a token is present; stopped by
 * onResume (user returned), onTimeout (6h cap hit), the toggle turning off, or logout. START_STICKY so
 * the system restarts it if killed (it re-reads the token + re-opens the stream).
 */
class MessageSyncService : Service() {

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

    override fun onCreate() {
        super.onCreate()
        startForegroundCompat()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "onStartCommand fgsEnabled running")
        startForegroundCompat()
        openStream()
        return START_STICKY
    }

    /** Bound-mode is unused (this is a started foreground service); satisfy the abstract base. */
    override fun onBind(intent: Intent?): IBinder? = null

    /** Promote to foreground with the persistent notification. The typed `dataSync` startForeground is
     *  required on Android 14+ (UPSIDE_DOWN_CAKE); older versions fall back to the 2-arg overload and
     *  rely on the manifest-declared type. */
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

    /** Open (or re-open) the notification stream. Stops the service if the credentials aren't present
     *  (logged out / not configured) — nothing to stream. */
    private fun openStream() {
        val token = SomsSecureStore.getNotificationToken(this) ?: run { stopSelf(); return }
        val origin = SomsSecureStore.getApiOrigin(this) ?: run { stopSelf(); return }
        eventSource?.cancel()
        val request = Request.Builder()
            .url("$origin${SomsSecureStore.API_PREFIX}/notifications/stream")
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
        }

        override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
            // The 25s liveness heartbeat is a NAMED `ping` event carrying `{}` (see common/sse-stream.ts) —
            // not a snapshot, so skip it before the array parse. Only `NOTIF_SYNC` frames carry snapshots.
            if (type == "ping") return
            // Each frame's data is a bare JSON array (the snapshot) — parse, advance the dedup cursor per
            // thread so FCM/WorkManager skip them, then render the coalesced away-notification.
            val snapshot = try {
                SomsMessagingService.parseSnapshotArray(JSONArray(data))
            } catch (e: Exception) {
                Log.w(TAG, "onEvent parse failed: ${e.message} dataLen=${data.length}")
                return
            }
            val first = snapshot.firstOrNull()
            Log.i(TAG, "onEvent items=${snapshot.size} first=${first?.let { "t=${it.threadId} name=${it.displayName} unread=${it.unreadCount}" }}")
            snapshot.forEach { item ->
                item.latestMessageId?.let { mid ->
                    SomsSecureStore.advanceCursor(this@MessageSyncService, item.threadId, mid)
                }
            }
            SomsMessagingService.notifyAwaySummary(this@MessageSyncService, snapshot)
            attempt = 0 // a successful frame resets the reconnect backoff
        }

        override fun onClosed(eventSource: EventSource) {
            Log.i(TAG, "onClosed → scheduleReopen")
            scheduleReopen()
        }

        override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
            Log.w(TAG, "onFailure code=${response?.code} ${t?.javaClass?.simpleName}: ${t?.message}")
            // 401 → token expired/revoked; the next foreground login re-issues. Stop rather than spin.
            if (response?.code == 401) {
                stopSelf()
                return
            }
            scheduleReopen()
        }
    }

    /** Re-open the stream after exponential backoff (capped ~32s). okhttp-sse already retries some
     *  transient failures; this covers server-initiated closes + the rest. No-op once stopping. */
    private fun scheduleReopen() {
        if (stopping) return
        attempt = (attempt + 1).coerceAtMost(6)
        val delayMs = (1000L shl attempt.coerceAtMost(5)).coerceAtMost(30_000)
        handler.postDelayed({ openStream() }, delayMs)
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
        super.onDestroy()
    }
}
