package com.soms.client

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Handles a notification ACTION button tap (dismiss / reply) — the Android half of the descriptor
 * `actions[]` round-trip. Each action's `PendingIntent` (built in [SomsMessagingService.renderDescriptor])
 * targets this receiver, carrying the action id + the descriptor's routing data + the notification id the
 * action lives on; an inline-reply action (`type:"text"`) carries the typed text via a [RemoteInput] result.
 * `dismiss` is a PURE frontend op — it advances the away-HWM to the descriptor's `{threadId, seq}` cursor
 * (persisted to [SomsSecureStore], so the next background fetch's `since` gates past these messages) AND
 * cancels the notification (by the id the action carried), never POSTing and never touching the read
 * watermark; only `reply` (and future non-dismiss actions) POST to `/notifications/action`.
 *
 * `onReceive` runs on the main thread and must return quickly, so the POST to `/notifications/action` runs
 * on a worker thread under a [goAsync] `PendingResult` (keeps the receiver alive across the network call,
 * then `finish()` releases it — a bare `Thread` could be killed before the POST completes when the app is
 * backgrounded). Best-effort + fire-and-forget: a failed POST just means the shade action didn't land (the
 * user retries in-app). Auth-N via the session-token Bearer (the same credential the native fetch paths use).
 */
class SomsActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        // Incoming-call Decline (the CallService ringing notification's Decline button) — declines natively +
        // stops the ring, no UI needed. Checked first: this intent carries EXTRA_CALL_DECLINE, not the
        // message-action extras below. CallController.decline stops the ring at once + POSTs + tears down the
        // CallService (whose foreground notification is removed when the service stops).
        intent.getStringExtra(EXTRA_CALL_DECLINE)?.let { sid ->
            CallController.decline(sid)
            return
        }
        // Ongoing-call Hang up (the CallService ongoing notification's hang-up button) — ends a connected call
        // natively, no UI needed. (Decline above is for a RINGING call; this is for an in-progress one.)
        intent.getStringExtra(EXTRA_CALL_END)?.let { sid ->
            if (sid.isNotEmpty()) CallController.end(sid, "completed")
            return
        }
        val actionId = intent.getStringExtra(EXTRA_ACTION_ID) ?: return
        val tag = intent.getStringExtra(EXTRA_TAG) ?: ""
        val notifId = intent.getIntExtra(EXTRA_NOTIF_ID, SomsMessagingService.AWAY_NOTIF_ID)
        // `dismiss` is a PURE frontend op: advance the away-HWM to the descriptor's `{threadId, seq}` cursor
        // (so the next background fetch's `since` gates past these messages — they won't re-fire) AND cancel
        // THIS notification, by the id the action carried (not a hardcoded one). No POST, no read-watermark
        // change (lastReadSeq is untouched — the messages stay unread until the user opens the thread).
        if (actionId == "dismiss") {
            val tid = intent.getIntExtra(EXTRA_THREAD_ID, -1)
            val seq = intent.getIntExtra(EXTRA_SEQ, -1)
            if (intent.getBooleanExtra(EXTRA_IS_THREAD, false)) {
                // per-thread dismiss (#5: routed by the explicit EXTRA_IS_THREAD the action builder set, NOT
                // the tag prefix): record the thread's seq IN MEMORY — the next fetch's `threadHwms` makes the
                // server count this thread FROM it, so dismiss resets its cumulative count to 0 until newer
                // messages. Cancels THIS card only; no global-HWM change (the other cards stay).
                if (tid >= 0 && seq >= 0) SomsMessagingService.recordThreadDismiss(context, tid, seq)
            } else {
                // all-mode dismiss: advance the GLOBAL away-HWM (so the next fetch's `since` gates past
                // everything) + cancel the away card.
                if (tid >= 0 && seq >= 0) SomsSecureStore.setMissedCursor(context, tid, seq)
            }
            NotificationManagerCompat.from(context).cancel(notifId)
            return
        }
        val threadId = intent.getIntExtra(EXTRA_THREAD_ID, -1)
        val seq = intent.getIntExtra(EXTRA_SEQ, -1)
        // The inline-reply text (present only for a type:"text" action the OS collected input for).
        val replyText = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY_REPLY_TEXT)?.toString()

        val token = SomsSecureStore.getSessionToken(context) ?: return
        // Follow Kotlin's ACTIVE origin (mode-aware), not the primary — a notification action tapped while the
        // device is on the LAN secondary must hit the reachable secondary, not the hairpin-unreachable primary.
        val origin = SomsSecureStore.getActiveOrigin(context) ?: return

        val body = JSONObject().apply {
            put("tag", tag)
            put("actionId", actionId)
            // seq may legitimately be 0 (a thread's first message) → guard on the -1 sentinel (>= 0), never > 0.
            if (threadId >= 0) put("threadId", threadId)
            if (seq >= 0) put("seq", seq)
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
        /** The callSid for an incoming-call Decline action (from the CallService ringing notification). */
        const val EXTRA_CALL_DECLINE = "soms_call_decline"
        /** The callSid for an ongoing-call Hang-up action (the CallService ongoing notification's button). */
        const val EXTRA_CALL_END = "soms_call_end"
        const val EXTRA_TAG = "soms_tag"
        const val EXTRA_NOTIF_ID = "soms_notif_id"
        /** #5: dismiss routes per-thread (in-memory HWM) vs all-mode (global HWM) — set explicitly by the
         *  action builder in SomsMessagingService, NOT inferred from the tag prefix. */
        const val EXTRA_IS_THREAD = "soms_is_thread"
        const val EXTRA_THREAD_ID = "soms_thread_id"
        const val EXTRA_SEQ = "soms_seq"
        /** The RemoteInput result key for an inline-reply action's typed text. */
        const val KEY_REPLY_TEXT = "soms_reply_text"

        private val HTTP: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()
    }
}
