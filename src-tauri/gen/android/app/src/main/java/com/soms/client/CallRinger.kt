package com.soms.client

import android.content.Context
import android.media.AudioManager
import android.os.Build
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator

/**
 * The incoming-call HAPTICS + audio-mode wrapper: a repeating call-pattern vibration + a partial wake lock
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

    @Volatile private var vibrator: Vibrator? = null
    @Volatile private var wakeLock: PowerManager.WakeLock? = null

    /** Start the haptics: a repeating call-pattern vibration + a partial wake lock, + MODE_RINGTONE for the
     *  channel ringtone's routing. Safe to call when already ringing (the prior vibrator is cancelled +
     *  replaced). The audible ring is the channel sound (CallService.startIncomingForeground). */
    fun startRing() {
        SomsLog.i(TAG) { "startRing appInFg=${SomsMessagingService.appInForeground}" }
        val ctx = contextProvider() ?: return
        val am = (ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager)
        am.mode = AudioManager.MODE_RINGTONE
        vibrator = (ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator).also { v ->
            val pattern = longArrayOf(0, 1000, 1000) // on-off call pattern, repeating from index 0
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) v.vibrate(VibrationEffect.createWaveform(pattern, 0))
            else @Suppress("DEPRECATION") v.vibrate(pattern, 0)
        }
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "soms:ring").also { it.acquire() }
    }

    /** Stop the vibration, release the wake lock, restore MODE_NORMAL. Safe when not ringing. */
    fun stopRing() {
        SomsLog.i(TAG) { "stopRing" }
        vibrator?.runCatching { cancel() }; vibrator = null
        wakeLock?.takeIf { it.isHeld }?.runCatching { release() }; wakeLock = null
        contextProvider()?.let {
            (it.getSystemService(Context.AUDIO_SERVICE) as AudioManager).mode = AudioManager.MODE_NORMAL
        }
    }

    private companion object {
        private const val TAG = "SomsCall"
    }
}
