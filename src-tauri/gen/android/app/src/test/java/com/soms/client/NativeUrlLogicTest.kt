package com.soms.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NativeUrlLogicTest {
    @Test
    fun `finds a scheme anywhere inside a non-whitespace run`() {
        assertEquals(3, NativeUrlLogic.firstScheme("abchttps://x", 0, 12))
    }

    @Test
    fun `matches http and https case-insensitively`() {
        assertEquals(0, NativeUrlLogic.firstScheme("HTTP://x", 0, 8))
        assertEquals(2, NativeUrlLogic.firstScheme("--Https://x", 0, 11))
    }

    @Test
    fun `returns the next scheme when an earlier one is no longer valid`() {
        val text = "htxps://one-http://two"
        assertEquals(12, NativeUrlLogic.firstScheme(text, 0, text.length))
    }

    @Test
    fun `does not accept an incomplete scheme`() {
        assertNull(NativeUrlLogic.firstScheme("https:/", 0, 7))
    }
}
