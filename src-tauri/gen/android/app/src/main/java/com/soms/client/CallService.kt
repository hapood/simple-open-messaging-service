package com.soms.client

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * The active-call foreground service. Anchors the process for a call's duration (so the system keeps the
 * RTCPeerConnection + the DTLS-SRTP audio leg alive while the user backgrounds into PiP / another app) and
 * owns the call's audio routing ([AudioManager.MODE_IN_COMMUNICATION]) + a PARTIAL_WAKE_LOCK + the
 * ongoing-call notification.
 *
 * **phoneCall type** (NOT dataSync — [RealtimeService] uses dataSync, which Android 15 bounds at ~6h; a call
 * must not be killed by that budget). The WebRTC state + the lifecycle FSM live in the process-global
 * [CallController]; this service is the lifecycle/audio/anchor wrapper. Started by the JS bridge (via
 * SomsCallInterface → startService) when a call begins (incoming or outgoing); torn down via [end] →
 * [stopSelf] when the call ends.
 *
 * Phase 2: a simple ongoing notification. A full-screen [android.app.Notification.CallStyle] notification +
 * Telecom/ConnectionService integration for the SYSTEM call screen land in Phase 6 (incoming-call wake-up);
 * the peer name/avatar fill-in lands with it (the notification currently shows a generic label).
 */
class CallService : Service() {

    private var audioManager: AudioManager? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var focusRequest: AudioFocusRequest? = null

    /** Bound-mode is unused (a started service); satisfy the abstract base. */
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Promote to foreground at once: the phoneCall type + the ongoing notification ARE the process
        // anchor (a call must survive a backgrounding into PiP / another app). Audio routing + the wake
        // lock are acquired here too — they bound the call, released in [onDestroy].
        startCallForeground()
        acquireAudio()
        // A system-killed call service does NOT auto-resume (no active-call recovery yet — §5 HELLO
        // recovery is deferred). The client re-derives state from the live call on return only while the
        // process lives; a process-kill ends the call (the server's ringing timeout / the peer's /calls/end
        // backstop it).
        return START_NOT_STICKY
    }

    /** Promote to a phoneCall foreground service with the ongoing-call notification. The typed startForeground
     *  (3-arg, FOREGROUND_SERVICE_TYPE_PHONE_CALL) is required on Android 14+; older versions use the 2-arg
     *  overload (the 3-arg overload itself is API 29+, and on <14 the manifest-declared type suffices).
     *  Mirrors [RealtimeService.startForegroundCompat]. */
    private fun startCallForeground() {
        val notif = buildCallNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun buildCallNotification(): android.app.Notification {
        ensureChannel()
        return NotificationCompat.Builder(this, CHANNEL_ID)
            // The app launcher icon — guaranteed to exist (manifest android:icon). A dedicated white
            // silhouette small-icon is a Phase 6 polish; this compiles + renders for now.
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("SOMS")
            .setContentText("Call in progress")
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    /** Switch to comms audio routing (earpiece), acquire transient voice-communication focus, and hold a
     *  partial wake lock so the CPU (the media leg) isn't suspended when the screen turns off. All released
     *  in [onDestroy]. Idempotent (re-acquire on a re-delivered start is harmless — focus/wake are
     *  replace-by-token). */
    private fun acquireAudio() {
        val am = audioManager
            ?: (getSystemService(Context.AUDIO_SERVICE) as AudioManager).also { audioManager = it }
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val attrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
            val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(attrs)
                .build()
            focusRequest = req
            am.requestAudioFocus(req)
        } else {
            @Suppress("DEPRECATION")
            am.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        }
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        val wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "soms:call").also { wakeLock = it }
        wl.acquire()
    }

    private fun releaseAudio() {
        val am = audioManager ?: return
        focusRequest?.let { am.abandonAudioFocusRequest(it) }
        focusRequest = null
        am.mode = AudioManager.MODE_NORMAL
        wakeLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
    }

    /** The call ended — release the audio/wake, tell the controller to dispose the PC, and stop the service.
     *  Called by [CallController] (via the bridge) on a terminal transition, OR by the system's
     *  onTimeout/onTaskRemoved. */
    fun end() {
        stopSelf()
    }

    override fun onDestroy() {
        releaseAudio()
        CallController.destroy()
        super.onDestroy()
    }

    /** Lazily create the dedicated "Calls" channel (IMPORTANCE_LOW — the ongoing call is not a loud alert;
     *  the incoming RING is a separate high-priority push, Phase 6). Idempotent. */
    private fun ensureChannel() {
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
            val ch = NotificationChannel(CHANNEL_ID, "Calls", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Active call"
            }
            mgr.createNotificationChannel(ch)
        }
    }

    companion object {
        /** Stable notification id for the active-call notification (distinct from RealtimeService's 0x6). */
        private const val NOTIF_ID = 0x7
        private const val CHANNEL_ID = "soms_calls"
    }
}
