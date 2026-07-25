package com.soms.client

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator

/**
 * The incoming-call ring: the device ringtone (LOOPING, on the ring stream) + a repeating vibration + a
 * partial wake lock for the ring's duration. Extracted from [CallController] (the call FSM) so the FSM owns
 * the transition + this owns the audio/haptic mechanics. [startRing]/[stopRing] are idempotent.
 *
 * **MediaPlayer, not [android.media.Ringtone]** — a call ring must LOOP until answered, and `Ringtone` has no
 * looping API (it plays once). The MediaPlayer is created with [AudioAttributes.USAGE_NOTIFICATION_RINGTONE]
 * so it respects the ringer volume + Do-Not-Disturb (a call ring is not a notification ding).
 *
 * The context is provided lazily ([contextProvider]) because the FSM outlives any one Activity — it reads
 * [SomsApplication.appContext], set before any component.
 */
class CallRinger(private val contextProvider: () -> Context?) {

    @Volatile private var player: MediaPlayer? = null
    @Volatile private var vibrator: Vibrator? = null
    @Volatile private var wakeLock: PowerManager.WakeLock? = null

    /** Start the ring: ring-stream ringtone (looping) + a repeating vibration + a partial wake lock. Safe to
     *  call when already ringing (the prior player is released + replaced). MODE_RINGTONE so the ring stream
     *  plays correctly (not the voice-comm routing an accepted call uses). */
    fun startRing() {
        val ctx = contextProvider() ?: return
        val am = (ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager)
        am.mode = AudioManager.MODE_RINGTONE
        val uri = RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_RINGTONE)
        player?.runCatching { release() }
        player = uri?.let { u ->
            MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                // prepare() is synchronous (a ringtone is short); set isLooping + start. A bad/missing URI
                // logs + leaves a silent ring (the vibration still alerts).
                runCatching { setDataSource(ctx, u); isLooping = true; prepare(); start() }
                    .onFailure { SomsLog.w(TAG) { "ringtone prepare/start failed: ${it.message}" } }
            }
        }
        vibrator = (ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator).also { v ->
            val pattern = longArrayOf(0, 1000, 1000) // on-off call pattern, repeating from index 0
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) v.vibrate(VibrationEffect.createWaveform(pattern, 0))
            else @Suppress("DEPRECATION") v.vibrate(pattern, 0)
        }
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "soms:ring").also { it.acquire() }
    }

    /** Stop the ringtone + vibration, release the wake lock, restore MODE_NORMAL. Safe when not ringing. */
    fun stopRing() {
        player?.runCatching { release() }; player = null
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
