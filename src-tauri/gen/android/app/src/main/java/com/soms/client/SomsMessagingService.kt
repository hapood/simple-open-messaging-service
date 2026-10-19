package com.soms.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
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
 * Data-only push receiver and per-thread Android notification renderer.
 * FCM supplies threadFeedEndId; background SSE and periodic work share the Rust
 * thread-feed executor. No notification body is fetched by Kotlin.
 */
class SomsMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(msg: RemoteMessage) {
        // Data-only: msg.notification is null; everything is in msg.data. Identity-only wake-up — the
        // push carries { type, threadFeedEndId } (no body); route on `type`.
        val data = msg.data
        when (data["type"]) {
            "PUSH_HEALTH_PROBE" -> {
                // Silent end-to-end diagnostic. Confirm receipt directly from the native service so the
                // result remains reliable even if the WebView is suspended or the process was recreated.
                data["probeId"]?.let { acknowledgePushProbe(this, it) }
            }
            "ADMIN_TEST" -> {
                // Admin test push: post the literal title/body as a notification — a delivery check.
                if (appInForeground) return
                notifyAdminTest(this, data["title"] ?: "Test", data["body"] ?: "")
            }
            "NEW_MESSAGE" -> {
                // Keep FCM as a wake even in the foreground: SSE can be temporarily disconnected.
                // Both wakes synchronize through Rust's cursor, so only the winner projects cards.
                val target = data["threadFeedEndId"]?.toIntOrNull()?.takeIf { it >= 0 } ?: return
                // Firebase's callback has a short lifetime; network + SQLite projection belongs in
                // expedited work, which may finish even if this process is reclaimed after the callback.
                try {
                    NotificationPushWorker.enqueue(this, target)
                } catch (e: RuntimeException) {
                    SomsLog.w("Notif", e) { "could not enqueue push projection" }
                }
            }
            "CALL_INCOMING" -> {
                // FCM also covers a temporarily disconnected SSE while the app is visible. Both paths post
                // the same CallStyle notification; avoid a redundant start when SSE already seeded this call.
                // A high-priority FCM grant permits the phoneCall FGS start when backgrounded or killed.
                val sid = data["callSid"] ?: return
                // A late/duplicate push for a call already past incoming (the SSE path answered/ended it) —
                // don't re-ring. seedIncoming is itself idempotent on the same incoming callSid; this guards
                // the ring for a call the SSE already advanced.
                val p = CallController.phase
                if (CallController.callSid == sid && p != "idle") return
                val callerUserId = data["callerUserId"]?.toIntOrNull()
                val callerAccount = data["callerAccount"]?.takeIf { it.isNotEmpty() } ?: return
                val callerNamespaceId = data["callerNamespaceId"]?.toIntOrNull() ?: -1
                val threadId = data["threadId"]?.toIntOrNull()?.takeIf { it > 0 } ?: return
                // A push must match this account's local P2P thread. Never ring by guessing an identity
                // when the thread is missing or its cached coordinates disagree with the payload.
                val peer = ClientStateDb.getCallPeer(this, callerAccount, callerNamespaceId, threadId)
                    ?: return
                val callType = data["callType"] ?: "AUDIO"
                SomsLog.i("Notif") { "CALL_INCOMING sid=$sid from=$callerUserId type=$callType -> ring" }
                CallController.seedIncoming(
                    sid, callerUserId ?: 0, callerAccount, callerNamespaceId,
                    peer.name, peer.avatarDataUrl(), threadId, callType,
                )
                CallService.startIncoming(
                    this, sid, callerAccount, callerNamespaceId, threadId, callType,
                    peer.name, peer.avatarDataUrl(),
                )
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
        // v2 is intentional: setShowBadge() is immutable after channel creation, and older builds created
        // "background" with the badge-enabled default.
        const val CHANNEL_BACKGROUND = "background_sync_v1"
        const val CHANNEL_DIAGNOSTICS = "diagnostics"
        const val EXTRA_THREAD_ID = "soms_thread_id"
        const val EXTRA_SESSION_ID = "soms_session_id"
        const val EXTRA_API_ORIGIN = "soms_api_origin"

        /** Stable id for the coalesced away-notification — `notify(sameId, …)` replaces, never stacks. */
        const val AWAY_NOTIF_ID = 0x5
        /** Stable id for the foreground-service persistent notification (FGS-required). */
        const val FGS_PERSISTENT_ID = 0x6
        /** Stable id for an admin test-push notification (separate from the away-notification). */
        const val ADMIN_TEST_NOTIF_ID = 0x7

        /** Legacy group identifiers retained only to remove notifications posted by older builds. */
        private const val LEGACY_GROUP_KEY = "soms_messages"
        private const val LEGACY_GROUP_SUMMARY_ID = 0x8
        /** Per-thread notification ids are THREAD_NOTIF_BASE + threadId (offset clear of AWAY/FGS/ADMIN/SUMMARY
         *  + the JS seq range 0x100+). threadId is a small DB id → no Int overflow. */
        const val THREAD_NOTIF_BASE = 0x10000


        /** Process-local sound/vibration throttle. It does not participate in message visibility or cursors. */
        private val alertThrottle2s = AlertThrottle(2_000L, SystemClock::elapsedRealtime)
        private val alertThrottle5s = AlertThrottle(5_000L, SystemClock::elapsedRealtime)

        /** Derive the stable notification id for a per-thread card from its threadId. */
        private fun threadNotifId(threadId: Int): Int = NotifThreadLogic.notifId(THREAD_NOTIF_BASE, threadId)


        /** True while MainActivity is visible. Set from MainActivity.onResume/onStop — the
         *  Android-native ground truth for "is the user looking at the app right now." */
        @Volatile
        var appInForeground: Boolean = false

        @Volatile
        var activeThreadId: Int = -1

        private val HTTP: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()
        private val notificationProjectionGate = NotificationProjectionGate()

        private fun acknowledgePushProbe(ctx: Context, probeId: String) {
            val token = SomsSecureStore.getSessionToken(ctx) ?: return
            val origin = SomsSecureStore.getActiveOrigin(ctx) ?: return
            val request = Request.Builder()
                .url("$origin${SomsSecureStore.API_PREFIX}/devices/push-probes/$probeId/ack")
                .post("{}".toRequestBody("application/json".toMediaType()))
                .addHeader("Authorization", "Bearer $token")
                .build()
            try {
                HTTP.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        SomsLog.w("Notif") { "FCM probe ack rejected code=${response.code}" }
                    }
                }
            } catch (e: Exception) {
                SomsLog.w("Notif") { "FCM probe ack failed: ${e.message}" }
            }
        }

