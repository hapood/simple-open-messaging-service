package com.soms.client

import org.junit.Assert.assertEquals
import org.junit.Test

/** Pins count preservation independently of Android launcher formatting. */
class NotifThreadLogicTest {

    @Test
    fun badgeNumber_preserves_the_exact_count_for_launcher_owned_formatting() {
        assertEquals(0, NotifThreadLogic.badgeNumber(Int.MIN_VALUE))
        assertEquals(0, NotifThreadLogic.badgeNumber(-1))
        assertEquals(0, NotifThreadLogic.badgeNumber(0))
        assertEquals(1, NotifThreadLogic.badgeNumber(1))
        assertEquals(42, NotifThreadLogic.badgeNumber(42))
        assertEquals(1_000, NotifThreadLogic.badgeNumber(1_000))
        assertEquals(Int.MAX_VALUE, NotifThreadLogic.badgeNumber(Int.MAX_VALUE))
    }
}
