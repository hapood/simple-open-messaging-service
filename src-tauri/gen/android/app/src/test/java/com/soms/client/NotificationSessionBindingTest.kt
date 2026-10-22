package com.soms.client

import org.junit.Assert.*
import org.junit.Test

class NotificationSessionBindingTest {
    @Test fun currentSessionAndOriginAreBothRequired() {
        val binding = NotificationSessionBinding.fromValues(7, "https://alpha.test")!!
        assertTrue(binding.isCurrent(7, "https://alpha.test"))
        assertFalse(binding.isCurrent(8, "https://alpha.test"))
        assertFalse(binding.isCurrent(7, "https://bravo.test"))
        assertFalse(binding.isCurrent(null, "https://alpha.test"))
        assertFalse(binding.isCurrent(7, null))
    }
    @Test fun malformedOrUnboundNotificationsAreRejected() {
        assertNull(NotificationSessionBinding.fromValues(null, "https://alpha.test"))
        assertNull(NotificationSessionBinding.fromValues(0, "https://alpha.test"))
        assertNull(NotificationSessionBinding.fromValues(-1, "https://alpha.test"))
        assertNull(NotificationSessionBinding.fromValues(7, null))
        assertNull(NotificationSessionBinding.fromValues(7, ""))
    }
    @Test fun reloginCannotReparentCapturedNotification() {
        val old = NotificationSessionBinding.fromValues(7, "https://alpha.test")!!
        val fresh = NotificationSessionBinding.fromValues(8, "https://alpha.test")!!
        assertNotEquals(old, fresh)
        assertFalse(old.isCurrent(fresh.sessionId, fresh.origin))
        assertTrue(fresh.isCurrent(8, "https://alpha.test"))
    }
    @Test fun identicalSessionNumbersOnAnotherServerAreNotEquivalent() {
        val alpha = NotificationSessionBinding.fromValues(7, "https://alpha.test")!!
        val bravo = NotificationSessionBinding.fromValues(7, "https://bravo.test")!!
        assertNotEquals(alpha, bravo)
        assertFalse(alpha.isCurrent(bravo.sessionId, bravo.origin))
    }
}
