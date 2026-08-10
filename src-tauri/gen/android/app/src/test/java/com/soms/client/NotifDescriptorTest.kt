package com.soms.client

import org.junit.Assert.assertEquals
import org.junit.Test

class NotifDescriptorTest {
    @Test
    fun parses_server_authored_badge_count() {
        val payload =
            """{"data":{"notifications":[{"tag":"soms-thread-7","kind":"thread-message","title":"Alice","body":"3 new messages","count":3,"lang":"en","icon":null,"renotify":true,"actions":[],"data":{"threadId":7,"seq":9}}]}}"""

        val descriptor = NotifDescriptor.parseList(payload).single()

        assertEquals(3, descriptor.count)
        assertEquals(7, descriptor.data.getInt("threadId"))
    }

    @Test
    fun older_server_without_count_falls_back_to_one_for_a_message_card() {
        val payload =
            """{"data":{"notifications":[{"tag":"soms-thread-7","kind":"thread-message","title":"Alice","body":"New messages","lang":"en","icon":null,"renotify":true,"actions":[],"data":{"threadId":7,"seq":9}}]}}"""

        assertEquals(1, NotifDescriptor.parseList(payload).single().count)
    }
}
