package com.soms.client

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * JVM unit tests for [NotifThreadLogic] — the pure per-thread notification decisions extracted out of the
 * `FirebaseMessagingService` subclass so they're testable without Android. Pins stable id derivation.
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
    fun badgeNumber_preserves_the_exact_count_for_launcher_owned_formatting() {
        assertEquals(0, NotifThreadLogic.badgeNumber(-1))
        assertEquals(0, NotifThreadLogic.badgeNumber(0))
        assertEquals(42, NotifThreadLogic.badgeNumber(42))
        assertEquals(1_000, NotifThreadLogic.badgeNumber(1_000))
    }
}
