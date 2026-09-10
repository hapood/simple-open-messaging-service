package com.soms.client

/** Latest notification tap survives WebView creation until the navigation handler accepts it. */
class PendingThreadNavigation {
    private var threadId: String? = null

    @Synchronized fun offer(value: String) {
        val id = value.toIntOrNull()?.takeIf { it > 0 } ?: return
        threadId = id.toString()
    }
    @Synchronized fun peek(): String? = threadId
    @Synchronized fun acknowledge(value: String) {
        if (threadId == value) threadId = null
    }
    @Synchronized fun clear() { threadId = null }
}
