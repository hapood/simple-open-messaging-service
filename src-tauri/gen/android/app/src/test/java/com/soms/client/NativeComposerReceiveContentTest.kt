package com.soms.client

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeComposerReceiveContentTest {
    @Test
    fun `receive-content MIME filters use Android-compatible top-level types`() {
        assertTrue(COMPOSER_RECEIVE_MIME_TYPES.isNotEmpty())
        COMPOSER_RECEIVE_MIME_TYPES.forEach { mimeType ->
            assertFalse(mimeType.startsWith('*'))
            assertTrue(mimeType.endsWith("/*"))
        }
    }
}
