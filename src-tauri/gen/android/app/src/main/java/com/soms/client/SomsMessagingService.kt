package com.soms.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** One thread's unread state — the shape of `/notifications/missed` `summary:true` `data[]`. The single
 *  shape all three background paths (FCM / WorkManager / RealtimeService-background) fetch and feed into
 *  [SomsMessagingService.notifyAwaySummary]. */
data class MissedItem(
    val threadId: String,
    val displayName: String,
    val unreadCount: Int,
    val latestMessageId: String?,
)

/**
 * FCM message handler + the single source of notification rendering for ALL background paths.
 *
 * The backend (PushService.dispatchForMessage) sends data-only high-priority messages carrying the
 * wake-up signal — { threadId, messageId, contentType, ts[, preview] }. There is no `notification`
 * field, so the OS does NOT auto-display anything: this service is always invoked (even when the OS
 * has killed the app) and builds the visible notification itself, keeping the canonical Message row as
 * the single source of truth.
 *
 * Foreground suppression: when the activity is visible (appInForeground == true) the live SSE
 * connection already delivered the message to the in-app UI, so FCM is a no-op. The server ALSO skips
 * FCM for recipients with a live SSE connection (SseService.isUserOnline); this flag is the
 * client-side backstop for the brief heartbeat-gap overlap.
 *
 * Notification UX: all three background paths (FCM real-time, the RealtimeService background path, the
 * WorkManager 6h poll) converge on ONE coalesced away-notification ([notifyAwaySummary]) at a stable id — the user
 * never sees one notification per message/thread, just one accumulating "{senders} sent you messages",
 * updated in place. The per-thread dedup cursor in SomsSecureStore keeps the
 * three paths from double-processing the same message.
 */
class SomsMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(msg: RemoteMessage) {
        // Data-only: msg.notification is null; everything is in msg.data.
        val data = msg.data
        // Admin test push (from the admin console): post the literal title/body as a notification — a
        // delivery check, distinct from a real message wake-up. Bypasses the cursor + away-snapshot path.
        if (data["type"] == "admin-test") {
            if (appInForeground) return
            notifyAdminTest(this, data["title"] ?: "Test", data["body"] ?: "")
            return
        }
        val threadId = data["threadId"] ?: return
        if (appInForeground) return // SSE handled it; suppress the system notification.

