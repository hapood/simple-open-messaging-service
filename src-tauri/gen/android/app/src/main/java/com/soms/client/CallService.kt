package com.soms.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.IconCompat

/**
 * The active-call foreground service. Anchors the process for a call's duration (so the system keeps the
 * RTCPeerConnection + the DTLS-SRTP audio leg alive while the user backgrounds into PiP / another app) and
 * owns the active call's audio routing ([AudioManager.MODE_IN_COMMUNICATION]) + a PARTIAL_WAKE_LOCK + the
 * foreground notification.
 *
 * **phoneCall type** (NOT dataSync — [RealtimeService] uses dataSync, which Android 15 bounds at ~6h; a call
 * must not be killed by that budget). The WebRTC state + the lifecycle FSM live in the process-global
 * [CallController]; this service is the lifecycle/audio/anchor wrapper.
 *
 * Two start modes:
 *  - **[ACTION_INCOMING]** (Phase 6 wake-up): started by [SomsMessagingService] from a high-priority
 *    CALL_INCOMING FCM push. The high-priority grant is the exemption that lets a backgrounded/killed app
 *    start a phoneCall FGS. Seeds CallController into the incoming phase + rings + posts the incoming-ring
 *    notification (MAX priority, CATEGORY_CALL, full-screen intent, Answer/Decline) — the phone rings even
 *    from a killed process. Comms audio is NOT acquired here (the ring uses MODE_RINGTONE, set by
 *    CallController.startRing); [onAccepted] switches to it.
 *  - **default** (outgoing, or a re-delivered start): anchor + acquire comms audio at once.
 *
 * The peer name for the incoming notification rides the FCM push (a cold-started callee has no live SSE for
 * CALL_EVENT{incoming}). [instance] lets CallController reach [onAccepted] on the accept transition.
 */
class CallService : Service() {

