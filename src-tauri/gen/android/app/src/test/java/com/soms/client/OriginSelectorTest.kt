package com.soms.client

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody

class OriginSelectorTest {

    @Test
    fun first_healthy_probe_returns_immediately_and_cancels_loser() {
        val loserCancelled = CountDownLatch(1)
        val slow = FakeProbe("primary", executeBlock = {
            loserCancelled.await(5, TimeUnit.SECONDS)
            false
        }, cancelBlock = { loserCancelled.countDown() })
        val fast = FakeProbe("secondary", executeBlock = { true })

        val started = System.nanoTime()
        assertEquals("secondary", OriginSelector.race(listOf(slow, fast)))
        val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)

        assertTrue("winner must not wait for the five-second slow probe", elapsedMs < 3_000)
        assertTrue(slow.cancelled.get())
    }

    @Test
    fun first_failure_waits_for_other_already_running_probe() {
        val releaseWinner = CountDownLatch(1)
        val failed = FakeProbe("primary", executeBlock = {
            releaseWinner.countDown()
            false
        })
        val healthy = FakeProbe("secondary", executeBlock = {
            releaseWinner.await(1, TimeUnit.SECONDS)
            true
        })

        assertEquals("secondary", OriginSelector.race(listOf(failed, healthy)))
    }

    @Test
    fun both_failed_returns_null() {
        assertNull(
            OriginSelector.race(
                listOf(
                    FakeProbe("primary", executeBlock = { false }),
                    FakeProbe("secondary", executeBlock = { false }),
                ),
            ),
        )
    }

    @Test
    fun client_compat_probe_rejects_an_unrelated_http_200() {
        fun response(json: String) = Response.Builder()
            .request(Request.Builder().url("http://localhost/api/v1/client/compat").build())
            .protocol(Protocol.HTTP_1_1)
            .code(200)
            .message("OK")
            .body(json.toResponseBody())
            .build()

        response("""{"code":0,"data":{"apiVersion":1}}""").use {
            assertTrue(OriginSelector.acceptsCompat(it))
        }
        response("""{"code":0,"data":{}}""").use {
            assertFalse(OriginSelector.acceptsCompat(it))
        }
        response("""{"code":0,"data":{"apiVersion":"1"}}""").use {
            assertFalse(OriginSelector.acceptsCompat(it))
        }
        response("""{"status":"ok"}""").use {
            assertFalse(OriginSelector.acceptsCompat(it))
        }
    }

    private class FakeProbe(
        override val origin: String,
        private val executeBlock: () -> Boolean,
        private val cancelBlock: () -> Unit = {},
    ) : OriginSelector.Probe {
        val cancelled = AtomicBoolean(false)

        override fun execute(): Boolean = executeBlock()

        override fun cancel() {
            cancelled.set(true)
            cancelBlock()
        }
    }
}
