package com.soms.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * FCM message handler + the single source of notification rendering for ALL background paths.
 *
 * The backend (`PushService.dispatchForMessage`) sends data-only high-priority messages carrying the
 * identity-only wake-up — `{ type, ts, threadId, seq }`. There is no `notification` field, so the OS does
 * NOT auto-display anything: this service is always invoked (even when the OS has killed the app) and pulls
 * `POST /notifications/missed`, whose `data.notifications[]` carry the server-authored descriptor(s) — the
 * localized title/body + composited stacked-avatar icon + tag/renotify/kind semantics. [renderDescriptor]
 * maps each descriptor onto `NotificationCompat` with zero composition logic. The same descriptor is
 * rendered by the Web Push SW and the foreground Angular adapter — one source of truth.
 *
 * Foreground suppression: when the activity is visible (`appInForeground == true`) the live SSE connection
 * already delivered the message to the in-app UI, so FCM is a no-op. The server ALSO skips FCM for
 * recipients with a live SSE connection (`SseService.isUserOnline`); this flag is the client-side backstop
 * for the brief heartbeat-gap overlap.
 *
 * All three background paths (FCM real-time, the RealtimeService background path, the WorkManager 6h poll)
 * converge on [renderAwayNotification] → one coalesced away-notification at the stable [AWAY_NOTIF_ID]
 * (the descriptor's `tag` maps onto that id — replace-by-id, never stacks).
 */
class SomsMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(msg: RemoteMessage) {
        // Data-only: msg.notification is null; everything is in msg.data. Identity-only wake-up — the
        // push carries { type, ts, threadId, seq } (no body); route on `type`.
        val data = msg.data
        when (data["type"]) {
            "ADMIN_TEST" -> {
                // Admin test push: post the literal title/body as a notification — a delivery check.
                if (appInForeground) return
                notifyAdminTest(this, data["title"] ?: "Test", data["body"] ?: "")
            }
            "NEW_MESSAGE" -> {
                if (appInForeground) return // SSE handled it; suppress the system notification.
                // Wake → pull the missed-summary → render the server-authored descriptor(s). The push carries
                // no body; the missed-summary is the single data source.
                renderAwayNotification(this)
            }
        }
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

        /** Fetch the server-authored notification descriptors from `/notifications/missed` (no cursor → the
         *  current unread snapshot — the server-localized title/body + composited stacked-avatar icon), using
         *  the session token + the device locale. Shared by all three background paths (FCM re-query on each
         *  push, the WorkManager poll, the RealtimeService debounced background coalesce). Null on any
         *  failure (auth/network/parse) — callers simply skip rendering. */
        fun fetchDescriptors(ctx: Context): List<NotifDescriptor>? {
            val token = SomsSecureStore.getSessionToken(ctx)
            val origin = SomsSecureStore.getApiOrigin(ctx)
            SomsLog.d("Notif") { "fetchDescriptors tokenPresent=${token != null} originPresent=${origin != null}" }
            if (token == null || origin == null) {
                SomsLog.w("Notif") { "fetchDescriptors abort: missing creds (token=${token != null} origin=${origin != null})" }
                return null
            }
            val body = JSONObject().apply {
                // The away-summary high-water mark (`since`) — the newest message the client accounted for
                // before the WebView was suspended, persisted by SomsFcm.setMissedCursor. Absent on first-ever
                // boot → the server returns a `clear` descriptor (nothing new to show). NOTE: no `take` —
                // /notifications/missed is one-shot (pagination + `take` live on /missed-summary), and MissedDto
                // runs under forbidNonWhitelisted, so an extra field here is a hard HTTP 400 (it previously
                // silently broke EVERY Android away-notification path).
                val cursor = SomsSecureStore.getMissedCursor(ctx)
                if (cursor != null) {
                    put("since", JSONObject().put("threadId", cursor.first).put("seq", cursor.second))
                }
            }.toString()
            val locale = java.util.Locale.getDefault().toLanguageTag()
            val request = Request.Builder()
                .url("$origin${SomsSecureStore.API_PREFIX}/notifications/missed")
                .post(body.toRequestBody("application/json".toMediaType()))
                .addHeader("Authorization", "Bearer $token")
                .addHeader("Accept-Language", locale)
                .build()
            return try {
                HTTP.newCall(request).execute().use { resp ->
                    val raw = resp.body?.string()
                    SomsLog.d("Notif") { "fetchDescriptors code=${resp.code} bodyLen=${raw?.length ?: -1}" }
                    if (!resp.isSuccessful) {
                        SomsLog.w("Notif") { "fetchDescriptors non-2xx code=${resp.code} → null" }
                        return null
                    }
                    val list = NotifDescriptor.parseList(raw ?: return null)
                    SomsLog.d("Notif") { "fetchDescriptors parsed=${list.size} kinds=${list.map { it.kind }}" }
                    list
                }
            } catch (e: Exception) {
                SomsLog.w("Notif", e) { "fetchDescriptors exception ${e.javaClass.simpleName}: ${e.message}" }
                null
            }
        }

        /** Fetch the descriptors then render them — the single entry point for all three background paths
         *  (FCM / WorkManager / RealtimeService-background). Does a SYNCHRONOUS network fetch
         *  ([fetchDescriptors] → OkHttp `execute`), so the caller MUST be off the main thread: FCM's
         *  onMessageReceived and WorkManager's doWork already are; RealtimeService hops via its ioExecutor. */
        fun renderAwayNotification(ctx: Context) {
            val descriptors = fetchDescriptors(ctx)
            if (descriptors == null) {
                SomsLog.w("Notif") { "renderAwayNotification: fetchDescriptors=null → skip" }
                return
            }
            if (descriptors.isEmpty()) {
                SomsLog.d("Notif") { "renderAwayNotification: descriptors empty → skip" }
                return
            }
            renderDescriptors(ctx, descriptors)
        }

        /** Render the server-authored descriptor(s) as ONE coalesced away-notification at the stable
         *  [AWAY_NOTIF_ID] (replacing any prior one). A `kind:"clear"` descriptor cancels it. */
        fun renderDescriptors(ctx: Context, descriptors: List<NotifDescriptor>) {
            ensureChannel(ctx)
            val nm = ContextCompat.getSystemService(ctx, NotificationManager::class.java) ?: run {
                SomsLog.w("Notif") { "renderDescriptors: NotificationManager unavailable → skip" }
                return
            }
            // The server emits exactly one descriptor for the away-summary (message-summary, or clear when
            // nothing is unread+unmuted). Render the first; a clear cancels.
            val d = descriptors.firstOrNull() ?: run {
                SomsLog.d("Notif") { "renderDescriptors: firstOrNull null → cancel AWAY" }
                nm.cancel(AWAY_NOTIF_ID); return
            }
            // Surface the OS-level switches that silently swallow a notification: the app master toggle
            // (NotificationManagerCompat, pre/post-13) and the per-channel enabled flag (O+). If a
            // notification is "posted" per renderDescriptor but never appears, masterNotifOn=false or
            // channelOn=false is why — not a code bug.
            val masterOn = NotificationManagerCompat.from(ctx).areNotificationsEnabled()
            val channel = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) nm.getNotificationChannel(CHANNEL_MESSAGES) else null
            // A channel is "disabled" when the user dragged it to IMPORTANCE_NONE (blocked). channel==null →
            // pre-O (no per-channel toggle) or not-yet-created → treat as on; masterNotifOn covers the app gate.
            val channelOn = channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE
            // chImp is the smoking gun for silent notifications: IMPORTANCE_HIGH (4) = sound + heads-up banner;
            // DEFAULT (3) = sound, no banner; LOW (2) / MIN (1) = silent. If a notification posts but makes no
            // sound/banner, chImp<4 is why (a stale dev build pinned the channel, fixed by the CHANNEL_MESSAGES
            // id bump). renotify drives setOnlyAlertOnce — false silences every post after the first.
            SomsLog.i("Notif") {
                "renderDescriptors kind=${d.kind} title='${d.title.take(40)}' bodyLen=${d.body.length} icon=${d.icon != null} actions=${d.actions.size} masterNotifOn=$masterOn channelOn=$channelOn chImp=${channel?.importance} renotify=${d.renotify} appInFg=$appInForeground"
            }
            renderDescriptor(ctx, d)
        }

        /**
         * Render one server-authored descriptor onto `NotificationCompat`:
         *  - `kind:"clear"` → cancel the tagged notification;
         *  - `body` → `BigTextStyle` (the coalesced "X sent you N messages" — a count summary, not a
         *    per-person conversation, so BigTextStyle, not MessagingStyle);
         *  - `icon` → `setLargeIcon` (the fetched stacked-avatar PNG; null on fetch failure → omitted);
         *  - `renotify` → `setOnlyAlertOnce(!renotify)` (the server opts to re-alert); `silent` → `setSilent`.
         *
         * The count is in `body` (the server folds names + total) — fixes the prior Kotlin path that omitted
         * the count. Public so MainActivity's JS bridge can render a descriptor the WebView forwarded.
         */
        fun renderDescriptor(ctx: Context, d: NotifDescriptor) {
            ensureChannel(ctx)
            val nm = ContextCompat.getSystemService(ctx, NotificationManager::class.java) ?: return
            if (d.kind == "clear") {
                SomsLog.d("Notif") { "renderDescriptor kind=clear → cancel AWAY" }
                nm.cancel(AWAY_NOTIF_ID)
                return
            }
            val largeIcon = d.icon?.let { fetchBitmap(ctx, it) }
            SomsLog.d("Notif") { "renderDescriptor iconUrl='${d.icon}' largeIcon=${largeIcon != null}" }
            val intent = Intent(ctx, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val pendingIntent = PendingIntent.getActivity(
                ctx,
                AWAY_NOTIF_ID,
                intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val builder = NotificationCompat.Builder(ctx, CHANNEL_MESSAGES)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(d.title.ifEmpty { ctx.getString(R.string.app_name) })
                .setContentText(d.body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(d.body))
                .setAutoCancel(true)
                .setOnlyAlertOnce(!d.renotify)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setContentIntent(pendingIntent)
            if (d.silent == true) builder.setSilent(true)
            if (largeIcon != null) builder.setLargeIcon(largeIcon)
            // Action buttons (the summary carries a pure-frontend `dismiss`; a future single-message kind adds
            // `reply`). Each fires SomsActionReceiver with the action id + the descriptor's routing data + the
            // notification id this action lives on (so dismiss cancels ITS OWN notification, not a hardcoded
            // one). For `dismiss` the routing data is the new HWM cursor `{threadId, seq}` — the receiver
            // advances the away-HWM to it + cancels the shade, pure frontend (no POST, no read-watermark
            // change). A type:"text" action also collects an inline reply via RemoteInput. seq may legitimately
            // be 0 (a thread's first message) → guard on the -1 sentinel (>= 0), never > 0.
            for ((idx, a) in d.actions.withIndex()) {
                val pi = PendingIntent.getBroadcast(
                    ctx,
                    AWAY_NOTIF_ID + 1 + idx, // unique requestCode per action slot
                    Intent(ctx, SomsActionReceiver::class.java).apply {
                        putExtra(SomsActionReceiver.EXTRA_ACTION_ID, a.id)
                        putExtra(SomsActionReceiver.EXTRA_TAG, d.tag)
                        putExtra(SomsActionReceiver.EXTRA_NOTIF_ID, AWAY_NOTIF_ID)
                        val tid = d.data.optInt("threadId", -1)
                        if (tid >= 0) putExtra(SomsActionReceiver.EXTRA_THREAD_ID, tid)
                        val seq = d.data.optInt("seq", -1)
                        if (seq >= 0) putExtra(SomsActionReceiver.EXTRA_SEQ, seq)
                    },
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
                val actionBuilder = NotificationCompat.Action.Builder(R.drawable.ic_notification, a.title, pi)
                if (a.type == "text") {
                    actionBuilder.addRemoteInput(
                        RemoteInput.Builder(SomsActionReceiver.KEY_REPLY_TEXT).setLabel(a.title).build(),
                    )
                }
                builder.addAction(actionBuilder.build())
            }
            nm.notify(AWAY_NOTIF_ID, builder.build())
            SomsLog.i("Notif") { "notify AWAY posted id=$AWAY_NOTIF_ID" }
        }

        /** Fetch the composited stacked-avatar PNG at `iconUrl` as a Bitmap for `setLargeIcon`. The icon is
         *  server-composited (AvatarStackService) and ALWAYS relative to the API origin — resolved here and
         *  NEVER honored as an absolute URL, so the session Bearer below cannot leak to an arbitrary
         *  (federated / attacker-controlled) host the server might emit. Auth-N only (any logged-in user can
         *  fetch any avatar / notif-icon), so the Bearer authorizes. Null on any failure (the notification
         *  renders without an icon — graceful, never blocks the away-summary). */
        private fun fetchBitmap(ctx: Context, iconUrl: String): android.graphics.Bitmap? {
            val token = SomsSecureStore.getSessionToken(ctx) ?: return null
            val origin = SomsSecureStore.getApiOrigin(ctx) ?: return null
            val fullUrl = "$origin$iconUrl"
            val request = Request.Builder()
                .url(fullUrl)
                .get()
                .addHeader("Authorization", "Bearer $token")
                .build()
            return try {
                HTTP.newCall(request).execute().use { resp ->
                    if (!resp.isSuccessful) return null
                    val bytes = resp.body?.bytes() ?: return null
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                }
            } catch (e: Exception) {
                null
            }
        }

        /** Build the foreground-service persistent notification (minimal, IMPORTANCE_LOW, ongoing) — the
         *  FGS-required "a notification must exist" surface, deliberately NOT a message surface (messages
         *  go to [renderDescriptor]). Tap → opens the app. */
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
                .setSmallIcon(R.drawable.ic_notification)
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
                .setSmallIcon(R.drawable.ic_notification)
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

        /** Create the "messages" (HIGH) + "background" (LOW) channels (required on Android 8+) if absent.
         *  Idempotent — getNotificationChannel returns null until a channel exists. Called eagerly at
         *  process start (SomsApplication.onCreate) so the app is registered as notification-capable before
         *  any post, and re-called lazily by every render path below as a cheap safety net.
         *
         *  Gotcha: Android pins a channel's importance + vibration at creation and REFUSES to raise either
         *  afterwards (recreating the SAME id also restores the old setting). So this IMPORTANCE_HIGH +
         *  vibration take effect on a fresh install — if a prior build ever created "messages" lower, a
         *  delete-and-reinstall of the app (or a channel-id bump) is the only reset. */
        internal fun ensureChannel(ctx: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val nm = ContextCompat.getSystemService(ctx, NotificationManager::class.java) ?: return
            if (nm.getNotificationChannel(CHANNEL_MESSAGES) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH).apply {
                        description = "Incoming chat messages"
                        // IMPORTANCE_HIGH alerts by default (sound + heads-up banner). Vibration is enabled
                        // EXPLICITLY with a distinct message pattern (double pulse) so a new message is felt
                        // even on silent. Channel-level — the authoritative setting on Android 8+ (notification-
                        //  level setVibrate() is ignored on O+); pinned at creation like importance.
                        enableVibration(true)
                        vibrationPattern = longArrayOf(0, 200, 100, 200)
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
