package com.soms.client

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Android's single origin-selection authority. Login initialization and the native SSE service both use
 * this implementation, so they cannot drift into different race semantics.
 *
 * Both configured origins are probed concurrently. The first healthy response wins immediately and the
 * losing OkHttp call is cancelled. If the first completed probe failed, only the already-running other
 * probe is awaited. The winner is persisted before it is returned so every native background transport
 * follows the same endpoint.
 */
object OriginSelector {
    private const val COMPAT_PROBE_TIMEOUT_S = 3L

    private val client = OkHttpClient.Builder()
        .connectTimeout(COMPAT_PROBE_TIMEOUT_S, TimeUnit.SECONDS)
        .readTimeout(COMPAT_PROBE_TIMEOUT_S, TimeUnit.SECONDS)
        .build()

    fun select(ctx: Context): String? {
        val primary = SomsSecureStore.getApiOrigin(ctx) ?: return null
        val secondary = SomsSecureStore.getApiOriginSecondary(ctx)
        if (secondary == null) {
            return primary.takeIf { probe(it) }
        }

        val winner = race(
            listOf(
                OkHttpProbe(primary, compatCall(primary)),
                OkHttpProbe(secondary, compatCall(secondary)),
            ),
        ) ?: return null
        val mode = if (winner.trimEnd('/') == secondary.trimEnd('/')) "secondary" else "primary"
        SomsSecureStore.setOriginMode(ctx, mode)
        SomsLog.i("Origin") { "winner=$winner mode=$mode" }
        return winner
    }

    private fun probe(origin: String): Boolean {
        return try {
            compatCall(origin).execute().use(::acceptsCompat)
        } catch (e: Exception) {
            SomsLog.d("Origin") { "probe $origin → ${e.javaClass.simpleName}: ${e.message}" }
            false
        }
    }

    internal fun acceptsCompat(response: okhttp3.Response): Boolean {
        if (!response.isSuccessful) return false
        val result = org.json.JSONObject(response.body?.string() ?: return false)
        val apiVersion = result.optJSONObject("data")?.opt("apiVersion")
        return result.optInt("code", -1) == 0 &&
            apiVersion is Number && apiVersion.toLong() >= 0
    }

    private fun compatCall(origin: String): okhttp3.Call {
        val request = Request.Builder()
            .url("${origin.trimEnd('/')}${SomsSecureStore.API_PREFIX}/client/compat")
            .get()
            .cacheControl(okhttp3.CacheControl.FORCE_NETWORK)
            .build()
        return client.newCall(request)
    }

    /** Pure race coordinator kept internal so JVM tests pin the cancellation/early-return contract. */
    internal fun race(probes: List<Probe>): String? {
        val executor = Executors.newFixedThreadPool(probes.size)
        val completion = ExecutorCompletionService<Result>(executor)
        try {
            probes.forEach { probe ->
                completion.submit { Result(probe.origin, probe.execute()) }
            }
            repeat(probes.size) {
                val result = completion.take().get()
                if (result.healthy) return result.origin
            }
            return null
        } finally {
            probes.forEach(Probe::cancel)
            executor.shutdownNow()
        }
    }

    internal interface Probe {
        val origin: String
        fun execute(): Boolean
        fun cancel()
    }

    private class OkHttpProbe(
        override val origin: String,
        private val call: okhttp3.Call,
    ) : Probe {
        override fun execute(): Boolean {
            return try {
                call.execute().use(::acceptsCompat)
            } catch (e: Exception) {
                SomsLog.d("Origin") {
                    "probe $origin → ${e.javaClass.simpleName}: ${e.message}"
                }
                false
            }
        }

        override fun cancel() = call.cancel()
    }

    private data class Result(val origin: String, val healthy: Boolean)
}