        /** SSE, FCM and scheduled polls share one single-flight Rust projection lane.
         * A newer target replaces the pending end id; -1 requests a full catch-up poll. */
        fun renderAwayNotification(ctx: Context, allowAlert: Boolean, threadFeedEndId: Int = -1) {
            if (!notificationProjectionGate.tryStart(allowAlert, threadFeedEndId)) return
            var next: NotificationProjectionGate.Wake? = NotificationProjectionGate.Wake(allowAlert, threadFeedEndId)
            while (next != null) {
                val wake = next
                runCatching { renderAwayNotificationOnce(ctx, wake.allowAlert, wake.target) }
                    .onFailure { e -> SomsLog.w("Notif", e) { "native notification synchronization failed" } }
                next = notificationProjectionGate.nextOrFinish()
            }
        }

        /** Foreground wakes use the same coalescing lane as FCM and background SSE. */
        fun renderForegroundNotification(ctx: Context, threadFeedEndId: Int) {
            renderAwayNotification(ctx, allowAlert = true, threadFeedEndId = threadFeedEndId)
        }

        /** Execute an already synchronized Rust batch. No network/projection work is scheduled here. */
        fun renderNativeBatch(ctx: Context, batch: NativeNotificationBatch, isCurrent: () -> Boolean) {
            if (!isCurrent()) return
            val descriptors = batch.descriptors(ClientStateDb.getNotificationPreviewMode(),
                ctx.getString(R.string.notif_private_body), ctx.getString(R.string.notif_message_retracted),
                ctx.getString(R.string.notif_message_removed))
            renderDescriptors(ctx, if (appInForeground) descriptors.filter {
                it.data.optInt("threadId", -1) != activeThreadId
            } else descriptors, allowAlert = true, isCurrent = isCurrent)
        }

