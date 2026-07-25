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
            "CALL_INCOMING" -> {
                // The phone must ring even when the app is backgrounded / killed. The high-priority FCM grant
                // is the exemption that lets the CallService phoneCall FGS start here. Suppress only when the
                // app is foregrounded (the live SSE already delivered CALL_EVENT{incoming} + the in-app UI owns
                // display — no loud system ring while the user is in the app).
                if (appInForeground) return
                val sid = data["callSid"] ?: return
                // A late/duplicate push for a call already past incoming (the SSE path answered/ended it) —
                // don't re-ring. seedIncoming is itself idempotent on the same incoming callSid; this guards
                // the ring for a call the SSE already advanced.
                val p = CallController.phase
                if (CallController.callSid == sid && p != "incoming" && p != "idle") return
                val callerUserId = data["callerUserId"]?.toIntOrNull() ?: return
                val threadId = data["threadId"]?.toIntOrNull() ?: 0
                val callType = data["callType"] ?: "AUDIO"
                val callerName = data["callerName"] ?: ""
                val callerAvatar = data["callerAvatar"] ?: ""
                SomsLog.i("Notif") { "CALL_INCOMING sid=$sid from=$callerUserId type=$callType -> ring" }
                CallService.startIncoming(this, sid, callerUserId, callerName, callerAvatar, threadId, callType)
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

        /** Group key for per-thread cards — all cards + the summary share it so Android bundles them into one
         *  collapsible stack (WhatsApp-style). */
        const val GROUP_KEY = "soms_messages"
        /** Notification id for the per-thread group summary (the collapsed bundle header). */
        const val THREAD_GROUP_SUMMARY_ID = 0x8
        /** Per-thread notification ids are THREAD_NOTIF_BASE + threadId (offset clear of AWAY/FGS/ADMIN/SUMMARY
         *  + the JS seq range 0x100+). threadId is a small DB id → no Int overflow. */
        const val THREAD_NOTIF_BASE = 0x10000

        /** Per-thread DISMISS HWM (the count cursor): threadId → the seq the user dismissed up to. Advances
         *  ONLY on dismiss (→ the thread's latestSeq); the server counts a dismissed thread FROM this (sent as
         *  `threadHwms`), so dismiss resets its cumulative count. NOT the alert cursor — see [threadLastAlertSeq].
         *  This is the in-memory cache over the PERSISTED copy in SomsSecureStore (so a dismiss survives a
         *  process kill + restart mid-background-session); loaded once per process ([ensureHwmsLoaded]) and
         *  cleared on foreground. Process-static so FCM/FGS/WorkManager share it. ConcurrentHashMap. */
        private val dismissedThreadSeq = java.util.concurrent.ConcurrentHashMap<Int, Int>()

        /** Whether [dismissedThreadSeq] has been loaded from disk this process. Loaded lazily on first access
         *  (fetchDescriptors / recordThreadDismiss) so the durable dismiss HWM survives a kill + restart.
         *  [clearThreadDismiss] sets it true (treats a cleared state as already-loaded). */
        @Volatile
        private var hwmsLoaded = false

        /** In-memory per-thread LAST-ALERTED latestSeq (the #4 alert cursor): threadId → the latestSeq at the
         *  last notify. #4 re-alerts a card only when first seen (no entry) OR its latestSeq advanced past this.
         *  Distinct from [dismissedThreadSeq] (which moves only on dismiss) — this moves on every notify, so a
         *  re-fetch with nothing new stays silent. IN-MEMORY ONLY (not persisted — a process restart re-alerts
         *  the standing unread set, the 6h-poll "reminder"; persisted it would suppress that). */
        private val threadLastAlertSeq = java.util.concurrent.ConcurrentHashMap<Int, Int>()

        /** Derive the stable notification id for a per-thread card from its threadId. */
        private fun threadNotifId(threadId: Int): Int = NotifThreadLogic.notifId(THREAD_NOTIF_BASE, threadId)

        /** Load the persisted dismiss HWMs into the cache once per process (no-op after the first load). */
        private fun ensureHwmsLoaded(ctx: Context) {
            if (hwmsLoaded) return
            dismissedThreadSeq.putAll(SomsSecureStore.getNotifThreadHwms(ctx))
            hwmsLoaded = true
        }

        /** Dismiss cursor: advances ONLY on dismiss → the thread's latestSeq, AND persists (survives process
         *  death). Called by [SomsActionReceiver]. */
        fun recordThreadDismiss(ctx: Context, threadId: Int, seq: Int) {
            ensureHwmsLoaded(ctx)
            dismissedThreadSeq[threadId] = seq
            SomsSecureStore.setNotifThreadHwms(ctx, dismissedThreadSeq)
        }

        /** A snapshot of the dismiss-HWM map, serialized as `threadHwms` in the /missed body. Loads the
         *  persisted copy first (once per process). */
        fun threadHwmsSnapshot(ctx: Context): Map<Int, Int> {
            ensureHwmsLoaded(ctx)
            return dismissedThreadSeq.toMap()
        }

        /** #4: whether `threadId` should re-alert — first sight, or `latestSeq` advanced past the last alert. */
        fun shouldAlertThread(threadId: Int, latestSeq: Int): Boolean =
            NotifThreadLogic.shouldAlert(threadLastAlertSeq[threadId], latestSeq)

        /** #4: record the latestSeq just alerted for `threadId` (advances the alert cursor on each notify). */
        fun recordThreadAlert(threadId: Int, seq: Int) { threadLastAlertSeq[threadId] = seq }

        /** Clear all per-thread in-memory state + the persisted dismiss HWMs (foreground — the in-app UI takes
         *  over, cards reset). */
        fun clearThreadDismiss(ctx: Context) {
            dismissedThreadSeq.clear()
            threadLastAlertSeq.clear()
            hwmsLoaded = true
            SomsSecureStore.clearNotifThreadHwms(ctx)
        }

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
            val origin = SomsSecureStore.getActiveOrigin(ctx)
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
                // The away-summary grouping pref (device-local) — "thread" (one card per conversation) or
                // "all" (one folded card). Declared on MissedDto; setNotifGrouping clamps to those two, so a
                // stray value can't trip forbidNonWhitelisted into a 400.
                put("grouping", SomsSecureStore.getNotifGrouping(ctx))
                // Per-thread dismiss HWMs (in-memory) — for each dismissed thread, the server counts FROM its
                // HWM (cumulative since dismiss → dismiss resets the count to 0 until newer messages). Only
                // meaningful in "thread" grouping; harmless (ignored) in "all". Declared on MissedDto.
                val hwms = threadHwmsSnapshot(ctx)
                if (hwms.isNotEmpty()) {
                    val obj = JSONObject()
                    for ((tid, seq) in hwms) obj.put(tid.toString(), seq)
                    put("threadHwms", obj)
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

        /**
         * Render the server-authored descriptor(s). Two modes, selected by the descriptors' `kind` (explicit —
         * the tag is pure identity, never a mode signal):
         *  - `kind:"thread-message"` (grouping "thread"): ONE notification CARD per conversation, bundled under
         *    [GROUP_KEY] with a summary — see [renderThreadDescriptors].
         *  - `kind:"message-summary"` / `"clear"` (grouping "all"): ONE coalesced notification at
         *    [AWAY_NOTIF_ID] via [renderDescriptor].
         * An empty list (per-thread "no new conversations") clears every message notification.
         */
        fun renderDescriptors(ctx: Context, descriptors: List<NotifDescriptor>) {
            ensureChannel(ctx)
            val nm = ContextCompat.getSystemService(ctx, NotificationManager::class.java) ?: run {
                SomsLog.w("Notif") { "renderDescriptors: NotificationManager unavailable → skip" }
                return
            }
            if (descriptors.isEmpty()) {
                SomsLog.d("Notif") { "renderDescriptors: empty → clear all message notifs" }
                clearAllMessageNotifs(ctx)
                return
            }
            val d0 = descriptors.first()
            if (d0.kind == "thread-message") {
                renderThreadDescriptors(ctx, nm, descriptors)
                return
            }
            // All-mode: one coalesced descriptor at AWAY_NOTIF_ID. Drop any leftover per-thread cards (the
            // user switched grouping, or a prior thread-mode session's cards lingered).
            cancelThreadGroup(nm)
            val masterOn = NotificationManagerCompat.from(ctx).areNotificationsEnabled()
            val channel = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) nm.getNotificationChannel(CHANNEL_MESSAGES) else null
            val channelOn = channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE
            SomsLog.i("Notif") {
                "renderDescriptors(all) kind=${d0.kind} title='${d0.title.take(40)}' bodyLen=${d0.body.length} icon=${d0.icon != null} masterNotifOn=$masterOn channelOn=$channelOn chImp=${channel?.importance} renotify=${d0.renotify} appInFg=$appInForeground"
            }
            renderDescriptor(ctx, d0)
        }

        /**
         * "thread" grouping render — one [NotificationCompat] card per descriptor (each at its own
         *  [threadNotifId]), all under [GROUP_KEY] + a [THREAD_GROUP_SUMMARY_ID] summary so Android bundles
         *  them. Children use [NotificationCompat.GROUP_ALERT_SUMMARY] (silent; only the summary alerts, so
         *  N new conversations = ONE sound, not N). Threads the user dismissed (in-memory per-thread HWM) are
         *  filtered out until a newer seq arrives; stale cards no longer in this round are cancelled.
         */
        private fun renderThreadDescriptors(ctx: Context, nm: NotificationManager, descriptors: List<NotifDescriptor>) {
            // The server already dropped dismissed-0 threads (it counted each from the client's threadHwms), so
            // `descriptors` IS the visible set — render them all. #4 alert: a card re-alerts only on first sight
            // or a newer latestSeq (shouldAlertThread); the summary carries the aggregate alert (only it sounds).
            val wantIds = HashSet<Int>()
            var anyChanged = false
            for (d in descriptors) {
                val tid = d.data.optInt("threadId", -1)
                val seq = d.data.optInt("seq", -1)
                if (tid < 0) continue
                val id = threadNotifId(tid)
                wantIds.add(id)
                if (seq >= 0 && shouldAlertThread(tid, seq)) anyChanged = true
                postThreadNotification(ctx, nm, id, d)
                if (seq >= 0) recordThreadAlert(tid, seq) // advance the #4 alert cursor
            }
            // Cancel stale cards (group members not in this round) — robust to process restarts via
            // activeNotifications (a dismissed/switched/missing thread's leftover card).
            cancelThreadGroupExcept(nm, wantIds)
            if (descriptors.isEmpty()) nm.cancel(THREAD_GROUP_SUMMARY_ID) else postGroupSummary(ctx, nm, descriptors.size, anyChanged)
            SomsLog.i("Notif") { "renderDescriptors(thread): ${descriptors.size} cards, anyChanged=$anyChanged appInFg=$appInForeground" }
        }

        /** Post ONE per-thread notification card at [id], grouped under [GROUP_KEY]. Tap deep-links into the
         *  thread (EXTRA_THREAD_ID); the `dismiss` action records the thread's seq in memory + cancels this
         *  card (handled by [SomsActionReceiver]). */
        private fun postThreadNotification(ctx: Context, nm: NotificationManager, id: Int, d: NotifDescriptor) {
            val tid = d.data.optInt("threadId", -1)
            val seq = d.data.optInt("seq", -1)
            val intent = Intent(ctx, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                if (tid >= 0) putExtra(EXTRA_THREAD_ID, tid.toString())
            }
            val pendingIntent = PendingIntent.getActivity(
                ctx, id, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val builder = NotificationCompat.Builder(ctx, CHANNEL_MESSAGES)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(d.title.ifEmpty { ctx.getString(R.string.app_name) })
                .setContentText(d.body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(d.body))
                .setAutoCancel(true)
                .setOnlyAlertOnce(!d.renotify)
                .setGroup(GROUP_KEY)
                .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_SUMMARY)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setContentIntent(pendingIntent)
            if (d.silent == true) builder.setSilent(true)
            for ((idx, a) in d.actions.withIndex()) {
                val pi = PendingIntent.getBroadcast(
                    ctx,
                    id + 1 + idx, // unique requestCode per (card, action slot)
                    Intent(ctx, SomsActionReceiver::class.java).apply {
                        putExtra(SomsActionReceiver.EXTRA_ACTION_ID, a.id)
                        putExtra(SomsActionReceiver.EXTRA_TAG, d.tag)
                        putExtra(SomsActionReceiver.EXTRA_NOTIF_ID, id)
                        putExtra(SomsActionReceiver.EXTRA_IS_THREAD, true) // #5: dismiss routes per-thread (in-memory), not tag-prefix
                        if (tid >= 0) putExtra(SomsActionReceiver.EXTRA_THREAD_ID, tid)
                        if (seq >= 0) putExtra(SomsActionReceiver.EXTRA_SEQ, seq)
                    },
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
                builder.addAction(NotificationCompat.Action.Builder(R.drawable.ic_notification, a.title, pi).build())
            }
            nm.notify(id, builder.build())
        }

        /** Post the per-thread bundle summary (the collapsed header). [GROUP_ALERT_SUMMARY] makes this the
         *  ONLY group member that can alert (sound + heads-up) — so a burst across N conversations is one alert,
         *  not N. #4: `alert` is true only when some child is first-seen or has a newer latestSeq this round;
         *  otherwise the summary is posted silent (a re-fetch that changed nothing stays quiet). Re-posts
         *  replace in place. */
        private fun postGroupSummary(ctx: Context, nm: NotificationManager, count: Int, alert: Boolean) {
            val intent = Intent(ctx, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val pendingIntent = PendingIntent.getActivity(
                ctx, THREAD_GROUP_SUMMARY_ID, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val summary = ctx.resources.getQuantityString(R.plurals.notif_group_summary, count, count)
            val builder = NotificationCompat.Builder(ctx, CHANNEL_MESSAGES)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(ctx.getString(R.string.app_name))
                .setContentText(summary)
                .setStyle(NotificationCompat.BigTextStyle().bigText(summary))
                .setGroup(GROUP_KEY)
                .setGroupSummary(true)
                .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_SUMMARY)
                .setAutoCancel(true)
                .setOnlyAlertOnce(false) // the `alert` flag (via setSilent) gates the actual alert, not this
                .setContentIntent(pendingIntent)
            if (!alert) builder.setSilent(true) // #4: nothing changed this round → quiet update
            nm.notify(THREAD_GROUP_SUMMARY_ID, builder.build())
        }

        /** Cancel every notification in [GROUP_KEY] (children + summary). Best-effort via activeNotifications
         *  (robust to process restarts — the in-memory "what did I post" set is gone after a kill, but the OS
         *  still holds the posted cards). */
        private fun cancelThreadGroup(nm: NotificationManager) {
            val active = try { nm.activeNotifications } catch (e: Exception) { return }
            for (sbn in active) if (sbn.notification.group == GROUP_KEY) nm.cancel(sbn.id)
        }

        /** Cancel group children NOT in [keepIds] (stale cards — a dismissed / switched-out thread). The
         *  summary ([THREAD_GROUP_SUMMARY_ID]) is always exempt (reposted or withdrawn by the caller). */
        private fun cancelThreadGroupExcept(nm: NotificationManager, keepIds: Set<Int>) {
            val active = try { nm.activeNotifications } catch (e: Exception) { return }
            for (sbn in active) {
                if (sbn.notification.group == GROUP_KEY && sbn.id != THREAD_GROUP_SUMMARY_ID && sbn.id !in keepIds) {
                    nm.cancel(sbn.id)
                }
            }
        }

        /** Clear EVERY message notification (the away card + the whole per-thread group) + the in-memory
         *  per-thread dismiss map. Called on foreground (onResume — the in-app UI owns display again) and on
         *  an empty descriptor list (nothing new to show). */
        fun clearAllMessageNotifs(ctx: Context) {
            val nm = ContextCompat.getSystemService(ctx, NotificationManager::class.java) ?: return
            nm.cancel(AWAY_NOTIF_ID)
            cancelThreadGroup(nm)
            clearThreadDismiss(ctx)
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
                        putExtra(SomsActionReceiver.EXTRA_IS_THREAD, false) // all-mode: dismiss advances the global HWM
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
        internal fun fetchBitmap(ctx: Context, iconUrl: String): android.graphics.Bitmap? {
            val token = SomsSecureStore.getSessionToken(ctx) ?: return null
            val origin = SomsSecureStore.getActiveOrigin(ctx) ?: return null
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
