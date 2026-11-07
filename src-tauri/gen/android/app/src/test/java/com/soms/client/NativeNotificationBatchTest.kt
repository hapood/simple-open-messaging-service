package com.soms.client

import org.junit.Assert.*
import org.junit.Test

class NativeNotificationBatchTest {
    @Test
    fun decodes_rust_content_without_reordering_or_rewriting_it() {
        val batch = NativeNotificationBatch("""{"commands":[{"operation":"show","notification":{
          "notificationId":"card-a","threadId":7,"count":101,"title":"Peer","body":"Rust body","hasUnreadMention":true,"silent":true,
          "messages":[{"seq":6,"timestampMs":1788912000000,"senderKey":"peer@example.test",
          "senderName":"Peer","text":"Rust text","avatarIndex":0}]
        }}]}""", arrayOf(byteArrayOf(0, -1)), "test-login")
        val descriptor = batch.descriptors().single()
        assertEquals("card-a", descriptor.tag)
        assertEquals(101, descriptor.count)
        assertEquals("Rust body", descriptor.body)
        assertEquals("Rust text", descriptor.messages.single().text)
        assertEquals(1788912000000L, descriptor.messages.single().timestamp)
        assertSame(batch.avatars[0], descriptor.messages.single().avatar)
        assertEquals(7, descriptor.threadId)
    }

    @Test(expected = IllegalArgumentException::class)
    fun show_without_instance_id_is_rejected() {
        NativeNotificationBatch("""{"commands":[{"operation":"show","notification":{"threadId":7}}]}""",
            emptyArray(), "test-login").descriptors()
    }

    @Test
    fun removal_without_an_existing_card_is_a_noop() {
        val batch = NativeNotificationBatch("""{"commands":[{"operation":"remove",
            "notification":{"threadId":7,"notificationId":null}}]}""", emptyArray(), "test-login")
        assertTrue(batch.descriptors().isEmpty())
    }

    @Test
    fun renders_content_free_show_and_remove_commands() {
        val batch = NativeNotificationBatch("""{"commands":[
          {"operation":"show","notification":{"notificationId":"card-b","threadId":7,"count":1,"title":"Peer",
           "body":"New message","hasUnreadMention":false,"silent":false,"messages":[]}},
          {"operation":"remove","notification":{"notificationId":"card-c","threadId":8}}
        ]}""", emptyArray(), "test-login")
        val descriptors = batch.descriptors()
        assertEquals("New message", descriptors[0].body)
        assertTrue(descriptors[0].messages.isEmpty())
        assertEquals(0, descriptors[1].count)
        assertEquals(8, descriptors[1].threadId)
    }
}
