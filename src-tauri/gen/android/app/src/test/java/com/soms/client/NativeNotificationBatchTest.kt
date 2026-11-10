package com.soms.client

import org.junit.Assert.*
import org.junit.Test

class NativeNotificationBatchTest {
    @org.junit.Test fun request_target_survives_without_a_thread_id() {
        val result = NativeNotificationBatch("""{"commands":[{"operation":"show","notification":{
            "target":{"kind":"friend-requests"},"notificationId":"request-card","count":1,
            "title":"SOMS","body":"New requests","silent":true,"hasUnreadMention":false,"messages":[]
        }}]}""", emptyArray()).descriptors().single()
        assertNull(result.latestSeq)
        org.junit.Assert.assertFalse(org.json.JSONObject(result.target).has("threadId"))
        org.junit.Assert.assertEquals("friend-requests", org.json.JSONObject(result.target).getString("kind"))
    }

    @Test
    fun decodes_rust_content_without_reordering_or_rewriting_it() {
        val batch = NativeNotificationBatch("""{"commands":[{"operation":"show","notification":{
          "notificationId":"card-a","target":{"kind":"thread","threadId":7},"latestSeq":42,"count":101,"title":"Peer","body":"Rust body","hasUnreadMention":true,"silent":true,
          "messages":[{"seq":6,"timestampMs":1788912000000,"senderKey":"peer@example.test",
          "senderName":"Peer","text":"Rust text","avatarIndex":0}]
        }}]}""", arrayOf(byteArrayOf(0, -1)))
        val descriptor = batch.descriptors().single()
        assertEquals("card-a", descriptor.tag)
        assertEquals(42, descriptor.latestSeq)
        assertEquals(101, descriptor.count)
        assertEquals("Rust body", descriptor.body)
        assertEquals("Rust text", descriptor.messages.single().text)
        assertEquals(1788912000000L, descriptor.messages.single().timestamp)
        assertSame(batch.avatars[0], descriptor.messages.single().avatar)
        assertEquals(7, org.json.JSONObject(descriptor.target).getInt("threadId"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun show_without_instance_id_is_rejected() {
        NativeNotificationBatch("""{"commands":[{"operation":"show","notification":{"target":{"kind":"thread","threadId":7}}}]}""",
            emptyArray()).descriptors()
    }

    @Test
    fun thread_show_rejects_missing_or_invalid_ceiling() {
        for (field in listOf("", ",\"latestSeq\":-1", ",\"latestSeq\":2147483648", ",\"latestSeq\":1.5", ",\"latestSeq\":\"42\"")) {
            val metadata = """{"commands":[{"operation":"show","notification":{
                "notificationId":"card-a","target":{"kind":"thread","threadId":7}$field,
                "count":1,"title":"Peer","body":"New message","hasUnreadMention":false,"silent":false,"messages":[]
            }}]}"""
            assertTrue(runCatching { NativeNotificationBatch(metadata, emptyArray()).descriptors() }.isFailure)
        }
    }

    @Test
    fun removal_without_an_existing_card_is_a_noop() {
        val batch = NativeNotificationBatch("""{"commands":[{"operation":"remove",
            "notification":{"target":{"kind":"thread","threadId":7},"notificationId":null}}]}""", emptyArray())
        assertTrue(batch.descriptors().isEmpty())
    }

    @Test
    fun renders_content_free_show_and_remove_commands() {
        val batch = NativeNotificationBatch("""{"commands":[
          {"operation":"show","notification":{"notificationId":"card-b","target":{"kind":"thread","threadId":7},"latestSeq":42,"count":1,"title":"Peer",
           "body":"New message","hasUnreadMention":false,"silent":false,"messages":[]}},
          {"operation":"remove","notification":{"notificationId":"card-c","target":{"kind":"thread","threadId":8}}}
        ]}""", emptyArray())
        val descriptors = batch.descriptors()
        assertEquals("New message", descriptors[0].body)
        assertTrue(descriptors[0].messages.isEmpty())
        assertEquals(0, descriptors[1].count)
        assertEquals(8, org.json.JSONObject(descriptors[1].target).getInt("threadId"))
    }
}
