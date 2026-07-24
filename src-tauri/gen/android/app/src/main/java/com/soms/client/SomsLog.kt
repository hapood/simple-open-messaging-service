package com.soms.client

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Debug-gated logcat shim + a rotating `native.log` file sink. Every call site compiles out at runtime in
 * release: each method is `inline`, so the lambda body is inlined into the caller and the
 * `if (BuildConfig.DEBUG)` guard skips BOTH the `Log.*` call AND the `msg()` string-build (the lambda only
 * runs inside the guard). Use for diagnostic/telemetry logs that must never fire in shipped builds; the
 * always-on `Log.i/Log.w` calls already in [RealtimeService] stay as-is (those are the headless service's
 * by-design surface).
 *
 * One tag prefix so the whole app's diagnostics stream under one filter — every line's tag is `Soms/<sub>`
 * (e.g. `Soms/Rt`, `Soms/SomsCall`, `Soms/Ui`), so `adb logcat | grep 'Soms/'` shows them all. Note logcat's
 * `-s` matches the FULL tag string (no wildcard), so `-s Soms:V` does NOT catch `Soms/Rt` — grep the prefix.
 * The per-call `sub` arg marks the subsystem (`Rt` realtime / `Notif` notification rendering / `Ui` activity
 * lifecycle), so a line reads `Soms/Rt: …`, `Soms/Notif: …`. Keep `sub` short.
 *
 * Decision-critical lines use [i] (survives even where an OEM ROM suppresses `Log.d`); the chatty ~25s
 * liveness `ping` uses [d].
 *
 * The file sink writes `filesDir/soms-native.log` (rotated to `.1` past 2 MiB) in the SAME format the JS
 * ring buffer uses (`${ISO_UTC} [${level}] [${sub}] ${msg}`), so the debug log panel can interleave the
 * Kotlin timeline with the JS one by timestamp. DEBUG builds only — release has no native.log, so the
 * diagnostic bundle's `native/kotlin.log` entry is absent there by design (the layer is reachable later by
 * relaxing this gate, with no bundle-path change).
 *
 * Why inline + lazy lambda rather than a plain `if (BuildConfig.DEBUG) Log.d(...)` at each site: it removes
 * the boilerplate guard from every call site AND guarantees the interpolated string is never built when DEBUG
 * is false (the lambda isn't invoked), so a debug log with an expensive `.map { }` is free in release. The
 * tag string is inlined as a literal (NOT a `private const`) because a `public inline fun` cannot reference a
 * private member — it would be inlined out of this object. [append] is `@PublishedApi internal` (not plain
 * `internal`, and not `private`) because a public inline function cannot reference an `internal` member
 * either — it could be inlined into another module where `internal` isn't visible. `@PublishedApi` publishes
 * the member for inlining while keeping it `internal` at the source level.
 */
object SomsLog {
    /** Active-log size cap before rotation (active → .1; the prior .1 is dropped). Mirrors the Rust side's
     *  size-bounded rotation so a long debug session can't grow it without limit. */
    private const val MAX_BYTES = 2L * 1024 * 1024
    private const val ACTIVE = "soms-native.log"
    private const val ROTATED = "soms-native.log.1"

    private val iso =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }

    @Volatile private var appContext: Context? = null

    /** Stash the application context so the file sink can resolve `filesDir`. Call once from
     *  [MainActivity.onCreate] before any SomsLog call. No-op in release (every method compiles out, so the
     *  context would never be read). */
    fun init(ctx: Context) {
        if (!BuildConfig.DEBUG) return
        appContext = ctx.applicationContext
    }

    inline fun d(sub: String, msg: () -> String) {
        if (BuildConfig.DEBUG) {
            val m = msg()
            Log.d("Soms/$sub", m)
            append("debug", sub, m)
        }
    }

    inline fun i(sub: String, msg: () -> String) {
        if (BuildConfig.DEBUG) {
            val m = msg()
            Log.i("Soms/$sub", m)
            append("info", sub, m)
        }
    }

    inline fun w(sub: String, t: Throwable? = null, msg: () -> String) {
        if (BuildConfig.DEBUG) {
            val m = msg()
            if (t != null) Log.w("Soms/$sub", m, t) else Log.w("Soms/$sub", m)
            val withCause = if (t != null) "$m ${t.javaClass.simpleName}: ${t.message}" else m
            append("warn", sub, withCause)
        }
    }

    /** Append one line to the rotating native log (DEBUG only). `@Synchronized` so concurrent writers
     *  ([RealtimeService] runs off-main) don't interleave or race the rotation. Best-effort: any IO failure
     *  is swallowed — logging must never crash a call site.
     *
     *  `@PublishedApi` is REQUIRED because the public inline `d`/`i`/`w` call this: a public inline function
     *  cannot reference a plain `internal` member (it could be inlined into another module where `internal`
     *  isn't visible). `@PublishedApi` keeps the member `internal` at the source level while publishing it
     *  for inlining — so it stays out of the intended public surface but is reachable from the inline sites. */
    @PublishedApi
    @Synchronized
    internal fun append(level: String, sub: String, msg: String) {
        val ctx = appContext ?: return
        try {
            val active = File(ctx.filesDir, ACTIVE)
            if (active.exists() && active.length() > MAX_BYTES) {
                val rotated = File(ctx.filesDir, ROTATED)
                rotated.delete()
                active.renameTo(rotated)
            }
            val ts = iso.format(Date())
            // Collapse newlines so one record = one line (the debug panel's parser + logcat both assume it).
            val single = msg.replace('\n', ' ').replace('\r', ' ')
            active.appendText("$ts [$level] [$sub] $single\n")
        } catch (e: Exception) {
            // Swallow — the file sink is best-effort; logcat already has the line.
        }
    }
}
