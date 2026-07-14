package com.soms.client

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * The 国内 fallback push path. FCM is blocked in mainland China, so on devices where the FCM token
 * fetch fails (no google-services.json / no GMS / network), this WorkManager job periodically polls
 * `/notifications/missed` and posts local notifications itself — giving the "within a day, you'll be
 * reminded" UX without any OEM/厂商 channel. On 海外 devices where FCM works, this still runs but is
 * gated to a no-op by the dedup cursor (FCM already notified the same messages) — see SomsSecureStore.
 *
 * Auth: a scoped 30-day notification token (POST /auth/notification-token), NOT the refresh token —
 * sharing the refresh-token family would race the web client's own renewal. The token is pushed here
 * from JS via the SomsFcm @JavascriptInterface on login; absent token ⇒ logged out ⇒ skip.
 *
 * Schedule: ~6h periodic (the floor for reliable background work; giving several chances per day).
 * WorkManager survives reboot and process death; it can't be started from background, so the initial
 * enqueue happens in MainActivity.onCreate (a foreground context). The worker self-skips when the
 * app is foregrounded (the user already sees messages in-app) and when the network is down.
 */
class NotificationSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    override suspend fun doWork(): Result {
        val ctx = applicationContext
        // Honor the user's Settings → Background toggle. Checked here (not at schedule time) so the worker
        // self-gates even when a killed process is woken in the background before the WebView can cancel.
        if (!SomsSecureStore.getPollingEnabled(ctx)) return Result.success()
        // Skip when the user is already in-app — the SSE/in-app UI has it covered; don't double-notify.
        if (SomsMessagingService.appInForeground) return Result.success()

        val token = SomsSecureStore.getNotificationToken(ctx) ?: return Result.success() // logged out
        val origin = SomsSecureStore.getApiOrigin(ctx) ?: return Result.success() // not configured yet
        val cursor = SomsSecureStore.getDedupCursor(ctx)

        val body = JSONObject().toString() // empty body — the missed endpoint takes none
        val request = Request.Builder()
            .url("$origin/notifications/missed")
            .post(body.toRequestBody("application/json".toMediaType()))
            .addHeader("Authorization", "Bearer $token")
            .build()

        try {
            client.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) {
                    // 401 → token expired/revoked; the next foreground login re-issues. Don't retry-spin.
                    return Result.success()
                }
                val payload = resp.body?.string() ?: return Result.success()
                val data = parseMissedData(payload) ?: return Result.success()
                notifyUnread(ctx, data, cursor)
            }
        } catch (e: Exception) {
            // Network failure / parse error — WorkManager will retry on the next period. Don't surface.
            return Result.success()
        }
        return Result.success()
    }

    /** Extract the `data` array from `{ code, message, data: [...] }`. Null if anything is off. */
    private fun parseMissedData(payload: String): JSONArray? {
        return try {
            val obj = JSONObject(payload)
            if (obj.optInt("code", -1) != 0) null else (obj.optJSONArray("data") ?: JSONArray())
        } catch (e: Exception) {
            null
        }
    }

    /** Dedup-gate on the cursor, then render ONE coalesced away-notification for the full snapshot.
     *  Only proceeds when at least one thread's latestMessageId advanced past the cursor (otherwise
     *  FCM / the FGS already notified this batch); advances the cursor for every fresh thread before
     *  rendering so concurrent paths skip them; then hands the full unread snapshot to
     *  [SomsMessagingService.notifyAwaySummary] — one notification listing every sender, replacing any
     *  prior one (never per-thread spam). */
    private fun notifyUnread(ctx: Context, data: JSONArray, cursor: Map<String, String>) {
        var anyFresh = false
        for (i in 0 until data.length()) {
            val item = data.optJSONObject(i) ?: continue
            val threadId = item.optString("threadId")
            val latest = item.optString("latestMessageId")
            if (latest.isEmpty()) continue
            val prev = cursor[threadId]
            val isNewer = prev == null ||
                prev.length < latest.length ||
                (prev.length == latest.length && prev < latest)
            if (isNewer) {
                SomsSecureStore.advanceCursor(ctx, threadId, latest)
                anyFresh = true
            }
        }
        if (!anyFresh) return
        SomsMessagingService.notifyAwaySummary(ctx, SomsMessagingService.parseSnapshotArray(data))
    }
}
