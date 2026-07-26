package com.soms.client

/**
 * The pure (Android-free) call FSM decisions + the reconnect/answer backstop policies, extracted from
 * [CallController] so the trickiest logic — the phase-transition table + the backstop decisions (where the
 * callee-window bug once lived) — is unit-testable with no WebRTC/Android machinery.
 *
 * [CallController] owns the side-effecting transitions (the /calls REST endpoints, pushSnapshot, teardown, ICE restart);
 * this object owns ONLY the decisions. Keep it dependency-free (no `org.webrtc` / `android.*` imports) so it
 * runs under the JVM unit-test task, not just on-device.
 */
object CallFsm {

    // ── reconnect backstop timing ────────────────────────────────────────────────
    /** Caller: how long "Reconnecting…" shows before it attempts one ICE restart. GATHER_CONTINUALLY recovers
     *  most network blips inside this window. */
    const val RECONNECT_BACKSTOP_MS = 15_000L
    /** Caller: the re-arm after the first restart attempt, before it gives up. */
    const val RECONNECT_BACKSTOP_SHORT_MS = 10_000L
    /** Callee: must outlast the caller's full restart window (BACKSTOP + SHORT + a re-offer round-trip) — the
     *  callee cannot initiate a restart, so failing earlier would end a restart-recoverable blip (the callee
     *  would race the caller's restart). Almost never fires: the caller's restart reconnects the callee, or the
     *  caller's eventual fail ends the call via CALL_EVENT{ended} first. */
    const val CALLEE_BACKSTOP_MS = 30_000L
    /** Caller: how long to wait for the SSE-relayed WebRTC answer before pulling the staged copy from the server
     *  (the caller-side twin of the callee's accept-time fetch). The SSE relay is near-instant on a healthy link,
     *  so this fires only when the SSE path dropped the answer — a mid-call SSE reconnect during `connecting`. A
     *  short fallback: long enough that a healthy relay (sub-second) never trips it, short enough that a
     *  dropped-answer call still recovers well before the server's ~45s ringing/answer timeout fails it. */
    const val ANSWER_FETCH_DELAY_MS = 3_000L

    /** The reconnect backstop's initial delay for this side. The caller restarts fast; the callee waits out the
     *  caller's full restart window. */
    fun reconnectBackstopDelayMs(isCaller: Boolean): Long =
        if (isCaller) RECONNECT_BACKSTOP_MS else CALLEE_BACKSTOP_MS

    /** On a reconnect-backstop fire: restart ICE (caller, restart not yet tried, live PC) or give up. */
    fun shouldRestartOnReconnect(isCaller: Boolean, iceRestartTried: Boolean, hasPc: Boolean): Boolean =
        isCaller && !iceRestartTried && hasPc

    // ── phase-transition table ───────────────────────────────────────────────────
    /** The next phase for a CALL_EVENT lifecycle type, or null if the event does not transition THIS side
     *  (a stale frame, or an event that belongs to the other side). Covers the symmetric lifecycle events;
     *  `incoming` is NOT here — it seeds the whole snapshot on the callee (a side-effecting transition, not a
     *  simple phase flip), so it stays inline in [CallController.handleEventFrame]. */
    fun nextPhase(current: String, isCaller: Boolean, eventType: String): String? = when (eventType) {
        "ringing" -> if (isCaller && current == "calling") "ringing" else null
        "accepted" -> if (isCaller && (current == "calling" || current == "ringing")) "connecting" else null
        "connected" -> if (current != "connected" && current != "idle" && current != "ended") "connected" else null
        "declined", "cancelled", "missed", "ended" -> if (current != "idle" && current != "ended") "ended" else null
        else -> null
    }
}
