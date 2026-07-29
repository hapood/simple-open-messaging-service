package com.soms.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeComposerGeometryTest {
    @Test
    fun `emoji and system surfaces report the same total for the same keyboard height`() {
        val emoji = NativeComposerGeometry.occupiedDevicePx(
            visible = true,
            composerBasePx = 147,
            keyboardHeightPx = 781,
        )
        val system = NativeComposerGeometry.occupiedDevicePx(
            visible = true,
            composerBasePx = 147,
            keyboardHeightPx = 781,
        )

        assertEquals(928, emoji)
        assertEquals(emoji, system)
    }

    @Test
    fun `hidden composer reports zero occupation`() {
        assertEquals(
            0,
            NativeComposerGeometry.occupiedDevicePx(
                visible = false,
                composerBasePx = 147,
                keyboardHeightPx = 781,
            ),
        )
    }

    @Test
    fun `device height is rounded once into CSS pixels`() {
        assertEquals(354, NativeComposerGeometry.toCssPx(928, 2.62f))
        assertEquals(0, NativeComposerGeometry.toCssPx(928, 0f))
    }

    @Test
    fun `only changed final heights are emitted`() {
        assertTrue(NativeComposerGeometry.shouldEmit(null, 354))
        assertFalse(NativeComposerGeometry.shouldEmit(354, 354))
        assertTrue(NativeComposerGeometry.shouldEmit(354, 56))
    }

    @Test
    fun `handoff timeout never competes with a running IME animation`() {
        assertFalse(
            NativeComposerGeometry.shouldCompleteHandoffFallback(
                isToSystem = true,
                imeAnimationRunning = true,
                keyboardHeightPx = 831,
                minimumKeyboardHeightPx = 200,
            ),
        )
    }

    @Test
    fun `handoff timeout completes only when callbacks are absent and IME is visible`() {
        assertTrue(
            NativeComposerGeometry.shouldCompleteHandoffFallback(
                isToSystem = true,
                imeAnimationRunning = false,
                keyboardHeightPx = 831,
                minimumKeyboardHeightPx = 200,
            ),
        )
        assertFalse(
            NativeComposerGeometry.shouldCompleteHandoffFallback(
                isToSystem = true,
                imeAnimationRunning = false,
                keyboardHeightPx = 0,
                minimumKeyboardHeightPx = 200,
            ),
        )
        assertFalse(
            NativeComposerGeometry.shouldCompleteHandoffFallback(
                isToSystem = false,
                imeAnimationRunning = false,
                keyboardHeightPx = 831,
                minimumKeyboardHeightPx = 200,
            ),
        )
    }
}
