package com.soms.client

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Handles a notification ACTION button tap (mark-all-read / reply) — the Android half of the descriptor
 * `actions[]` round-trip. Each action's `PendingIntent` (built in [SomsMessagingService.renderDescriptor])
 * targets this receiver, carrying the action id + the descriptor's routing data; an inline-reply action
 * (`type:"text"`) carries the typed text via a [RemoteInput] result.
 *
 * `onReceive` runs on the main thread and must return quickly, so the POST to `/notifications/action` runs
 * on a worker thread under a [goAsync] `PendingResult` (keeps the receiver alive across the network call,
 * then `finish()` releases it — a bare `Thread` could be killed before the POST completes when the app is
 * backgrounded). Best-effort + fire-and-forget: a failed POST just means the shade action didn't land (the
 * user retries in-app). Auth-N via the session-token Bearer (the same credential the native fetch paths use).
 */
class SomsActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val actionId = intent.getStringExtra(EXTRA_ACTION_ID) ?: return
        val tag = intent.getStringExtra(EXTRA_TAG) ?: ""
        val threadId = intent.getIntExtra(EXTRA_THREAD_ID, -1)
        val seq = intent.getIntExtra(EXTRA_SEQ, -1)
        val threadIdsJson = intent.getStringExtra(EXTRA_THREAD_IDS)
        // The inline-reply text (present only for a type:"text" action the OS collected input for).
        val replyText = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY_REPLY_TEXT)?.toString()

        val token = SomsSecureStore.getSessionToken(context) ?: return
        val origin = SomsSecureStore.getApiOrigin(context) ?: return

        val body = JSONObject().apply {
            put("tag", tag)
            put("actionId", actionId)
            if (threadId > 0) put("threadId", threadId)
            if (seq > 0) put("seq", seq)
            if (!threadIdsJson.isNullOrEmpty()) put("threadIds", JSONArray(threadIdsJson))
            if (!replyText.isNullOrEmpty()) put("replyText", replyText)
        }.toString()
        val request = Request.Builder()
            .url("$origin${SomsSecureStore.API_PREFIX}/notifications/action")
            .post(body.toRequestBody("application/json".toMediaType()))
            .addHeader("Authorization", "Bearer $token")
            .build()

        // goAsync: keep the receiver alive across the network call, then release. A bare Thread could be
        // torn down with the process before the POST lands when the app is backgrounded.
        val pending = goAsync()
        Thread {
            try {
                HTTP.newCall(request).execute().use { /* fire-and-forget — drain + discard */ }
            } catch (e: Exception) {
                /* best-effort */
            } finally {
                pending.finish()
            }
        }.start()
    }

    companion object {
        const val EXTRA_ACTION_ID = "soms_action_id"
        const val EXTRA_TAG = "soms_tag"
        const val EXTRA_THREAD_ID = "soms_thread_id"
        const val EXTRA_SEQ = "soms_seq"
        const val EXTRA_THREAD_IDS = "soms_thread_ids_json"
        /** The RemoteInput result key for an inline-reply action's typed text. */
        const val KEY_REPLY_TEXT = "soms_reply_text"

        private val HTTP: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()
    }
}
