package com.soms.client

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PendingThreadNavigationTest {
    private val opening = """{"target":{"kind":"thread","threadId":7},"latestSeq":42}"""

    @Test fun retains_rust_validated_opening_until_handler_acknowledges() {
        val pending = PendingThreadNavigation { raw -> raw.takeIf { it == opening } }
        assertTrue(pending.offer(opening))
        val tap = pending.peek()!!
        assertEquals(7, JSONObject(tap).getJSONObject("target").getInt("threadId"))
        assertEquals(42, JSONObject(tap).getInt("latestSeq"))
        assertFalse(tap.contains("sessionId"))
        assertFalse(tap.contains("origin"))
        assertEquals(tap, pending.peek())
        pending.acknowledge(tap)
        assertNull(pending.peek())
    }

    @Test fun old_acknowledgement_cannot_discard_newer_tap_even_on_same_thread() {
        val pending = PendingThreadNavigation { it }
        pending.offer(opening)
        val old = pending.peek()!!
        pending.offer(opening)
        val current = pending.peek()!!
        assertNotEquals(old, current)
        pending.acknowledge(old)
        assertEquals(current, pending.peek())
        pending.clear()
        assertNull(pending.peek())
    }

    @Test fun rust_rejection_does_not_replace_pending_tap() {
        val pending = PendingThreadNavigation { raw -> raw.takeIf { it == opening } }
        pending.offer(opening)
        val current = pending.peek()
        for (value in listOf(null, "7", """{"target":{"kind":"thread","threadId":7}}""")) {
            assertFalse(pending.offer(value))
            assertEquals(current, pending.peek())
        }
    }

    @Test fun request_opening_has_no_message_ceiling() {
        val pending = PendingThreadNavigation { it }
        pending.offer("""{"target":{"kind":"friend-requests"}}""")
        assertFalse(JSONObject(pending.peek()!!).has("latestSeq"))
    }
}
