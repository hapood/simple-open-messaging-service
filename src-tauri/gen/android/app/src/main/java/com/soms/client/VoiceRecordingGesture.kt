package com.soms.client

/** Pure voice-gesture rules shared by the native composer and JVM tests. */
internal object VoiceRecordingGesture {
    const val CANCEL_ENTER_DP = 48
    const val CANCEL_EXIT_DP = 32
    const val MIN_DURATION_MS = 500L

    fun nextCancelState(currentlyCancelled: Boolean, upwardDistancePx: Float, density: Float): Boolean {
        val thresholdDp = if (currentlyCancelled) CANCEL_EXIT_DP else CANCEL_ENTER_DP
        val thresholdPx = thresholdDp * density
        return if (currentlyCancelled) upwardDistancePx > thresholdPx else upwardDistancePx >= thresholdPx
    }

    fun isTooShort(durationMs: Long): Boolean = durationMs < MIN_DURATION_MS
}