        private fun renderAwayNotificationOnce(ctx: Context, allowAlert: Boolean, target: Int) {
            val userId = SomsSecureStore.getCurrentUserId(ctx) ?: return
            val token = SomsSecureStore.getSessionToken(ctx) ?: return
            val batch = RustRuntimeBridge.synchronizeNotifications(userId, target)
            val descriptors = batch.descriptors(ClientStateDb.getNotificationPreviewMode(),
                ctx.getString(R.string.notif_private_body), ctx.getString(R.string.notif_message_retracted),
                ctx.getString(R.string.notif_message_removed))
            RustRuntimeBridge.withCurrentSession(batch.loginSessionId) {
                if (SomsSecureStore.getCurrentUserId(ctx) == userId &&
                    SomsSecureStore.getSessionToken(ctx) == token) {
                    renderDescriptors(ctx, if (appInForeground) descriptors.filter {
                        it.data.optInt("threadId", -1) != activeThreadId
                    } else descriptors, allowAlert)
                    if (appInForeground) {
                        val committed = JSONObject(batch.metadata).getJSONObject("commitEvent")
                        SomsBridge.eval("window.__SOMS_EVENT__ && window.__SOMS_EVENT__($committed);")
                    }
                }
            }
        }

        /** Apply a notification delta. Every background entry point uses the same process-wide alert
         * throttle; threads absent from the delta remain unchanged. */
        fun renderDescriptors(ctx: Context, descriptors: List<NotifDescriptor>, allowAlert: Boolean,
                              isCurrent: () -> Boolean = { true }) {
            if (descriptors.isEmpty() || !isCurrent()) return
            ensureChannel(ctx)
            val nm = ContextCompat.getSystemService(ctx, NotificationManager::class.java) ?: run {
                SomsLog.w("Notif") { "renderDescriptors: NotificationManager unavailable → skip" }
                return
            }
            if (!isCurrent()) return
            nm.cancel(AWAY_NOTIF_ID)
            renderThreadDescriptors(
                ctx,
                nm,
                descriptors.filter { it.kind == "thread-message" },
                allowAlert,
                isCurrent,
            )
        }

        /** One independent MessagingStyle card per conversation, without Android notification grouping. */
        private fun renderThreadDescriptors(
            ctx: Context,
            nm: NotificationManager,
            descriptors: List<NotifDescriptor>,
            allowAlert: Boolean,
            isCurrent: () -> Boolean,
        ) {
            // Stable IDs replace named conversations; absent threads remain untouched.
            val policy = ClientStateDb.getNotificationAlertPolicy()
            var alertSlot = allowAlert && when (policy) {
                "cooldown_2s" -> alertThrottle2s.tryClaim()
                "cooldown_5s" -> alertThrottle5s.tryClaim()
                else -> true
            }
            for (d in descriptors) {
                if (!isCurrent()) return
                val tid = d.data.optInt("threadId", -1)
                if (tid < 0) continue
                val id = threadNotifId(tid)
                if (d.count == 0) {
                    nm.cancel(id)
                    continue
                }
                val alertThisCard = if (policy == "once_per_thread") allowAlert else alertSlot
                postThreadNotification(
                    ctx,
                    nm,
                    id,
                    d,
                    alertThisCard,
                    onlyAlertOnce = policy == "once_per_thread",
                    isCurrent = isCurrent,
                )
                if (policy != "once_per_thread") alertSlot = false
            }
            if (!isCurrent()) return
            nm.cancel(LEGACY_GROUP_SUMMARY_ID)
            SomsLog.i("Notif") { "renderDescriptors: ${descriptors.size} conversation cards appInFg=$appInForeground" }
        }

