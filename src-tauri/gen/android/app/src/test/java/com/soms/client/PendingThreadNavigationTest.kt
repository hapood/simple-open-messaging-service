package com.soms.client

import org.junit.Assert.*
import org.junit.Test

class PendingThreadNavigationTest {
    @Test fun retains_tap_until_handler_acknowledges() {
        val pending = PendingThreadNavigation()
        pending.offer("7", 11, "https://primary", 11, "https://primary")
        val tap = pending.peek()!!
        assertTrue(tap.contains("\"threadId\":7"))
        assertTrue(tap.contains("\"sessionId\":11"))
        assertEquals(tap, pending.peek())
        pending.acknowledge(tap)
        assertNull(pending.peek())
    }
    @Test fun old_acknowledgement_cannot_discard_newer_tap_even_on_same_thread() {
        val pending = PendingThreadNavigation()
        pending.offer("7", 11, "https://primary", 11, "https://primary")
        val old = pending.peek()!!
        pending.offer("7", 11, "https://primary", 11, "https://primary")
        val current = pending.peek()!!
        assertNotEquals(old, current)
        pending.acknowledge(old)
        assertEquals(current, pending.peek())
        pending.clear()
        assertNull(pending.peek())
    }
    @Test fun rejects_unscoped_old_session_and_other_primary_origin() {
        val pending = PendingThreadNavigation()
        assertFalse(pending.offer("7", null, null, 11, "https://primary"))
        assertFalse(pending.offer("7", 11, "https://primary", 12, "https://primary"))
        assertFalse(pending.offer("7", 11, "https://old", 11, "https://primary"))
        assertFalse(pending.offer("7", 11, "https://primary", null, "https://primary"))
        assertNull(pending.peek())
    }
    @Test fun rejects_invalid_thread_ids() {
        val pending = PendingThreadNavigation()
        for (value in listOf("0", "-1", "bad", "2147483648")) pending.offer(value, 11, "https://primary", 11, "https://primary")
        assertNull(pending.peek())
    }
}