        // Advance the shared dedup cursor so NotificationSyncWorker / RealtimeService (the domestic
        // fallbacks) don't re-notify this same message — FCM, FGS, and WorkManager share one cursor.
        data["messageId"]?.let { mid -> if (mid.isNotEmpty()) SomsSecureStore.advanceCursor(this, threadId, mid) }
        // Coalesce: re-fetch the unread snapshot and render ONE away-notification listing every sender
        // (never one notification per message). onMessageReceived runs on an FCM background thread, so
        // the synchronous HTTP fetch is safe here.
        renderAwayNotification(this)
    }

    override fun onNewToken(token: String) {
        // Token rotation. Stash it for the SomsFcm @JavascriptInterface and, if the webview is alive,
        // tell the web app to re-register with the backend. If the app is dead, the new token sits in
        // the holder; MainActivity re-fetches and emits it on the next launch.
        SomsBridge.FcmToken.current = token
        SomsBridge.eval("window.__SOMS_FCM_TOKEN__ && window.__SOMS_FCM_TOKEN__(${jsonString(token)});")
    }

    companion object {
        const val CHANNEL_MESSAGES = "messages"
        const val CHANNEL_BACKGROUND = "background"
        const val EXTRA_THREAD_ID = "soms_thread_id"

        /** Stable id for the coalesced away-notification — `notify(sameId, …)` replaces, never stacks. */
        const val AWAY_NOTIF_ID = 0x5
        /** Stable id for the foreground-service persistent notification (FGS-required). */
        const val FGS_PERSISTENT_ID = 0x6
        /** Stable id for an admin test-push notification (separate from the away-notification). */
        const val ADMIN_TEST_NOTIF_ID = 0x7

        /** True while MainActivity is visible. Set from MainActivity.onResume/onStop — the
         *  Android-native ground truth for "is the user looking at the app right now." */
        @Volatile
        var appInForeground: Boolean = false

        private val HTTP: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()

        /** Parse the `/notifications/missed` JSON array (the `data` field) into [MissedItem]s. Shared
         *  by the WorkManager poller (which already has the array) and [fetchMissedSnapshot]. */
        fun parseSnapshotArray(arr: JSONArray): List<MissedItem> {
            val out = ArrayList<MissedItem>(arr.length())
            for (i in 0 until arr.length()) {
                val obj = arr.optJSONObject(i) ?: continue
                val mid = obj.optString("latestMessageId")
                out.add(
                    MissedItem(
                        threadId = obj.optString("threadId"),
                        displayName = obj.optString("displayName"),
                        unreadCount = obj.optInt("unreadCount"),
                        latestMessageId = mid.takeIf { obj.has("latestMessageId") && !obj.isNull("latestMessageId") && mid.isNotEmpty() },
                    ),
                )
            }
            return out
        }

        /** Parse the full `{ code, message, data: [...] }` envelope. Null on any shape problem. */
        fun parseSnapshot(payload: String): List<MissedItem>? {
            return try {
                val obj = JSONObject(payload)
                if (obj.optInt("code", -1) != 0) null else parseSnapshotArray(obj.optJSONArray("data") ?: JSONArray())
            } catch (e: Exception) {
                null
            }
        }

        /** Fetch the current unread-threads snapshot from `/notifications/missed` (`summary:true` — the
         *  server-resolved displayName/unreadCount shape, since raw message rows carry no display names)
         *  using the session token. Shared by all three background paths: the FCM re-query on each push,
         *  the WorkManager poll, and the RealtimeService debounced background coalesce. Null on any
         *  failure (auth/network/parse) — callers simply skip rendering. */
        fun fetchMissedSnapshot(ctx: Context): List<MissedItem>? {
            val token = SomsSecureStore.getSessionToken(ctx) ?: return null
            val origin = SomsSecureStore.getApiOrigin(ctx) ?: return null
            val body = JSONObject().put("summary", true).toString()
            val request = Request.Builder()
                .url("$origin${SomsSecureStore.API_PREFIX}/notifications/missed")
                .post(body.toRequestBody("application/json".toMediaType()))
                .addHeader("Authorization", "Bearer $token")
                .build()
            return try {
                HTTP.newCall(request).execute().use { resp ->
                    if (!resp.isSuccessful) return null
                    parseSnapshot(resp.body?.string() ?: return null)
                }
            } catch (e: Exception) {
                null
            }
        }

        /** FCM-path convenience: re-query the snapshot, then render the coalesced away-notification. */
        fun renderAwayNotification(ctx: Context) {
            val snapshot = fetchMissedSnapshot(ctx) ?: return
            notifyAwaySummary(ctx, snapshot)
        }

        /**
         * Render ONE coalesced away-notification listing every sender, replacing any prior one (stable
         * [AWAY_NOTIF_ID]). Empty snapshot → cancel. The single rendering target for all three background
         * paths so the user sees one accumulating notification, never per-message spam. `setOnlyAlertOnce`
         * means updates after the first post are silent (no re-buzz / heads-up pop).
         */
        fun notifyAwaySummary(ctx: Context, snapshot: List<MissedItem>) {
            ensureChannel(ctx)
            val nm = ContextCompat.getSystemService(ctx, NotificationManager::class.java) ?: return
            if (snapshot.isEmpty()) {
                nm.cancel(AWAY_NOTIF_ID)
                return
            }
            val text = composeAwayText(ctx, snapshot.map { it.displayName })
            val intent = Intent(ctx, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val pendingIntent = PendingIntent.getActivity(
                ctx,
                AWAY_NOTIF_ID,
                intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val notif = NotificationCompat.Builder(ctx, CHANNEL_MESSAGES)
                .setSmallIcon(android.R.drawable.ic_dialog_email)
                .setContentTitle(ctx.getString(R.string.app_name))
                .setContentText(text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setContentIntent(pendingIntent)
                .build()
            nm.notify(AWAY_NOTIF_ID, notif)
        }

        /** "Alice sent you messages" / "Alice, Bob +2 sent you messages". Caps the listed names at 2,
         *  folding the rest into a "+N" count to keep the shade tidy; de-dupes empty names. */
        private fun composeAwayText(ctx: Context, names: List<String>): String {
            val distinct = LinkedHashSet(names.filter { it.isNotEmpty() }).toList()
            val joined = when {
                distinct.isEmpty() -> ""
                distinct.size <= 2 -> distinct.joinToString(", ")
                else -> distinct.take(2).joinToString(", ") + " +" + (distinct.size - 2)
            }
            return ctx.getString(R.string.notif_missed_coalesced, joined)
        }

        /** Build the foreground-service persistent notification (minimal, IMPORTANCE_LOW, ongoing) — the
         *  FGS-required "a notification must exist" surface, deliberately NOT a message surface (messages
         *  go to [notifyAwaySummary]). Tap → opens the app. */
        fun buildForegroundNotification(ctx: Context): Notification {
            ensureChannel(ctx)
            val intent = Intent(ctx, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val pendingIntent = PendingIntent.getActivity(
                ctx,
                FGS_PERSISTENT_ID,
                intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            return NotificationCompat.Builder(ctx, CHANNEL_BACKGROUND)
                .setSmallIcon(android.R.drawable.ic_dialog_email)
                .setContentTitle(ctx.getString(R.string.app_name))
                .setContentText(ctx.getString(R.string.notif_fgs_running))
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setContentIntent(pendingIntent)
                .build()
        }

        /** Admin test push: post the literal title/body at a dedicated id (separate from the real
         *  away-notification so a test doesn't disturb it). High priority so the admin can see it land. */
        private fun notifyAdminTest(ctx: Context, title: String, body: String) {
            ensureChannel(ctx)
            val nm = ContextCompat.getSystemService(ctx, NotificationManager::class.java) ?: return
            val intent = Intent(ctx, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val pendingIntent = PendingIntent.getActivity(
                ctx,
                ADMIN_TEST_NOTIF_ID,
                intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val notif = NotificationCompat.Builder(ctx, CHANNEL_MESSAGES)
                .setSmallIcon(android.R.drawable.ic_dialog_email)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setContentIntent(pendingIntent)
                .build()
            nm.notify(ADMIN_TEST_NOTIF_ID, notif)
        }

        /** Lazily create the "messages" (HIGH) + "background" (LOW) channels (required on Android 8+).
         *  Idempotent — getNotificationChannel returns null once a channel exists. */
        internal fun ensureChannel(ctx: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val nm = ContextCompat.getSystemService(ctx, NotificationManager::class.java) ?: return
            if (nm.getNotificationChannel(CHANNEL_MESSAGES) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH).apply {
                        description = "Incoming chat messages"
                    },
                )
            }
            if (nm.getNotificationChannel(CHANNEL_BACKGROUND) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_BACKGROUND, "Background sync", NotificationManager.IMPORTANCE_LOW).apply {
                        description = "Keeps message sync running in the background"
                    },
                )
            }
        }

        /** JSON-encode a string for safe embedding in evaluateJavascript (quotes + control chars). */
        private fun jsonString(s: String): String =
            buildString {
                append('"')
                for (c in s) when (c) {
                    '\\' -> append("\\\\")
                    '"' -> append("\\\"")
                    '\n' -> append("\\n")
                    '\r' -> append("\\r")
                    '\t' -> append("\\t")
                    else -> if (c.code < 0x20) append("\\u%04x".format(c.code)) else append(c)
                }
                append('"')
            }
    }
}
