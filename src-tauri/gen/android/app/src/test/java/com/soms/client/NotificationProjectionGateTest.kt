package com.soms.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationProjectionGateTest {
    @Test
    fun concurrent_wakes_collapse_into_one_trailing_execution() {
        val gate = NotificationProjectionGate()

        assertTrue(gate.tryStart(allowAlert = false))
        assertFalse(gate.tryStart(allowAlert = false))
        assertFalse(gate.tryStart(allowAlert = true))

        assertEquals(true, gate.nextOrFinish())
        assertNull(gate.nextOrFinish())
        assertTrue(gate.tryStart(allowAlert = false))
    }

    @Test
    fun an_idle_completion_does_not_create_a_trailing_execution() {
        val gate = NotificationProjectionGate()

        assertTrue(gate.tryStart(allowAlert = true))
        assertNull(gate.nextOrFinish())
    }
}
