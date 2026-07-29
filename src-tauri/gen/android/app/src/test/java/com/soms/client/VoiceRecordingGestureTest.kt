package com.soms.client

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceRecordingGestureTest {
    @Test
    fun `cancel gesture uses separate enter and exit thresholds`() {
        assertFalse(VoiceRecordingGesture.nextCancelState(false, 47f, 1f))
        assertTrue(VoiceRecordingGesture.nextCancelState(false, 48f, 1f))
        assertTrue(VoiceRecordingGesture.nextCancelState(true, 47f, 1f))
        assertTrue(VoiceRecordingGesture.nextCancelState(true, 33f, 1f))
        assertFalse(VoiceRecordingGesture.nextCancelState(true, 32f, 1f))
    }

    @Test
    fun `minimum duration boundary is accepted`() {
        assertTrue(VoiceRecordingGesture.isTooShort(499L))
        assertFalse(VoiceRecordingGesture.isTooShort(500L))
    }
}
