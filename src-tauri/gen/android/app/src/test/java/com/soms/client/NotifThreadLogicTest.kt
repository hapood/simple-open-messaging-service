package com.soms.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for [NotifThreadLogic] — the pure per-thread notification decisions extracted out of the
 * `FirebaseMessagingService` subclass so they're testable without Android. Pins the #4 re-alert rule + the
 * id derivation (regression-prone: a flipped `>` or a wrong base would silently break per-thread alerting).
 *
 * Runs under `./gradlew :app:testDebugUnitTest` (no device) — `NotifThreadLogic` is a plain `object` with no
 * Android dependencies, so it loads in a stock JVM.
 */
class NotifThreadLogicTest {

    @Test
    fun notifId_is_base_plus_threadId() {
        assertEquals(0x10000 + 7, NotifThreadLogic.notifId(0x10000, 7))
        assertEquals(0x10000, NotifThreadLogic.notifId(0x10000, 0)) // seq 0 is legitimate
    }

    @Test
    fun shouldAlert_true_on_first_sight() {
        // No last-alert entry → the card has never alerted → alert.
        assertTrue(NotifThreadLogic.shouldAlert(null, 5))
    }

    @Test
    fun shouldAlert_true_when_latestSeq_advanced() {
        assertTrue(NotifThreadLogic.shouldAlert(5, 6))
    }

    @Test
    fun shouldAlert_false_when_latestSeq_unchanged() {
        // The #4 core: a re-fetch that brought nothing new stays quiet.
        assertFalse(NotifThreadLogic.shouldAlert(5, 5))
    }

    @Test
    fun shouldAlert_false_when_latestSeq_went_backward() {
        // Defensive — a stale/out-of-order seq must not re-alert.
        assertFalse(NotifThreadLogic.shouldAlert(5, 4))
    }

    @Test
    fun anyShouldAlert_false_when_empty() {
        assertFalse(NotifThreadLogic.anyShouldAlert(emptyList(), emptyMap()))
    }

    @Test
    fun anyShouldAlert_false_when_all_unchanged() {
        // Both threads alerted before at exactly these seqs → no change → summary silent.
        val last = mapOf(1 to 5, 2 to 3)
        assertFalse(NotifThreadLogic.anyShouldAlert(listOf(1 to 5, 2 to 3), last))
    }

    @Test
    fun anyShouldAlert_true_when_one_is_first_sight() {
        // Thread 1 already alerted at 5; thread 2 never alerted → summary alerts.
        val last = mapOf(1 to 5)
        assertTrue(NotifThreadLogic.anyShouldAlert(listOf(1 to 5, 2 to 3), last))
    }

    @Test
    fun anyShouldAlert_true_when_one_advanced() {
        // Thread 1 unchanged; thread 2 advanced 3 → 7 → summary alerts.
        val last = mapOf(1 to 5, 2 to 3)
        assertTrue(NotifThreadLogic.anyShouldAlert(listOf(1 to 5, 2 to 7), last))
    }
}
