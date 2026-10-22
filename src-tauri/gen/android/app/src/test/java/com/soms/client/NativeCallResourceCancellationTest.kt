package com.soms.client

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class NativeCallResourceCancellationTest {
    private class Fixture {
        val queue = ArrayDeque<() -> Unit>()
        var owner: String? = "call-a"
        val events = mutableListOf<String>()
        val scope = NativeCallResourceCancellation(
            enqueue = { queue.addLast(it) },
            currentOwner = { owner },
            release = { events += "release-$owner"; owner = null },
        )
        fun drain() { while (queue.isNotEmpty()) queue.removeFirst().invoke() }
    }

    @Test fun cancellationInterruptsTransportBeforeQueuedRelease() {
        val f = Fixture()
        f.scope.registerNetwork { f.events += "cancel-http" }
        val cancel = f.scope.prepare()
        assertTrue(f.scope.isClosing)
        assertTrue(f.events.isEmpty())
        cancel()
        assertEquals(listOf("cancel-http"), f.events)
        f.drain()
        assertEquals(listOf("cancel-http", "release-call-a"), f.events)
        assertFalse(f.scope.isClosing)
    }

    @Test fun oldQueuedWorkCannotRunAfterSessionReplacement() {
        val f = Fixture()
        f.scope.execute { f.events += "old-request-with-new-token" }
        f.scope.prepare().invoke()
        f.drain()
        assertFalse(f.events.contains("old-request-with-new-token"))
    }

    @Test fun newSdkWorkWaitsForResourceRelease() {
        val f = Fixture()
        val cancel = f.scope.prepare()
        f.scope.execute { f.owner = "call-b"; f.events += "new-call" }
        assertTrue(f.queue.isEmpty())
        cancel()
        f.drain()
        assertEquals(listOf("release-call-a", "new-call"), f.events)
        assertEquals("call-b", f.owner)
    }

    @Test fun delayedOldReleaseDoesNotDestroyNewOwner() {
        val f = Fixture()
        val cancel = f.scope.prepare()
        f.owner = "call-b"
        cancel()
        f.drain()
        assertEquals("call-b", f.owner)
        assertTrue(f.events.isEmpty())
    }

    @Test fun repeatedReplacementInvalidatesIntermediateWork() {
        val f = Fixture()
        val first = f.scope.prepare()
        f.scope.execute { f.events += "intermediate-session" }
        val second = f.scope.prepare()
        f.scope.execute { f.events += "latest-session" }
        second()
        first()
        f.drain()
        assertEquals(listOf("release-call-a", "latest-session"), f.events)
        assertFalse(f.scope.isClosing)
    }

    @Test fun nullOwnerNeverDisposesAnUnrelatedCall() {
        val f = Fixture()
        f.owner = null
        val cancel = f.scope.prepare()
        f.owner = "call-a"
        cancel()
        f.drain()
        assertEquals("call-a", f.owner)
    }

    @Test fun requestRegistrationAfterClosingIsRejected() {
        val f = Fixture()
        val cancel = f.scope.prepare()
        assertFalse(f.scope.registerNetwork { fail("request must never run") })
        cancel()
        f.drain()
    }

    @Test fun staleUnregistrationCannotRemoveNewRequestCancellation() {
        val f = Fixture()
        val old = { f.events += "cancel-old"; Unit }
        val current = { f.events += "cancel-current"; Unit }
        assertTrue(f.scope.registerNetwork(old))
        f.scope.prepare().invoke()
        f.drain()
        assertTrue(f.scope.registerNetwork(current))
        f.scope.unregisterNetwork(old)
        f.scope.prepare().invoke()
        assertEquals(listOf("cancel-old", "release-call-a", "cancel-current"), f.events)
    }

    @Test fun reorderedOldCancellationNeverCancelsNewRequest() {
        val f = Fixture()
        f.scope.registerNetwork { f.events += "cancel-old" }
        val first = f.scope.prepare()
        val second = f.scope.prepare()
        second()
        f.drain()
        f.owner = "call-b"
        f.scope.registerNetwork { fail("old release must not cancel the new request") }
        first()
        f.drain()
        assertEquals("call-b", f.owner)
    }

    @Test fun admittedWorkKeepsItsOriginalRevisionAcrossSubmissionDelay() {
        val f = Fixture()
        val admission = f.scope.admitWhileOpen { f.owner = "admitted"; true }!!
        val cancel = f.scope.prepare()
        cancel()
        f.drain()
        f.scope.execute(admission) { fail("old admission must not borrow the new session") }
        f.drain()
        assertNull(f.owner)
        assertNull(f.scope.admitWhileOpen { false })
    }

    @Test fun staleExpectedRevisionCannotMutateAnOpenFence() {
        val f = Fixture()
        val previous = f.scope.admitWhileOpen { true }!!
        f.scope.prepare().invoke()
        f.drain()
        assertNull(f.scope.admitWhileOpen(previous) {
            fail("a stale request must not write a snapshot under the replacement session")
            true
        })
        val current = f.scope.admitWhileOpen { true }!!
        assertNotNull(f.scope.admitWhileOpen(current) { true })
    }

    @Test fun incomingAdmissionCannotOverwriteAnotherAdmittedCall() {
        val f = Fixture()
        f.owner = null
        var phase = "idle"
        assertNotNull(f.scope.admitWhileOpen {
            f.owner = "call-b"
            phase = "incoming"
            true
        })
        assertNull(f.scope.admitWhileOpen {
            if (f.owner != null && f.owner != "call-a" && phase != "starting") {
                false
            } else {
                f.owner = "call-a"
                true
            }
        })
        assertEquals("call-b", f.owner)
        assertEquals("incoming", phase)
    }

    @Test fun admissionIsRejectedWhileClosing() {
        val f = Fixture()
        f.scope.prepare()
        assertNull(f.scope.admitWhileOpen { fail("snapshot writes must not run"); true })
    }

    @Test fun ownerCaptureCannotInterleaveWithSnapshotAdmission() {
        val f = Fixture()
        val pool = Executors.newFixedThreadPool(2)
        val entered = CountDownLatch(1)
        val proceed = CountDownLatch(1)
        val preparing = CountDownLatch(1)
        try {
            val admitted = pool.submit<Long?> {
                f.scope.admitWhileOpen {
                    entered.countDown()
                    assertTrue(proceed.await(5, TimeUnit.SECONDS))
                    f.owner = "admitted"
                    true
                }
            }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            val transition = pool.submit<() -> Unit> { preparing.countDown(); f.scope.prepare() }
            assertTrue(preparing.await(5, TimeUnit.SECONDS))
            proceed.countDown()
            assertNotNull(admitted.get(5, TimeUnit.SECONDS))
            transition.get(5, TimeUnit.SECONDS).invoke()
            f.drain()
            assertEquals(listOf("release-admitted"), f.events)
        } finally {
            proceed.countDown()
            pool.shutdownNow()
        }
    }

    @Test fun releaseWithNoNetworkRequestStillCompletes() {
        val f = Fixture()
        f.scope.prepare().invoke()
        f.drain()
        assertFalse(f.scope.isClosing)
        assertEquals(listOf("release-call-a"), f.events)
    }

    @Test fun releaseWakeupSurvivesRevisionChangeButDoesNotExecuteSdkWork() {
        val f = Fixture()
        val first = f.scope.prepare()
        var wakes = 0
        f.scope.whenReleased { wakes++ }
        val second = f.scope.prepare()
        first()
        f.drain()
        assertEquals(1, wakes)
        assertTrue(f.scope.isClosing)
        f.scope.whenReleased { wakes++ }
        second()
        f.drain()
        assertEquals(2, wakes)
        assertFalse(f.scope.isClosing)
    }
}