    private var audioManager: AudioManager? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var focusRequest: AudioFocusRequest? = null
    /** The incoming caller's display name + type, captured at ACTION_INCOMING for the ringing notification. */
    @Volatile private var incomingCallerName: String = ""
    @Volatile private var incomingCallerAvatar: String = ""
    @Volatile private var incomingCallType: String = "AUDIO"
    /** The peer's avatar bitmap, fetched async ([loadAvatar]) for the notification Person icon. Null until
     *  loaded — the first notification is name-only; [refreshNotification] re-posts once the icon is in. */
    @Volatile private var avatarBitmap: Bitmap? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    /** Bound-mode is unused (a started service); satisfy the abstract base. */
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_INCOMING) {
            val sid = intent.getStringExtra(EXTRA_SID)
            if (sid.isNullOrEmpty()) { stopSelf(); return START_NOT_STICKY }
            incomingCallerName = intent.getStringExtra(EXTRA_CALLER_NAME) ?: ""
            incomingCallerAvatar = intent.getStringExtra(EXTRA_CALLER_AVATAR) ?: ""
            incomingCallType = intent.getStringExtra(EXTRA_CALL_TYPE) ?: "AUDIO"
            // Promote to foreground FIRST (the phoneCall FGS must be foreground within ~5s of
            // startForegroundService, else the system kills it + the high-priority FCM exemption is forfeit).
            // The incoming-ring notification (MAX, full-screen intent, Answer/Decline) IS the foreground
            // notification. Comms audio is deferred to [onAccepted] (the ring needs MODE_RINGTONE, which
            // CallController.startRing sets — acquiring MODE_IN_COMMUNICATION here would mis-route the ring).
            startIncomingForeground(sid)
            CallController.seedIncoming(
                sid,
                intent.getIntExtra(EXTRA_CALLER_UID, 0),
                incomingCallerName,
                incomingCallerAvatar,
                intent.getIntExtra(EXTRA_THREAD_ID, 0),
                incomingCallType,
            )
            loadAvatar(incomingCallerAvatar)
        } else {
            // Outgoing / re-delivered start: anchor + comms audio (the call is negotiating/active).
            startCallForeground()
            acquireAudio()
            loadAvatar(CallController.peerAvatar)
        }
        // A system-killed call service does NOT auto-resume (no active-call recovery yet). The client re-
        // derives state from the live call only while the process lives; a process-kill ends the call (the
        // server's ringing timeout / the peer's /calls/end backstop it).
        return START_NOT_STICKY
    }

    /** Called by [CallController.accept]: the callee answered — switch to comms audio + flip the notification
     *  from the ringing card to the ongoing "call in progress" one (which also dismisses the full-screen
     *  incoming surface). The ring itself was already stopped in accept. */
    fun onAccepted() {
        acquireAudio()
        startCallForeground()
    }

    /** Promote to a phoneCall foreground service with the ONGOING-call notification (the active call). The
     *  typed startForeground (3-arg, FOREGROUND_SERVICE_TYPE_PHONE_CALL) is required on Android 14+; older
     *  versions use the 2-arg overload. Mirrors [RealtimeService.startForegroundCompat]. */
    private fun startCallForeground() {
        val notif = buildOngoingNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    /** Promote to foreground with the INCOMING-ring notification (the FGS foreground surface while ringing). */
    private fun startIncomingForeground(sid: String) {
        val notif = buildIncomingNotification(sid)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    /** The ongoing-call notification. NotificationCompat.CallStyle renders the system's native ongoing-call
     *  template on API 31+ (a proper "in call" surface) and degrades to a standard ongoing notification on
     *  older versions. The peer's name (CallController.peerName) is the displayed Person. No hang-up button
     *  on the notification itself (the user hangs up via the in-app CallScreen / PiP) → hangUpIntent = null. */
    private fun buildOngoingNotification(): Notification {
        ensureChannels()
        val person = Person.Builder()
            .setName(CallController.peerName.ifEmpty { getString(R.string.app_name) })
            .apply { avatarBitmap?.let { setIcon(IconCompat.createWithBitmap(it)) } }
            .build()
        // Hang-up button on the ongoing notification (the AndroidX CallStyle requires a non-null hangUpIntent).
        // Routes to SomsActionReceiver → CallController.end. CallController.callSid is set by the time the
        // ongoing notification is posted (the call is live); the empty-string guard is in the receiver.
        val hangUpIntent = Intent(this, SomsActionReceiver::class.java).apply {
            putExtra(SomsActionReceiver.EXTRA_CALL_END, CallController.callSid ?: "")
        }
        val hangUpPi = PendingIntent.getBroadcast(
            this, REQ_HANGUP, hangUpIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ONGOING)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(person, hangUpPi))
            .build()
    }

    /** The incoming-ring notification: MAX priority + CATEGORY_CALL + a full-screen intent (launches the app
     *  to the incoming UI, or the system call screen on a locked device) + Answer (→ MainActivity) / Decline
     *  (→ SomsActionReceiver) actions. The audible ring is the device ringtone (CallController.startRing, on
     *  the ring stream); this channel carries NO sound (avoids a double ding) — its job is the full-screen
     *  surface + the action buttons. */
    private fun buildIncomingNotification(sid: String): Notification {
        ensureChannels()
        val answerIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            action = ACTION_ANSWER
            putExtra(EXTRA_SID, sid)
        }
        val answerPi = PendingIntent.getActivity(
            this, REQ_ANSWER, answerIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val declineIntent = Intent(this, SomsActionReceiver::class.java).apply {
            putExtra(SomsActionReceiver.EXTRA_CALL_DECLINE, sid)
        }
        val declinePi = PendingIntent.getBroadcast(
            this, REQ_DECLINE, declineIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val caller = Person.Builder()
            .setName(incomingCallerName.ifEmpty { getString(R.string.app_name) })
            .apply { avatarBitmap?.let { setIcon(IconCompat.createWithBitmap(it)) } }
            .build()
        return NotificationCompat.Builder(this, CHANNEL_INCOMING)
            .setSmallIcon(R.mipmap.ic_launcher)
            // forIncomingCall(person, declineIntent, answerIntent) — decline FIRST (the framework signature;
            // a swap would put the labels on the wrong buttons since both args are PendingIntent). CallStyle
            // sets the Answer/Decline actions, the caller display, + the full-screen promotion on API 31+.
            // setCategory + setFullScreenIntent cover the API < 31 degrade (standard-notification path) +
            // ensure CATEGORY_CALL for the full-screen auto-grant on API 34+.
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, declinePi, answerPi))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setFullScreenIntent(answerPi, true)
            .build()
    }

    /** Switch to comms audio routing (earpiece), acquire transient voice-communication focus, and hold a
     *  partial wake lock so the CPU (the media leg) isn't suspended when the screen turns off. All released
     *  in [onDestroy]. Idempotent (re-acquire on a re-delivered start / on accept is harmless — focus/wake
     *  are replace-by-token). */
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

    /** The call ended — release the audio/wake, tell the controller to dispose the PC, and stop the service. */
    fun end() {
        stopSelf()
    }

    override fun onDestroy() {
        // Clear the instance FIRST so CallController.onAccepted can't reach a destroying service.
        instance = null
        releaseAudio()
        CallController.destroy()
        super.onDestroy()
    }

    /** Lazily create the "Calls" channels: ONGOING (LOW — an active call is not a loud alert) + INCOMING
     *  (HIGH — the heads-up / full-screen ring surface; NO sound — the audible ring is the device ringtone
     *  played by CallController.startRing, so a channel sound would double up). Idempotent. */
    /** Fetch the peer's avatar (async) for the notification Person icon. Cached in [avatarBitmap]; the
     *  notification builders use it if loaded (else name-only). On load, [refreshNotification] re-posts the
     *  current notification so the icon appears. Reuses SomsMessagingService.fetchBitmap (Bearer-fetch of a
     *  /uploads path — same path as the message-notification icon). */
    private fun loadAvatar(path: String) {
        if (path.isEmpty()) return
        Thread {
            val bmp = SomsMessagingService.fetchBitmap(this, path)
            if (bmp != null) {
                avatarBitmap = bmp
                mainHandler.post { refreshNotification() }
            }
        }.start()
    }

    /** Re-post the current notification (incoming-ring or ongoing) so the now-loaded avatar icon shows. */
    private fun refreshNotification() {
        when (CallController.phase) {
            "incoming" -> CallController.callSid?.let { startIncomingForeground(it) }
            "connecting", "connected", "reconnecting" -> startCallForeground()
            else -> {}
        }
    }

    private fun ensureChannels() {
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(CHANNEL_ONGOING) == null) {
            mgr.createNotificationChannel(
                NotificationChannel(CHANNEL_ONGOING, "Calls", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Active call"
                },
            )
        }
        if (mgr.getNotificationChannel(CHANNEL_INCOMING) == null) {
            mgr.createNotificationChannel(
                NotificationChannel(CHANNEL_INCOMING, "Incoming calls", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Incoming call ring"
                    setSound(null, null)
                    enableVibration(false)
                },
            )
        }
    }

    companion object {
        /** Stable notification id for the call (the ringing card + the ongoing card share it — one replaces
         *  the other; distinct from RealtimeService's 0x6). */
        private const val NOTIF_ID = 0x7
        private const val CHANNEL_ONGOING = "soms_calls"
        private const val CHANNEL_INCOMING = "soms_calls_incoming"

        /** Start the service in the incoming-ring mode (from the CALL_INCOMING FCM push). */
        private const val ACTION_INCOMING = "soms.action.CALL_INCOMING"
        /** A MainActivity launch with this action answers the incoming call (the notification Answer button /
         *  full-screen intent). */
        const val ACTION_ANSWER = "soms.action.CALL_ANSWER"
        /** The callSid extra shared by the service start + the notification intents (MainActivity + the
         *  decline receiver read it). Public so those callers can reference it. */
        const val EXTRA_SID = "soms_call_sid"
        private const val EXTRA_CALLER_UID = "soms_call_caller_uid"
        private const val EXTRA_CALLER_NAME = "soms_call_caller_name"
        private const val EXTRA_CALLER_AVATAR = "soms_call_caller_avatar"
        private const val EXTRA_THREAD_ID = "soms_call_thread_id"
        private const val EXTRA_CALL_TYPE = "soms_call_type"
        private const val REQ_ANSWER = 7001
        private const val REQ_DECLINE = 7002
        private const val REQ_HANGUP = 7003

        /** The live service instance, for CallController to reach [onAccepted] on the accept transition.
         *  @Volatile: written on main (onCreate/onDestroy), read on the call / JS bridge threads. */
        @Volatile var instance: CallService? = null
            private set

        /** Start the call FGS for an incoming ring (from the CALL_INCOMING FCM push). The high-priority FCM
         *  grant is the exemption that lets a backgrounded/killed app start a phoneCall FGS; the try/catch is
         *  belt-and-suspenders for a rare rejected start (the phone still won't ring, but the process won't
         *  crash). Seeds the FSM + rings inside onStartCommand (after the foreground promotion). */
        fun startIncoming(
            ctx: Context,
            sid: String,
            callerUserId: Int,
            callerName: String,
            callerAvatar: String,
            threadId: Int,
            callType: String,
        ) {
            val intent = Intent(ctx, CallService::class.java).apply {
                action = ACTION_INCOMING
                putExtra(EXTRA_SID, sid)
                putExtra(EXTRA_CALLER_UID, callerUserId)
                putExtra(EXTRA_CALLER_NAME, callerName)
                putExtra(EXTRA_CALLER_AVATAR, callerAvatar)
                putExtra(EXTRA_THREAD_ID, threadId)
                putExtra(EXTRA_CALL_TYPE, callType)
            }
            try {
                ContextCompat.startForegroundService(ctx, intent)
            } catch (e: Exception) {
                SomsLog.w("SomsCall") { "CallService.startIncoming skipped: ${e.javaClass.simpleName}: ${e.message}" }
            }
        }
    }
}
