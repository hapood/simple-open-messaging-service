package com.soms.client

import android.graphics.Bitmap
import android.graphics.Color
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream

@RunWith(AndroidJUnit4::class)
class NotificationAvatarsTest {
    @Test
    fun missingAvatarUsesTransparentLogoWithoutLauncherBackground() {
        val avatar = NotificationAvatars.resolve(
            InstrumentationRegistry.getInstrumentation().targetContext,
            listOf(message(null)),
        ).getValue("peer")

        assertEquals(64, avatar.width)
        assertEquals(64, avatar.height)
        assertEquals(0, Color.alpha(avatar.getPixel(0, 0)))
        assertEquals(0, Color.alpha(avatar.getPixel(63, 63)))
        assertFalse(Color.alpha(avatar.getPixel(32, 32)) == 0)
    }

    @Test
    fun senderAvatarBytesOverrideTheFallback() {
        val source = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888)
        source.eraseColor(Color.rgb(32, 188, 72))
        val bytes = ByteArrayOutputStream().also {
            source.compress(Bitmap.CompressFormat.PNG, 100, it)
        }.toByteArray()
        val avatar = NotificationAvatars.resolve(
            InstrumentationRegistry.getInstrumentation().targetContext,
            listOf(message(bytes)),
        ).getValue("peer")

        assertEquals(64, avatar.width)
        assertEquals(64, avatar.height)
        assertEquals(0, Color.alpha(avatar.getPixel(0, 0)))
        assertEquals(0, Color.alpha(avatar.getPixel(63, 63)))
        assertEquals(Color.rgb(32, 188, 72), avatar.getPixel(32, 32))
        assertEquals(Color.rgb(32, 188, 72), avatar.getPixel(32, 0))
    }

    private fun message(avatar: ByteArray?) = NotifMessage(
        seq = 1,
        senderId = 42,
        senderName = "Peer",
        text = "Test",
        timestamp = 1L,
        senderKey = "peer",
        avatar = avatar,
    )
}
