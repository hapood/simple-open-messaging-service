package com.soms.client

/**
 * Pure (Android-free) decisions for the per-thread notification path — extracted from
 * [SomsMessagingService]'s companion so they're JUnit-testable WITHOUT loading the
 * `FirebaseMessagingService` subclass (which needs Android). Notification state is represented by the
 * global HWM and per-thread dismiss HWM; this helper only derives stable notification ids.
 */
object NotifThreadLogic {

    /** Exact non-negative count represented by one card. Launcher implementations own the visual cap
     *  (`999+`, `99+`, or a dot), so truncating here would make their aggregate inaccurate. */
    fun badgeNumber(count: Int): Int = count.coerceAtLeast(0)

    /** The stable notification id for a per-thread card: `base + threadId` (base is offset clear of the
     *  reserved away/FGS/admin/summary ids + the JS seq range). */
    fun notifId(base: Int, threadId: Int): Int = base + threadId
}
