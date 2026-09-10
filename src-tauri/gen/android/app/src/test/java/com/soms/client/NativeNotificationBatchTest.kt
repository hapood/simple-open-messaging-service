package com.soms.client

import org.junit.Assert.*
import org.junit.Test

class NativeNotificationBatchTest {
    private fun batch() = NativeNotificationBatch("""{"error":null,"threads":[{
      "threadId":7,"unreadCount":101,"title":"Peer","hasUnreadMention":true,"muted":false,
      "previews":[
        {"seq":6,"createdAt":"2026-09-09T00:00:00.000Z","sender":{"account":"peer","domain":"example.test"},"senderName":"Peer","status":"MODERATION_REMOVAL","avatarIndex":0},
        {"seq":5,"createdAt":"2026-09-09T00:00:00.000Z","sender":{"account":"peer","domain":"example.test"},"senderName":"Peer","status":"USER_RETRACTION","avatarIndex":0}
      ]}]}""", arrayOf(byteArrayOf(0, -1)), 4L)

    @Test
    fun native_metadata_preserves_count_identity_binary_images_and_tomb_reasons() {
        val data = batch()
        val descriptor = data.descriptors("message", "private", "retracted", "removed").single()
        assertEquals(101, descriptor.count)
        assertEquals(listOf(5, 6), descriptor.messages.map { it.seq })
        assertEquals(listOf("retracted", "removed"), descriptor.messages.map { it.text })
        assertEquals("peer@example.test", descriptor.messages[0].senderKey)
        assertSame(data.avatars[0], descriptor.messages[0].avatar)
        assertSame(data.avatars[0], descriptor.messages[1].avatar)
        assertEquals(7, descriptor.data.getInt("threadId"))
    }

    @Test
    fun private_mode_uses_private_summary() {
        assertEquals("private", batch().descriptors("private", "private", "retracted", "removed").single().body)
    }
}
