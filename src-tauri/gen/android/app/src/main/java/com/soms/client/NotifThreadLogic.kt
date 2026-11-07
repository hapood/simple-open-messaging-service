package com.soms.client

/**
 * Android-free conversion of projected counts to launcher badge numbers.
 */
object NotifThreadLogic {

    /** Exact non-negative count represented by one card. Launcher implementations own the visual cap
     *  (`999+`, `99+`, or a dot), so truncating here would make their aggregate inaccurate. */
    fun badgeNumber(count: Int): Int = count.coerceAtLeast(0)
}
