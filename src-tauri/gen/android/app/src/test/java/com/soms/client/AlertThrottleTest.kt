package com.soms.client

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AlertThrottleTest {
    @Test
    fun first_claim_succeeds_and_claims_inside_window_are_suppressed() {
        var now = 0L
        val throttle = AlertThrottle(5_000) { now }

        assertTrue(throttle.tryClaim())
        now = 4_999
        assertFalse(throttle.tryClaim())
    }

    @Test
    fun claim_at_window_boundary_succeeds() {
        var now = 0L
        val throttle = AlertThrottle(5_000) { now }

        assertTrue(throttle.tryClaim())
        now = 5_000
        assertTrue(throttle.tryClaim())
    }
}
