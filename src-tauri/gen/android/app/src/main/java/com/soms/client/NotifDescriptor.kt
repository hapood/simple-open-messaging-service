package com.soms.client

import org.json.JSONArray
import org.json.JSONObject

/**
 * The server-authored notification descriptor — the Kotlin mirror of the backend `NotificationDescriptor`
 * (src/notification/notification-descriptor.ts). The backend decides BOTH the content (localized title/body
 * + composited stacked-avatar `icon`) AND the presentation semantics (`tag` = replace-by-id, `kind` =
 * template incl. `"clear"` = cancel, `actions` = buttons). The native renderer
 * [SomsMessagingService.renderDescriptor] maps it onto `NotificationCompat` with zero composition logic:
 *  - `body`    → `BigTextStyle` (a coalesced cross-thread count summary, not a per-person conversation);
 *  - `icon`    → `setLargeIcon` (the fetched stacked-avatar PNG);
 *  - `tag`     → the stable [SomsMessagingService.AWAY_NOTIF_ID] (replace-by-id);
 *  - `renotify`→ `setOnlyAlertOnce(!renotify)`; `silent` → `setSilent`;
 *  - `kind:"clear"` → cancel the tagged notification.
 *
 * Parsed from the `data.notifications[]` array of the `POST /notifications/missed` envelope.
 */
data class NotifAction(
    val id: String,
    val title: String,
    val style: String? = null,
    /** `"text"` = an inline reply input (RemoteInput, P2); `"button"` = tap. */
    val type: String? = null,
)

data class NotifMessage(
    val seq: Int,
    val senderId: Int,
    val senderName: String,
    val text: String,
    val timestamp: Long,
)

data class NotifDescriptor(
    val tag: String,
    val kind: String,
    val title: String,
    val body: String,
    /** New messages represented by this card since the frozen foreground/per-thread dismiss HWM. */
    val count: Int,
    val lang: String,
    /** URL to the server-composited stacked-avatar PNG (relative — resolved against the API origin at fetch);
     *  null when the server left it null (no avatar / librsvg absent → the client uses its app icon). */
    val icon: String?,
    val renotify: Boolean,
    /** Optional reason for elevated visual treatment; copy remains server-authored. */
    val attention: String?,
    val silent: Boolean?,
    val actions: List<NotifAction>,
    val messages: List<NotifMessage>,
    val previewMode: String,
    val data: JSONObject,
) {
    companion object {
        /** Parse the `{code,message,data:{...,notifications[]}}` envelope's `notifications[]` into
         *  descriptors. Empty list on any shape problem (callers skip rendering). */
        fun parseList(payload: String): List<NotifDescriptor> = try {
            val arr = JSONObject(payload)
                .optJSONObject("data")
                ?.optJSONArray("notifications")
                ?: JSONArray()
            (0 until arr.length()).mapNotNull { parseOne(arr.optJSONObject(it)) }
        } catch (e: Exception) {
            emptyList()
        }

        /** Parse one descriptor object, or null on a shape problem. */
        fun parseOne(o: JSONObject?): NotifDescriptor? {
            if (o == null) return null
            return try {
                val actions = mutableListOf<NotifAction>()
                val arr = o.optJSONArray("actions")
                if (arr != null) for (i in 0 until arr.length()) {
                    val a = arr.optJSONObject(i) ?: continue
                    actions.add(
                        NotifAction(
                            id = a.optString("id"),
                            title = a.optString("title"),
                            style = a.optString("style").takeIf { it.isNotEmpty() },
                            type = a.optString("type").takeIf { it.isNotEmpty() },
                        ),
                    )
                }
                val messages = mutableListOf<NotifMessage>()
                val messageArray = o.optJSONArray("messages")
                if (messageArray != null) for (i in 0 until messageArray.length()) {
                    val message = messageArray.optJSONObject(i) ?: continue
                    messages.add(
                        NotifMessage(
                            seq = message.optInt("seq"),
                            senderId = message.optInt("senderId"),
                            senderName = message.optString("senderName"),
                            text = message.optString("text"),
                            timestamp = message.optLong("timestamp"),
                        ),
                    )
                }
                NotifDescriptor(
                    tag = o.optString("tag"),
                    kind = o.optString("kind"),
                    title = o.optString("title"),
                    body = o.optString("body"),
                    // Fallback 1 keeps a rolling-upgrade client useful against an older server that does not
                    // carry count yet; the new contract always sends an exact non-negative value.
                    count = o.optInt("count", if (o.optString("kind") == "thread-message") 1 else 0)
                        .coerceAtLeast(0),
                    lang = o.optString("lang"),
                    // optString returns "null" for a JSON null — guard explicitly so null stays null.
                    icon = if (o.isNull("icon")) null else o.optString("icon").takeIf { it.isNotEmpty() },
                    renotify = o.optBoolean("renotify", false),
                    attention = o.optString("attention").takeIf { it.isNotEmpty() },
                    silent = if (o.has("silent") && !o.isNull("silent")) o.optBoolean("silent") else null,
                    actions = actions,
                    messages = messages,
                    previewMode = o.optString("previewMode", "message"),
                    data = o.optJSONObject("data") ?: JSONObject(),
                )
            } catch (e: Exception) {
                null
            }
        }
    }
}
