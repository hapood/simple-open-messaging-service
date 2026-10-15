package com.soms.client

import java.util.UUID

/** Latest notification tap survives WebView creation until the navigation handler accepts it.
 * The bridge reads/acks this opaque JSON value, not a thread ID: repeated taps are distinct. */
class PendingThreadNavigation {
    private var pending: String? = null

    @Synchronized fun offer(value: String?, sessionId: Int?, origin: String?, currentSessionId: Int?, currentOrigin: String?): Boolean {
        val id = value?.toIntOrNull()?.takeIf { it > 0 } ?: return false
        val binding = NotificationSessionBinding.fromValues(sessionId, origin) ?: return false
        if (!binding.isCurrent(currentSessionId, currentOrigin)) return false
        pending = "{\"id\":\"${UUID.randomUUID()}\",\"threadId\":$id,\"sessionId\":$sessionId,\"origin\":${org.json.JSONObject.quote(origin)}}"
        return true
    }
    @Synchronized fun peek(): String? = pending
    @Synchronized fun acknowledge(value: String) {
        if (pending == value) pending = null
    }
    @Synchronized fun clear() { pending = null }
}
