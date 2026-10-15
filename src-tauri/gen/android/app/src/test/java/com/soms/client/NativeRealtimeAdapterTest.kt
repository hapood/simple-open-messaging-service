package com.soms.client

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.*
import org.junit.Test

class NativeRealtimeAdapterTest {
    private class Runtime : NativeRealtimeRuntime {
        private val next = AtomicLong()
        val active = AtomicLong()
        val commands = mutableListOf<Pair<String, Long>>()
        var startHook: (Long) -> Unit = {}
        override fun start(): Long {
            val lease = next.incrementAndGet()
            active.set(lease)
            startHook(lease)
            record("start", lease)
            return lease
        }
        private fun record(command: String, lease: Long) = synchronized(commands) { commands.add(command to lease); Unit }
        override fun stop(instance: Long) { record("stop", instance); active.compareAndSet(instance, 0) }
        override fun network(instance: Long, online: Boolean) { if (active.get() == instance) record("net:$online", instance) }
        override fun retry(instance: Long): Long { if (active.get() != instance) return 0; record("retry", instance); return instance }
        override fun reconnect(instance: Long): Long { if (active.get() != instance) return 0; record("reconnect", instance); return instance }
    }

    @Test fun forwardsSystemFactsAndUserRequestsToOneRustLease() {
        val runtime = Runtime()
        val adapter = NativeRealtimeAdapter(runtime)
        adapter.start()
        adapter.start()
        adapter.network(false)
        adapter.network(true)
        adapter.retry()
        adapter.reconnect()
        assertEquals(listOf("start", "net:false", "net:true", "retry", "reconnect"), runtime.commands.map { it.first })
        assertTrue(runtime.commands.all { it.second == 1L })
        adapter.destroy()
    }

    @Test fun alreadyQueuedNetworkCallbacksAfterDestroyNeverReachRust() {
        val runtime = Runtime()
        val adapter = NativeRealtimeAdapter(runtime)
        adapter.start()
        adapter.destroy()
        adapter.network(true)
        adapter.network(false)
        adapter.retry()
        adapter.reconnect()
        adapter.start()
        adapter.destroy()
        assertEquals(listOf("start" to 1L, "stop" to 1L), runtime.commands)
        assertFalse(adapter.isAlive)
    }

    @Test fun callbacksBeforeStartAreOnlySystemFactsNotRuntimeCommands() {
        val runtime = Runtime()
        val adapter = NativeRealtimeAdapter(runtime)
        adapter.network(true)
        adapter.retry()
        adapter.reconnect()
        assertTrue(runtime.commands.isEmpty())
        adapter.destroy()
        adapter.start()
        assertTrue(runtime.commands.isEmpty())
    }

    @Test fun pendingPlatformDeliveryIsDiscardedAfterDestruction() {
        val runtime = Runtime()
        val adapter = NativeRealtimeAdapter(runtime)
        adapter.start()
        var posted = false
        val queuedCallback = { if (adapter.isAlive) posted = true }
        adapter.destroy()
        queuedCallback()
        assertFalse(posted)
    }

    @Test fun stopOfOldInstanceDoesNotAffectReplacement() {
        val runtime = Runtime()
        val old = NativeRealtimeAdapter(runtime)
        old.start()
        old.destroy()
        val current = NativeRealtimeAdapter(runtime)
        current.start()
        old.network(true)
        old.destroy()
        current.retry()
        assertEquals(2L, runtime.active.get())
        assertEquals("retry" to 2L, runtime.commands.last())
        current.destroy()
    }

    @Test fun destroyDuringNativeStartStopsOnlyTheReturnedOldLeaseWithoutHoldingLock() {
        val runtime = Runtime()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val finished = CountDownLatch(1)
        runtime.startHook = { lease ->
            if (lease == 1L) {
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS))
            }
        }
        val old = NativeRealtimeAdapter(runtime)
        val thread = Thread { try { old.start() } finally { finished.countDown() } }
        thread.start()
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            old.destroy() // Must not wait for native start/IO while holding the adapter lock.
            val current = NativeRealtimeAdapter(runtime)
            current.start()
            release.countDown()
            assertTrue(finished.await(5, TimeUnit.SECONDS))
            assertEquals(2L, runtime.active.get())
            assertTrue(runtime.commands.contains("stop" to 1L))
            current.destroy()
        } finally {
            release.countDown()
            thread.join(5_000)
        }
    }
}