        /** Post one conversation card. Tap deep-links into the thread. */
        private fun postThreadNotification(
            ctx: Context,
            nm: NotificationManager,
            id: Int,
            d: NotifDescriptor,
            allowAlert: Boolean,
            onlyAlertOnce: Boolean,
            isCurrent: () -> Boolean,
        ) {
            val sessionId = SomsSecureStore.getSessionId(ctx) ?: return
            val origin = SomsSecureStore.getApiOrigin(ctx) ?: return
            val avatarImages = NotificationAvatars.resolve(ctx, d.messages)
            val tid = d.data.optInt("threadId", -1)
            val intent = Intent(ctx, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                if (tid > 0) putExtra(EXTRA_THREAD_ID, tid.toString())
                putExtra(EXTRA_SESSION_ID, sessionId)
                putExtra(EXTRA_API_ORIGIN, origin)
                // Account-specific identity keeps a later account's card from rewriting this tap.
                data = android.net.Uri.parse("soms-notification://session/$sessionId/thread/$tid?origin=${android.net.Uri.encode(origin)}")
            }
            val pendingIntent = PendingIntent.getActivity(
                ctx, id, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val builder = NotificationCompat.Builder(ctx, CHANNEL_MESSAGES)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(d.title.ifEmpty { ctx.getString(R.string.app_name) })
                .setContentText(d.body)
                // Standard Android launcher badging: each active conversation card contributes the exact
                // server-authored new-message count measured from the frozen foreground HWM. Supporting
                // launchers aggregate these numbers; unsupported launchers may show only a dot.
                .setNumber(NotifThreadLogic.badgeNumber(d.count))
                .setBadgeIconType(NotificationCompat.BADGE_ICON_NONE)
                .setAutoCancel(true)
                .setOnlyAlertOnce(onlyAlertOnce)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setContentIntent(pendingIntent)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setPublicVersion(buildPublicVersion(ctx, pendingIntent))
            if (d.previewMode == "private") {
                builder.setStyle(NotificationCompat.BigTextStyle().bigText(d.body))
            } else {
                val self = Person.Builder().setName(ctx.getString(R.string.app_name)).build()
                val style = NotificationCompat.MessagingStyle(self)
                    .setConversationTitle(d.title.ifEmpty { ctx.getString(R.string.app_name) })
                    .setGroupConversation(true)
                for (message in d.messages) {
                    val sender = Person.Builder()
                        .setKey(message.senderKey)
                        .setName(message.senderName)
                        .apply {
                            avatarImages[message.senderKey]?.let { bitmap ->
                                setIcon(androidx.core.graphics.drawable.IconCompat.createWithBitmap(bitmap))
                            }
                        }
                        .build()
                    style.addMessage(message.text, message.timestamp, sender)
                }
                builder.setStyle(style)
            }
            if (!allowAlert || d.silent == true) builder.setSilent(true)
            // Avatar decoding/platform preparation can outlive the runtime that issued this command.
            // Never publish its card after that instance/account has been invalidated.
            if (isCurrent()) nm.notify(id, builder.build())
        }

        private fun buildPublicVersion(ctx: Context, contentIntent: PendingIntent): Notification =
            NotificationCompat.Builder(ctx, CHANNEL_MESSAGES)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(ctx.getString(R.string.app_name))
                .setContentText(ctx.getString(R.string.notif_private_body))
                .setContentIntent(contentIntent)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .build()

        /** Remove notifications posted by the retired Android group implementation. */
        private fun cancelThreadGroup(nm: NotificationManager) {
            val active = try { nm.activeNotifications } catch (e: Exception) { return }
            for (sbn in active) if (sbn.notification.group == LEGACY_GROUP_KEY) nm.cancel(sbn.id)
        }

        private fun cancelThreadNotificationsExcept(nm: NotificationManager, keepIds: Set<Int>) {
            val active = try { nm.activeNotifications } catch (e: Exception) { return }
            for (sbn in active) {
                if (sbn.id >= THREAD_NOTIF_BASE && sbn.id !in keepIds) nm.cancel(sbn.id)
            }
        }

        /** Close just the chat that the foreground UI is currently displaying. */
        fun clearThreadNotification(ctx: Context, threadId: Int) {
            if (threadId <= 0) return
            ContextCompat.getSystemService(ctx, NotificationManager::class.java)
                ?.cancel(threadNotifId(threadId))
        }

        /** Close message notifications when the foreground UI takes over. */
        private fun cancelMessageNotifications(ctx: Context) {
            val nm = ContextCompat.getSystemService(ctx, NotificationManager::class.java) ?: return
            nm.cancel(AWAY_NOTIF_ID)
            cancelThreadGroup(nm)
            cancelThreadNotificationsExcept(nm, emptySet())
        }

        fun clearAllMessageNotifs(ctx: Context) {
            cancelMessageNotifications(ctx)
        }

        fun clearSessionMessageNotifs(ctx: Context) {
            activeThreadId = -1
            SomsBridge.DeepLink.clear()
            clearAllMessageNotifs(ctx)
        }

        /** Build the foreground-service persistent notification (minimal, IMPORTANCE_LOW, ongoing) — the
         *  FGS-required "a notification must exist" surface, deliberately NOT a message surface (messages
         *  go to [renderDescriptors]). Tap → opens the app. */
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
            val notif = NotificationCompat.Builder(ctx, CHANNEL_DIAGNOSTICS)
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

        /** Create the message, background-sync and diagnostics channels (required on Android 8+) if absent.
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
                        setShowBadge(true)
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
                        // The FGS anchor is transport state, never unread-message state.
                        setShowBadge(false)
                    },
                )
            }
            if (nm.getNotificationChannel(CHANNEL_DIAGNOSTICS) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(CHANNEL_DIAGNOSTICS, "Notification diagnostics", NotificationManager.IMPORTANCE_HIGH).apply {
                        description = "Administrator notification delivery tests"
                        // An admin delivery probe must not change the user's message badge.
                        setShowBadge(false)
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
