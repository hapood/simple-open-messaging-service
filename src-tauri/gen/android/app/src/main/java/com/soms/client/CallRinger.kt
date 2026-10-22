package com.soms.client

import android.content.Context
import android.media.AudioManager
import android.os.PowerManager

/**
 * The incoming-call audio-mode + wake wrapper. The notification channel owns ringtone and vibration so both
 * follow the user's system sound, vibration, notification-channel, and Do Not Disturb settings.
 * for the ring's duration, + [AudioManager.MODE_RINGTONE] so the channel's ringtone sound routes correctly.
 *
 * The AUDIBLE ringtone is NOT here — it's the [CallService.CHANNEL_INCOMING] sound (the system plays it when
 * the call notification posts, which is also what pops the heads-up banner on OEMs like Huawei EMUI). A
 * MediaPlayer looping the ringtone here would double the channel sound, so this owns only the vibration +
 * the wake lock + the audio mode. [startRing]/[stopRing] are idempotent.
 *
 * Extracted from [CallController] (the call FSM) so the FSM owns the transition + this owns the haptic
 * mechanics. The context is provided lazily ([contextProvider]) because the FSM outlives any one Activity —
 * it reads [SomsApplication.appContext], set before any component.
 */
class CallRinger(private val contextProvider: () -> Context?) {

    @Volatile private var wakeLock: PowerManager.WakeLock? = null

    /** Prepare ringtone routing and keep the process awake while the system notification channel rings. */
    @Synchronized
    fun startRing() {
        if (wakeLock?.isHeld == true) return
        SomsLog.i(TAG) { "startRing appInFg=${SomsMessagingService.appInForeground}" }
        val ctx = contextProvider() ?: return
        val am = (ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager)
        am.mode = AudioManager.MODE_RINGTONE
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        // A duplicate SSE/FCM ring must not replace an acquired lock, and a missed end event must not
        // leave the CPU awake indefinitely. The server's incoming-call timeout is shorter than this cap.
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "soms:ring").also { it.acquire(60_000L) }
    }

    /** Release the wake lock and restore MODE_NORMAL. Safe when not ringing. */
    @Synchronized
    fun stopRing() {
        SomsLog.i(TAG) { "stopRing" }
        wakeLock?.takeIf { it.isHeld }?.runCatching { release() }; wakeLock = null
        contextProvider()?.let {
            (it.getSystemService(Context.AUDIO_SERVICE) as AudioManager).mode = AudioManager.MODE_NORMAL
        }
    }

    private companion object {
        private const val TAG = "SomsCall"
    }
}
