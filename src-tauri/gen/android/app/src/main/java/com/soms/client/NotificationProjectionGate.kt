package com.soms.client

/**
 * Process-wide single-flight gate for away-notification projection.
 *
 * FCM, background SSE, and WorkManager may wake the same session concurrently. The first caller executes;
 * later callers collapse into one trailing execution so a genuinely newer wake is not lost. Alert intent is
 * merged with OR: if any collapsed caller requested an alert, the trailing projection may alert.
 */
class NotificationProjectionGate {
    data class Wake(val allowAlert: Boolean, val target: Int)
    private var running = false
    private var pending = false
    private var pendingAllowAlert = false
    private var pendingTarget = 0

    @Synchronized
    fun tryStart(allowAlert: Boolean, target: Int = -1): Boolean {
        if (running) {
            pending = true
            pendingAllowAlert = pendingAllowAlert || allowAlert
            pendingTarget = if (target == -1 || pendingTarget == -1) -1 else maxOf(pendingTarget, target)
            return false
        }
        running = true
        return true
    }

    /** Return the merged alert flag for one trailing execution, or null when the lane is now idle. */
    @Synchronized
    fun nextOrFinish(): Wake? {
        if (!pending) {
            running = false
            return null
        }
        val wake = Wake(pendingAllowAlert, pendingTarget)
        pending = false
        pendingAllowAlert = false
        pendingTarget = 0
        return wake
    }
}
