package com.soms.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationProjectionGateTest {
    @Test
    fun targets_merge_by_maximum_and_polling_keeps_head_discovery() {
        val gate = NotificationProjectionGate()
        assertTrue(gate.tryStart(false, 2))
        assertFalse(gate.tryStart(false, 9))
        assertFalse(gate.tryStart(true, 5))
        assertEquals(NotificationProjectionGate.Wake(true, 9), gate.nextOrFinish())
        assertFalse(gate.tryStart(false, 12))
        assertFalse(gate.tryStart(false, -1))
        assertEquals(NotificationProjectionGate.Wake(false, -1), gate.nextOrFinish())
        assertNull(gate.nextOrFinish())
    }
    @Test
    fun concurrent_wakes_collapse_into_one_trailing_execution() {
        val gate = NotificationProjectionGate()

        assertTrue(gate.tryStart(allowAlert = false))
        assertFalse(gate.tryStart(allowAlert = false))
        assertFalse(gate.tryStart(allowAlert = true))

        assertEquals(NotificationProjectionGate.Wake(true, -1), gate.nextOrFinish())
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
