package com.soms.client

/**
 * Android-free conversion of projected counts to launcher badge numbers.
 */
object NotifThreadLogic {

    /** Preserve this notification's non-negative count without a visual cap.
     *  The launcher owns badge presentation; a number or aggregation is not guaranteed. */
    fun badgeNumber(count: Int): Int = count.coerceAtLeast(0)
}
