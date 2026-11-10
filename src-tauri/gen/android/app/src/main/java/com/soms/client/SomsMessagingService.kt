package com.soms.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
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
import org.json.JSONArray
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
            "NEW_MESSAGE", "REQUEST_ATTENTION" -> {
                // Keep FCM as a wake even in the foreground: SSE can be temporarily disconnected.
                // Both wakes synchronize through Rust's cursor, so only the winner projects cards.
                val target = data["threadFeedEndId"]?.toIntOrNull()?.takeIf { it >= 0 } ?: -1
                val stateTarget = data["stateFeedEndId"]?.toLongOrNull()?.takeIf { it >= 0 } ?: 0L
                if (target < 0 && stateTarget == 0L) return
                // Firebase's callback has a short lifetime; network + SQLite projection belongs in
                // expedited work, which may finish even if this process is reclaimed after the callback.
                try {
                    NotificationPushWorker.enqueue(this, target, stateTarget)
                } catch (e: RuntimeException) {
                    SomsLog.w("Notif", e) { "could not enqueue push projection" }
                }
            }
            "CALL_INCOMING" -> {
                // FCM also covers a temporarily disconnected SSE while the app is visible. Both paths post
                // the same CallStyle notification; avoid a redundant start when SSE already seeded this call.
                // A high-priority FCM grant permits the phoneCall FGS start when backgrounded or killed.
                val loginUuid = SomsSecureStore.getLoginSessionId(this) ?: return
                val sid = data["callSid"] ?: return
                val callerUserId = data["callerUserId"]?.toIntOrNull() ?: 0
                val account = data["callerAccount"] ?: return
                val namespaceId = data["callerNamespaceId"]?.toIntOrNull() ?: -1
                val threadId = data["threadId"]?.toIntOrNull() ?: return
                CallController.seedIncoming(sid, callerUserId, account, namespaceId, threadId,
                    data["callType"] ?: "AUDIO", "fcm", loginUuid)
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
        const val CHANNEL_MESSAGES = "messages_v1"
        // Channel ids carry a _v1 suffix so immutable attributes (IMPORTANCE, setShowBadge, sound,
        // vibration) can be changed post-release by minting a _v2 id and deleting the old channel.
        const val CHANNEL_BACKGROUND = "background_sync_v1"
        const val CHANNEL_DIAGNOSTICS = "diagnostics_v1"
        const val EXTRA_TARGET = "soms_notification_target"
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





        /** True while MainActivity is visible. Set from MainActivity.onResume/onStop — the
         *  Android-native ground truth for "is the user looking at the app right now." */
        @Volatile
        var appInForeground: Boolean = false

        @Volatile
        var windowFocused: Boolean = false

        @Volatile
        var activeThreadId: Int = -1

        @androidx.annotation.Keep
        @JvmStatic
        fun notificationVisible(): Boolean = appInForeground

        @androidx.annotation.Keep
        @JvmStatic
        fun notificationFocused(): Boolean = windowFocused

        @androidx.annotation.Keep
        @JvmStatic
        fun notificationOpenThread(): Int = activeThreadId

        private val HTTP: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()

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

        /** FCM and scheduled polls wake the shared Rust feed lane; -1 requests a catch-up poll. */
        fun renderAwayNotification(ctx: Context, allowAlert: Boolean, threadFeedEndId: Int = -1, stateFeedEndId: Long = 0L) {
            renderAwayNotificationOnce(ctx, allowAlert, threadFeedEndId, stateFeedEndId)
        }

        /** Foreground wakes use the same coalescing lane as FCM and background SSE. */
        fun renderForegroundNotification(ctx: Context, threadFeedEndId: Int) {
            renderAwayNotification(ctx, allowAlert = true, threadFeedEndId = threadFeedEndId)
        }

        /** Query OS facts only. A failed enumeration must never look like an empty panel. */
        @androidx.annotation.Keep
        @JvmStatic
        fun currentMessageNotifications(): String {
            val ctx = SomsApplication.appContext
            val nm = requireNotNull(ContextCompat.getSystemService(ctx, NotificationManager::class.java))
            val cards = JSONArray()
            for (sbn in nm.activeNotifications) {
                val notification = sbn.notification
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && notification.channelId != CHANNEL_MESSAGES) continue
                val target = notification.extras.getString(EXTRA_TARGET) ?: continue
                cards.put(JSONObject()
                    .put("target", JSONObject(target))
                    .put("tag", sbn.tag ?: JSONObject.NULL)
                    .put("id", sbn.id))
            }
            return cards.toString()
        }

        /** Synchronous OS execution: no queue may discard an accepted invocation. */
        @androidx.annotation.Keep
        @JvmStatic
        fun executeNotification(metadata: String, avatars: Array<ByteArray>): String {
            val request = JSONObject(metadata)
            val result = JSONObject().put("operationId", request.getString("operationId"))
            var submitted = false
            return try {
                val ctx = SomsApplication.appContext
                require(request.getJSONArray("commands").length() == 1) { "Expected one notification command" }
                val platformId = request.getInt("platformId")
                val descriptors = NativeNotificationBatch(metadata, avatars).descriptors()
                val descriptor = descriptors.singleOrNull()
                if (descriptor == null) {
                    result.put("status", "accepted").toString()
                } else {
                    ensureChannel(ctx)
                    val nm = ContextCompat.getSystemService(ctx, NotificationManager::class.java)
                        ?: return result.put("status", "notExecuted").toString()
                    if (descriptor.count > 0 && (!NotificationManagerCompat.from(ctx).areNotificationsEnabled() ||
                            (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                                nm.getNotificationChannel(CHANNEL_MESSAGES)?.importance == NotificationManager.IMPORTANCE_NONE))) {
                        return result.put("status", "rejected").toString()
                    }
                    if (descriptor.count == 0) {
                        submitted = true
                        nm.cancel(descriptor.tag, platformId)
                    } else {
                        postThreadNotification(ctx, nm, platformId, descriptor) { submitted = true }
                        result.put("tag", descriptor.tag).put("id", platformId)
                    }
                    result.put("status", "accepted").toString()
                }
            } catch (_: SecurityException) {
                result.put("status", "rejected").toString()
            } catch (_: Exception) {
                result.put("status", if (submitted) "uncertain" else "notExecuted").toString()
            }
        }

        private fun renderAwayNotificationOnce(ctx: Context, allowAlert: Boolean, target: Int, stateTarget: Long) {
            val userId = SomsSecureStore.getCurrentUserId(ctx) ?: return
            val token = SomsSecureStore.getSessionToken(ctx) ?: return
            val metadata = RustRuntimeBridge.synchronizeNotifications(userId, target, allowAlert, stateTarget) ?: return
            val committed = JSONObject(metadata).getJSONObject("commitEvent")
            RustRuntimeBridge.withCurrentSession(committed.getString("loginSessionId")) {
                if (appInForeground && SomsSecureStore.getCurrentUserId(ctx) == userId &&
                    SomsSecureStore.getSessionToken(ctx) == token) {
                    SomsBridge.eval("window.__SOMS_EVENT__ && window.__SOMS_EVENT__($committed);")
                }
            }
        }

        /** Post one conversation card. Tap deep-links into the thread. */
        private fun postThreadNotification(
            ctx: Context,
            nm: NotificationManager,
            id: Int,
            d: NotifDescriptor,
            beforeSubmit: () -> Unit,
        ) {
            val avatarImages = NotificationAvatars.resolve(ctx, d.messages)
            val intent = Intent(ctx, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                putExtra(EXTRA_TARGET, d.target)
                putExtra("notificationId", d.tag)
                // Each card instance has a distinct PendingIntent identity; updates reuse it.
                data = android.net.Uri.parse("soms-notification://card/${d.tag}")
            }
            val pendingIntent = PendingIntent.getActivity(
                ctx, id, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val dismissed = PendingIntent.getBroadcast(
                ctx, id,
                Intent(ctx, NotificationDismissedReceiver::class.java)
                    .setData(android.net.Uri.parse("soms-notification://card/${d.tag}"))
                    .putExtra(EXTRA_TARGET, d.target).putExtra("notificationId", d.tag),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val builder = NotificationCompat.Builder(ctx, CHANNEL_MESSAGES)
                // Enumeration cannot inspect PendingIntent extras. Expose the same
                // Rust-owned thread target on the card for restart reconstruction.
                .addExtras(Bundle().apply { putString(EXTRA_TARGET, d.target) })
                .setDeleteIntent(dismissed)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(d.title.ifEmpty { ctx.getString(R.string.app_name) })
                .setContentText(d.body)
                // Standard Android launcher badging: each active conversation card contributes the exact
                // server-authored new-message count measured from the frozen foreground HWM. Supporting
                // launchers aggregate these numbers; unsupported launchers may show only a dot.
                .setNumber(NotifThreadLogic.badgeNumber(d.count))
                .setBadgeIconType(NotificationCompat.BADGE_ICON_NONE)
                .setAutoCancel(true)
                .setOnlyAlertOnce(false)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setContentIntent(pendingIntent)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setPublicVersion(buildPublicVersion(ctx, pendingIntent))
            if (d.messages.isEmpty()) {
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
            if (d.silent == true) builder.setSilent(true)
            val notification = builder.build()
            beforeSubmit()
            nm.notify(d.tag, id, notification)
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
            for (sbn in active) if (sbn.notification.group == LEGACY_GROUP_KEY) nm.cancel(sbn.tag, sbn.id)
        }

        private fun cancelThreadNotificationsExcept(nm: NotificationManager, keepIds: Set<Int>) {
            val active = try { nm.activeNotifications } catch (e: Exception) { return }
            for (sbn in active) {
                if (sbn.id >= THREAD_NOTIF_BASE && sbn.id !in keepIds) nm.cancel(sbn.tag, sbn.id)
            }
        }

        /** Report facts; Rust owns the resulting command and its execution receipt. */
        fun presentationChanged() {
            RustRuntimeBridge.notificationPresentationChanged(appInForeground, windowFocused, activeThreadId)
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
         *  go to [executeNotification]). Tap → opens the app. */
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
         *  vibration take effect on a fresh install — if a prior build ever created "messages_v1" lower, a
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
