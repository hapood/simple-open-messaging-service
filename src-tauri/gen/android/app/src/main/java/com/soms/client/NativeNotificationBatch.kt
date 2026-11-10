package com.soms.client

import androidx.annotation.Keep
import org.json.JSONObject

/** Executes Rust's sanitized content projection; image indices refer only to forwarded images. */
@Keep
class NativeNotificationBatch(
    val metadata: String,
    val avatars: Array<ByteArray>,
) {
    fun descriptors(): List<NotifDescriptor> {
        val payload = JSONObject(metadata)
        if (!payload.isNull("error")) SomsLog.w("Notif") { "thread feed partially completed: ${payload.optString("error")}" }
        val commands = payload.getJSONArray("commands")
        return (0 until commands.length()).mapNotNull { index ->
            val command = commands.getJSONObject(index)
            val content = command.getJSONObject("notification")
            val target = content.getJSONObject("target")
            val remove = when (command.getString("operation")) {
                "remove" -> true
                "show" -> false
                else -> error("Unknown notification operation")
            }
            val notificationId = if (content.isNull("notificationId")) null else content.getString("notificationId")
            if (remove && notificationId == null) return@mapNotNull null
            require(!notificationId.isNullOrBlank()) { "Missing Rust notification instance ID" }
            val messages = if (remove) emptyList() else {
                val values = content.getJSONArray("messages")
                (0 until values.length()).map { i ->
                    val message = values.getJSONObject(i)
                    NotifMessage(message.getInt("seq"), 0,
                        message.getString("senderName"), message.getString("text"),
                        if (message.isNull("timestampMs")) 0L else message.getLong("timestampMs"),
                        if (message.isNull("senderKey")) "soms-system" else message.getString("senderKey"),
                        if (message.isNull("avatarIndex")) null else avatars[message.getInt("avatarIndex")])
                }
            }
            NotifDescriptor(
                tag = notificationId,
                title = if (remove) "" else content.getString("title"),
                body = if (remove) "" else content.getString("body"),
                count = if (remove) 0 else content.getInt("count"),
                attention = if (!remove && content.getBoolean("hasUnreadMention")) "mention" else null,
                silent = remove || content.getBoolean("silent"), messages = messages,
                target = target.toString(),
                latestSeq = if (!remove && target.getString("kind") == "thread") {
                    val seq = content.get("latestSeq")
                    require(seq is Int && seq >= 0) { "Invalid Rust notification refresh ceiling" }
                    seq
                } else null,
            )
        }
    }
}
