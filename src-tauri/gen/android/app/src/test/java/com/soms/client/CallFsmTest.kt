package com.soms.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for the pure call FSM + backstop policies ([CallFsm]). No Android/WebRTC deps — runs under
 * `:app:testUniversalDebugUnitTest`. These lock down the bug-prone decisions: the reconnect/accepted backstop
 * timing + the phase-transition table (the callee-racing-the-caller bug once lived in exactly this logic).
 */
class CallFsmTest {

    // ── reconnect backstop ──────────────────────────────────────────────────────

    @Test
    fun caller_backstop_delay_is_short_callee_outlasts_caller_restart() {
        assertEquals(CallFsm.RECONNECT_BACKSTOP_MS, CallFsm.reconnectBackstopDelayMs(isCaller = true))
        assertEquals(CallFsm.CALLEE_BACKSTOP_MS, CallFsm.reconnectBackstopDelayMs(isCaller = false))
        // The callee MUST outlast the caller's full restart window (first restart + short re-arm) — else it
        // fails + ends the call before the caller's restart can recover it.
        assertTrue(
            "callee backstop must exceed the caller's full restart window",
            CallFsm.CALLEE_BACKSTOP_MS > CallFsm.RECONNECT_BACKSTOP_MS + CallFsm.RECONNECT_BACKSTOP_SHORT_MS,
        )
    }

    @Test
    fun caller_answer_fetch_delay_is_a_short_fallback_window() {
        // A short fallback: long enough that a healthy SSE relay (sub-second) never trips it, short enough that a
        // dropped-answer call recovers well before the server's ~45s ringing/answer timeout fails it.
        assertTrue(CallFsm.ANSWER_FETCH_DELAY_MS in 1_000L..10_000L)
    }

    @Test
    fun only_caller_restarts_once_then_fails() {
        // Caller with a live PC + no prior restart → restart.
        assertTrue(CallFsm.shouldRestartOnReconnect(isCaller = true, iceRestartTried = false, hasPc = true))
        // Already tried → give up (exactly one restart attempt).
        assertFalse(CallFsm.shouldRestartOnReconnect(isCaller = true, iceRestartTried = true, hasPc = true))
        // No PC → cannot restart.
        assertFalse(CallFsm.shouldRestartOnReconnect(isCaller = true, iceRestartTried = false, hasPc = false))
        // Callee never initiates a restart — it waits for the caller's.
        assertFalse(CallFsm.shouldRestartOnReconnect(isCaller = false, iceRestartTried = false, hasPc = true))
    }

    // ── phase-transition table ──────────────────────────────────────────────────

    @Test
    fun ringing_only_advances_the_caller_from_calling() {
        assertEquals("ringing", CallFsm.nextPhase("calling", isCaller = true, eventType = "ringing"))
        // Callee ignores its own ringing ack; a stale ringing after the caller moved on is a no-op.
        assertNull(CallFsm.nextPhase("calling", isCaller = false, eventType = "ringing"))
        assertNull(CallFsm.nextPhase("connecting", isCaller = true, eventType = "ringing"))
    }

    @Test
    fun accepted_moves_caller_to_connecting() {
        assertEquals("connecting", CallFsm.nextPhase("calling", isCaller = true, eventType = "accepted"))
        assertEquals("connecting", CallFsm.nextPhase("ringing", isCaller = true, eventType = "accepted"))
        // The callee is the one accepting — it does not transition on the caller-side `accepted` echo.
        assertNull(CallFsm.nextPhase("calling", isCaller = false, eventType = "accepted"))
    }

    @Test
    fun connected_advances_any_live_non_connected_call() {
        assertEquals("connected", CallFsm.nextPhase("connecting", isCaller = true, eventType = "connected"))
        assertEquals("connected", CallFsm.nextPhase("connecting", isCaller = false, eventType = "connected"))
        // Idempotent: already connected / idle / ended → no-op.
        assertNull(CallFsm.nextPhase("connected", isCaller = true, eventType = "connected"))
        assertNull(CallFsm.nextPhase("idle", isCaller = true, eventType = "connected"))
    }

    @Test
    fun terminal_ends_any_live_call_exactly_once() {
        for (e in listOf("declined", "cancelled", "missed", "ended")) {
            assertEquals("ended", CallFsm.nextPhase("ringing", isCaller = true, eventType = e))
            assertEquals("ended", CallFsm.nextPhase("connected", isCaller = false, eventType = e))
            // Already idle/ended → no-op (idempotent — a stray late frame must not double-fire).
            assertNull(CallFsm.nextPhase("idle", isCaller = true, eventType = e))
            assertNull(CallFsm.nextPhase("ended", isCaller = false, eventType = e))
        }
    }

    @Test
    fun unknown_event_is_a_noop() {
        assertNull(CallFsm.nextPhase("connected", isCaller = true, eventType = "incoming"))
        assertNull(CallFsm.nextPhase("connected", isCaller = true, eventType = "bogus"))
    }
}
