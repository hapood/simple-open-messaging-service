package com.soms.client

/**
 * Process-wide single-flight gate for away-notification projection.
 *
 * FCM, background SSE, and WorkManager may wake the same session concurrently. The first caller executes;
 * later callers collapse into one trailing execution so a genuinely newer wake is not lost. Alert intent is
 * merged with OR: if any collapsed caller requested an alert, the trailing projection may alert.
 */
class NotificationProjectionGate {
    private var running = false
    private var pending = false
    private var pendingAllowAlert = false

    @Synchronized
    fun tryStart(allowAlert: Boolean): Boolean {
        if (running) {
            pending = true
            pendingAllowAlert = pendingAllowAlert || allowAlert
            return false
        }
        running = true
        return true
    }

    /** Return the merged alert flag for one trailing execution, or null when the lane is now idle. */
    @Synchronized
    fun nextOrFinish(): Boolean? {
        if (!pending) {
            running = false
            return null
        }
        val allowAlert = pendingAllowAlert
        pending = false
        pendingAllowAlert = false
        return allowAlert
    }
}
