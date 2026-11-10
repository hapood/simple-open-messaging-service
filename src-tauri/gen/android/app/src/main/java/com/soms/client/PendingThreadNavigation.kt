package com.soms.client

import java.util.UUID
import org.json.JSONObject

/** Latest notification tap survives WebView creation until the navigation handler accepts it.
 * The bridge reads/acks this opaque JSON value, not a thread ID: repeated taps are distinct. */
class PendingThreadNavigation(
    private val validate: (String) -> String? = RustRuntimeBridge::validateNotificationTarget,
) {
    private var pending: String? = null

    @Synchronized fun offer(value: String?): Boolean {
        val raw = value ?: return false
        val admitted = validate(raw) ?: return false
        val target = JSONObject(admitted)
        pending = JSONObject().put("id", UUID.randomUUID().toString()).put("target", target).toString()
        return true
    }
    @Synchronized fun peek(): String? = pending
    @Synchronized fun acknowledge(value: String) {
        if (pending == value) pending = null
    }
    @Synchronized fun clear() { pending = null }
}
