package com.soms.client

import org.junit.Assert.*
import org.junit.Test

class PendingThreadNavigationTest {
    @Test fun retains_tap_until_handler_acknowledges() {
        val pending = PendingThreadNavigation()
        pending.offer("7")
        assertEquals("7", pending.peek())
        assertEquals("7", pending.peek())
        pending.acknowledge("7")
        assertNull(pending.peek())
    }
    @Test fun old_acknowledgement_cannot_discard_newer_tap() {
        val pending = PendingThreadNavigation()
        pending.offer("7")
        pending.offer("9")
        pending.acknowledge("7")
        assertEquals("9", pending.peek())
        pending.clear()
        assertNull(pending.peek())
    }
    @Test fun rejects_invalid_thread_ids() {
        val pending = PendingThreadNavigation()
        for (value in listOf("0", "-1", "bad", "2147483648")) pending.offer(value)
        assertNull(pending.peek())
    }
}
