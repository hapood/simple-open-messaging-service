package com.soms.client

import androidx.annotation.Keep
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/** Notification metadata references the deduplicated image array by avatarIndex. */
@Keep
class NativeNotificationBatch(
    val metadata: String,
    val avatars: Array<ByteArray>,
    val accountEpoch: Long,
) {
    fun descriptors(mode: String, privateBody: String, retracted: String, removed: String): List<NotifDescriptor> {
        val payload = JSONObject(metadata)
        if (!payload.isNull("error")) SomsLog.w("Notif") { "thread feed partially completed: ${payload.optString("error")}" }
        val threads = payload.getJSONArray("threads")
        val date = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }
        return (0 until threads.length()).map { index ->
            val thread = threads.getJSONObject(index)
            val tid = thread.getInt("threadId")
            val count = thread.getInt("unreadCount")
            val previews = thread.getJSONArray("previews")
            val messages = (0 until previews.length()).map { i ->
                val preview = previews.getJSONObject(i)
                val sender = if (preview.isNull("sender")) null else preview.getJSONObject("sender")
                val key = if (sender == null) "soms-system" else "${sender.getString("account")}@${sender.getString("domain")}"
                val text = when (preview.getString("status")) {
                    "USER_RETRACTION" -> retracted
                    "MODERATION_REMOVAL" -> removed
                    "LIVE" -> preview.getString("text")
                    else -> error("Invalid notification preview status")
                }
                NotifMessage(preview.getInt("seq"), 0, preview.getString("senderName"), text,
                    date.parse(preview.getString("createdAt"))!!.time, key,
                    if (preview.has("avatarIndex")) avatars[preview.getInt("avatarIndex")] else null)
            }.sortedBy { it.seq }
            NotifDescriptor(
                tag = "thread:$tid", kind = "thread-message", title = thread.getString("title"),
                body = if (mode == "private") privateBody else messages.lastOrNull()?.text.orEmpty(),
                count = count, lang = Locale.getDefault().toLanguageTag(), renotify = true,
                attention = if (thread.getBoolean("hasUnreadMention")) "mention" else null,
                silent = thread.getBoolean("muted"), messages = messages,
                previewMode = mode, data = JSONObject().put("threadId", tid),
            )
        }
    }
}
