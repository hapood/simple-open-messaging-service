package com.soms.client

import android.app.Notification
import androidx.core.app.NotificationCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NotificationBodyTest {
    @Test
    fun collapsedAndExpandedTemplatesUseTheExactRustBody() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        for (body in listOf(
            "[1 message]Latest",
            "[101 messages][@]Alice: Latest",
            "[3 messages][@]New message",
            "[1 message][Message retracted]",
        )) {
            val builder = NotificationCompat.Builder(ctx, SomsMessagingService.CHANNEL_MESSAGES)
                .setSmallIcon(R.drawable.ic_notification)
            SomsMessagingService.applyNotificationBody(builder, body)
            val card = builder.build()
            assertEquals(body, card.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
            assertEquals(body, card.extras.getCharSequence(Notification.EXTRA_BIG_TEXT).toString())
            assertFalse(card.extras.containsKey(Notification.EXTRA_MESSAGES))
            assertEquals("android.app.Notification\$BigTextStyle", card.extras.getString(Notification.EXTRA_TEMPLATE))
        }
    }
}
