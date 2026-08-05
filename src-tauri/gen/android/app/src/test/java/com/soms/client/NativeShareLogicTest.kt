package com.soms.client

import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NativeShareLogicTest {
    @Test
    fun `accepts and trims shared plain text`() {
        assertEquals(
            "A link https://example.com",
            NativeShareLogic.normalizedText(
                Intent.ACTION_SEND,
                "text/plain",
                "  A link https://example.com  ",
            ),
        )
    }

    @Test
    fun `rejects unrelated intents and empty content`() {
        assertNull(NativeShareLogic.normalizedText(Intent.ACTION_VIEW, "text/plain", "text"))
        assertNull(NativeShareLogic.normalizedText(Intent.ACTION_SEND, "image/png", "text"))
        assertNull(NativeShareLogic.normalizedText(Intent.ACTION_SEND, "text/plain", "  "))
    }
}
