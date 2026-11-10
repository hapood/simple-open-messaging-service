package com.soms.client

import org.junit.Assert.*
import org.junit.Test

class PendingThreadNavigationTest {
    @Test fun retains_tap_until_handler_acknowledges() {
        val pending = PendingThreadNavigation { raw -> raw.toIntOrNull()?.takeIf { it > 0 }?.let { "{\"kind\":\"thread\",\"threadId\":$it}" } }
        pending.offer("7")
        val tap = pending.peek()!!
        assertTrue(tap.contains("\"threadId\":7"))
        assertFalse(tap.contains("sessionId"))
        assertFalse(tap.contains("origin"))
        assertEquals(tap, pending.peek())
        pending.acknowledge(tap)
        assertNull(pending.peek())
    }
    @Test fun old_acknowledgement_cannot_discard_newer_tap_even_on_same_thread() {
        val pending = PendingThreadNavigation { raw -> raw.toIntOrNull()?.takeIf { it > 0 }?.let { "{\"kind\":\"thread\",\"threadId\":$it}" } }
        pending.offer("7")
        val old = pending.peek()!!
        pending.offer("7")
        val current = pending.peek()!!
        assertNotEquals(old, current)
        pending.acknowledge(old)
        assertEquals(current, pending.peek())
        pending.clear()
        assertNull(pending.peek())
    }
    @Test fun rejects_invalid_thread_ids() {
        val pending = PendingThreadNavigation { raw -> raw.toIntOrNull()?.takeIf { it > 0 }?.let { "{\"kind\":\"thread\",\"threadId\":$it}" } }
        for (value in listOf("0", "-1", "bad", "2147483648")) pending.offer(value)
        assertNull(pending.peek())
    }
}
