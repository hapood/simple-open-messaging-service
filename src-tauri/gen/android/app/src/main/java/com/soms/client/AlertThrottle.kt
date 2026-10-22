package com.soms.client

import java.util.concurrent.atomic.AtomicLong

/** Process-local global alert throttle. It controls sound/vibration only, never notification visibility. */
class AlertThrottle(
    private val windowMs: Long,
    private val nowMs: () -> Long,
) {
    private val lastClaimMs = AtomicLong(-windowMs)

    fun tryClaim(): Boolean {
        while (true) {
            val previous = lastClaimMs.get()
            val now = nowMs()
            if (now - previous < windowMs) return false
            if (lastClaimMs.compareAndSet(previous, now)) return true
        }
    }
}
