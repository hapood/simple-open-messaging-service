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
import android.graphics.Color
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioDeviceInfo
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Base64
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
 *    from a killed process. Comms audio is NOT acquired here (CallRinger sets MODE_RINGTONE for the
 *    notification channel sound); [onAccepted] switches to it.
 *  - **default** (outgoing, or a re-delivered start): anchor + acquire comms audio at once.
 *
 * The peer name for the incoming notification rides the FCM push (a cold-started callee has no live SSE for
 * CALL_EVENT{incoming}). [instance] lets CallController reach [onAccepted] on the accept transition.
 */
class CallService : Service() {

    private var audioManager: AudioManager? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var focusRequest: AudioFocusRequest? = null
    /** Incoming presentation resolved from native SQLite before the ringing notification is posted. */
    @Volatile private var incomingCallerName: String = ""
    @Volatile private var incomingCallType: String = "AUDIO"
    /** The peer's avatar bitmap for the notification Person icon. */
    @Volatile private var avatarBitmap: Bitmap? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var notificationSession: NotificationSessionBinding? = null
    private var notificationCallSid: String? = null
    @Volatile private var destroyed = false

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    fun currentNotificationSession(): NotificationSessionBinding? =
        if (destroyed) null else notificationSession?.takeIf { it.isCurrent(this) }

    /** Bound-mode is unused (a started service); satisfy the abstract base. */
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val requestedSession = NotificationSessionBinding.fromIntent(intent)
        if (requestedSession == null || !requestedSession.isCurrent(this)) {
            if (notificationSession?.isCurrent(this) != true) stopSelf(startId)
            return START_NOT_STICKY
        }
        val owner = notificationSession
        if (owner != null && owner != requestedSession) {
            // Do not reparent an existing call's notification to a newly logged-in session.
            if (!owner.isCurrent(this)) stopSelf(startId)
            return START_NOT_STICKY
        }
        notificationSession = requestedSession
        notificationCallSid = intent?.getStringExtra(EXTRA_SID)?.takeIf { it.isNotEmpty() }
        val isIncoming = intent?.action == ACTION_INCOMING
        val sid = if (isIncoming) intent?.getStringExtra(EXTRA_SID) else null
        val callerAccount = intent?.getStringExtra(EXTRA_CALLER_ACCOUNT) ?: ""
        val callerNamespaceId = intent?.getIntExtra(EXTRA_CALLER_NAMESPACE_ID, -1) ?: -1
        val incomingThreadId = intent?.getIntExtra(EXTRA_THREAD_ID, 0) ?: 0
        // Promote before decoding an avatar: a cold FCM start has only a short deadline to call
        // startForeground. The initial incoming card has a placeholder caller; it is updated under the
        // same notification ID once the passed-in presentation facts are decoded.
        try {
            if (isIncoming && !sid.isNullOrEmpty()) {
                incomingCallerName = ""
                avatarBitmap = null
                incomingCallType = intent?.getStringExtra(EXTRA_CALL_TYPE) ?: "AUDIO"
                startIncomingForeground(sid)
            } else {
                startCallForeground()
            }
        } catch (e: Exception) {
            SomsLog.w("SomsCall") { "startForeground threw: ${e.javaClass.simpleName}: ${e.message} → minimal fallback notif" }
            try {
                startForeground(NOTIF_ID, NotificationCompat.Builder(this, CHANNEL_ONGOING)
                    .setSmallIcon(R.mipmap.ic_launcher).build())
            } catch (_: Exception) { /* nothing more we can do */ }
        }
        if (isIncoming && !sid.isNullOrEmpty()) {
            // The trigger (SSE / HELLO / FCM) resolved the caller presentation from native SQLite and
            // passed the facts inline; this service only renders them (with its own terminal fallbacks)
            // and never re-resolves identity itself.
            incomingCallerName = intent?.getStringExtra(EXTRA_CALLER_NAME)?.takeIf { it.isNotEmpty() } ?: callerAccount
            val avatarDataUrl = intent?.getStringExtra(EXTRA_CALLER_AVATAR)?.takeIf { it.isNotEmpty() }
            avatarBitmap = runCatching {
                avatarDataUrl?.let { decodeAvatarDataUrl(it) }
                    ?.let { BitmapFactory.decodeByteArray(it.second, 0, it.second.size) }
                    ?: LetterAvatar.render(this, incomingCallerName)
            }.getOrNull()
            try {
                startIncomingForeground(sid)
            } catch (e: Exception) {
                SomsLog.w("SomsCall") { "incoming notification update failed: ${e.message}" }
            }
            if (notificationSession?.isCurrent(this) != true) {
                stopSelf(startId)
                return START_NOT_STICKY
            }
        } else if (!isIncoming) {
            // Outgoing / re-delivered start: comms audio (the call is negotiating/active).
            acquireAudio()
        } else {
            // An incoming start with no sid (shouldn't happen) — promoted + now stop.
            stopSelf()
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
        if (notificationSession?.isCurrent(this) != true) { stopSelf(); return }
        acquireAudio()
        startCallForeground()
    }

    /** Promote to a phoneCall foreground service with the ONGOING-call notification (the active call). The
     *  typed startForeground (3-arg, FOREGROUND_SERVICE_TYPE_PHONE_CALL) is required on Android 14+; older
     *  versions use the 2-arg overload. Mirrors [RealtimeService.startForegroundCompat]. */
    private fun startCallForeground() {
        if (destroyed) return
        if (notificationSession?.isCurrent(this) != true) { stopSelf(); return }
        val notif = buildOngoingNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    /** Decode the `data:image/<mime>;base64,…` avatar the trigger resolved from native SQLite (the same
     *  inline form [com.soms.client.ClientStateDb] produces). Returns mime + raw bytes. */
    private fun decodeAvatarDataUrl(value: String): Pair<String, ByteArray>? {
        if (!value.startsWith("data:image/")) return null
        val marker = value.indexOf(";base64,")
        if (marker < 5) return null
        return try {
            value.substring(5, marker) to
                Base64.decode(value.substring(marker + 8), Base64.DEFAULT)
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    /** Promote to foreground with the INCOMING-ring notification (the FGS foreground surface while ringing). */
    private fun startIncomingForeground(sid: String) {
        if (destroyed) return
        if (notificationSession?.isCurrent(this) != true) { stopSelf(); return }
        val notif = buildIncomingNotification(sid)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    /** The foreground-call notification. Before the media connection is established, use a standard
     *  notification so Android does not label a merely dialing/connecting call as "in progress".
     *  Once connected (including a temporary reconnect), CallStyle renders the system's native in-call
     *  surface on API 31+ and degrades to a standard ongoing notification on older versions. */
    private fun buildOngoingNotification(): Notification {
        ensureChannels()
        val phase = CallController.phase
        val status = when (phase) {
            "starting" -> getString(R.string.call_status_starting)
            "calling", "ringing" -> getString(R.string.call_status_calling)
            "connecting" -> getString(R.string.call_status_connecting)
            else -> getString(R.string.call_status_connected)
        }
        val person = Person.Builder()
            .setName(CallController.peerName.ifEmpty { getString(R.string.app_name) })
            .apply { avatarBitmap?.let { setIcon(IconCompat.createWithBitmap(it)) } }
            .build()
        // Hang-up button on the ongoing notification (the AndroidX CallStyle requires a non-null hangUpIntent).
        // Routes to SomsActionReceiver → CallController.end. CallController.callSid is set by the time the
        // ongoing notification is posted (the call is live); the empty-string guard is in the receiver.
        val hangUpIntent = Intent(this, SomsActionReceiver::class.java).apply {
            putExtra(SomsActionReceiver.EXTRA_CALL_END, CallController.callSid ?: "")
            notificationSession!!.attach(this, "end", CallController.callSid ?: "")
        }
        val hangUpPi = PendingIntent.getBroadcast(
            this, REQ_HANGUP, hangUpIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val builder = NotificationCompat.Builder(this, CHANNEL_ONGOING)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(CallController.peerName.ifEmpty { getString(R.string.app_name) })
            .setContentText(status)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)

        return if (phase == "connected" || phase == "reconnecting") {
            builder.setStyle(
                NotificationCompat.CallStyle.forOngoingCall(person, hangUpPi)
                    .setIsVideo(CallController.callType == "VIDEO"),
            )
                .build()
        } else {
            builder
                .addAction(
                    android.R.drawable.ic_menu_close_clear_cancel,
                    getString(R.string.pip_hang_up),
                    hangUpPi,
                )
                .build()
        }
    }

    /** The incoming-ring notification: MAX priority + CATEGORY_CALL + a full-screen intent (launches the app
     *  to the incoming UI, or the system call screen on a locked device) + Answer (→ MainActivity) / Decline
     *  (→ SomsActionReceiver) actions. The incoming channel owns the ringtone; the in-app incoming screen
     *  never plays a second sound. The notification provides the same alert in foreground and background. */
    private fun buildIncomingNotification(sid: String): Notification {
        ensureChannels()
        val answerIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            action = ACTION_ANSWER
            putExtra(EXTRA_SID, sid)
            notificationSession!!.attach(this, "answer", sid)
        }
        val answerPi = PendingIntent.getActivity(
            this, REQ_ANSWER, answerIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val declineIntent = Intent(this, SomsActionReceiver::class.java).apply {
            putExtra(SomsActionReceiver.EXTRA_CALL_DECLINE, sid)
            notificationSession!!.attach(this, "decline", sid)
        }
        val declinePi = PendingIntent.getBroadcast(
            this, REQ_DECLINE, declineIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        // The full-screen intent launches the app to SHOW the incoming-call UI — it must NOT carry
        // ACTION_ANSWER (firing the FSI on screen-off / lock screen would auto-accept with no user tap). A
        // neutral launch boots MainActivity → the WebView re-derives the 'incoming' snapshot → the CallScreen
        // renders with Accept/Decline. The Answer ACTION BUTTON (answerPi, above) is the explicit accept.
        val showIncomingIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            action = ACTION_SHOW_INCOMING
            putExtra(EXTRA_SID, sid)
            notificationSession!!.attach(this, "show", sid)
        }
        val showIncomingPi = PendingIntent.getActivity(
            this, REQ_SHOW_INCOMING, showIncomingIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val caller = Person.Builder()
            .setName(incomingCallerName.ifEmpty { getString(R.string.app_name) })
            .apply { avatarBitmap?.let { setIcon(IconCompat.createWithBitmap(it)) } }
            .build()
        val callStyle = NotificationCompat.CallStyle
            .forIncomingCall(caller, declinePi, answerPi)
            .setIsVideo(incomingCallType == "VIDEO")
            // Hints only: Android / the OEM still owns the final CallStyle button shape and iconography.
            .setAnswerButtonColorHint(Color.rgb(22, 163, 74))
            .setDeclineButtonColorHint(Color.rgb(220, 38, 38))
        return NotificationCompat.Builder(this, CHANNEL_INCOMING)
            .setSmallIcon(R.mipmap.ic_launcher)
            // forIncomingCall(person, declineIntent, answerIntent) — decline FIRST (the framework signature;
            // a swap would put the labels on the wrong buttons since both args are PendingIntent). CallStyle
            // sets the Answer/Decline actions, the caller display, + the full-screen promotion on API 31+.
            // setCategory + setFullScreenIntent cover the API < 31 degrade (standard-notification path) +
            // ensure CATEGORY_CALL for the full-screen auto-grant on API 34+.
            .setStyle(callStyle)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setContentIntent(showIncomingPi)
            .setFullScreenIntent(showIncomingPi, true)
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
        setSpeakerEnabled(CallController.speakerEnabled)
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

    fun setSpeakerEnabled(enabled: Boolean) {
        val am = audioManager
            ?: (getSystemService(Context.AUDIO_SERVICE) as AudioManager).also { audioManager = it }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val preferredType = if (enabled) {
                AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
            } else {
                AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
            }
            am.availableCommunicationDevices
                .firstOrNull { it.type == preferredType }
                ?.let { am.setCommunicationDevice(it) }
        } else {
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = enabled
        }
    }

    private fun releaseAudio() {
        val am = audioManager ?: return
        focusRequest?.let { am.abandonAudioFocusRequest(it) }
        focusRequest = null
        am.mode = AudioManager.MODE_NORMAL
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.clearCommunicationDevice()
        wakeLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
    }

    /** The call ended — release the audio/wake, tell the controller to dispose the PC, and stop the service. */
    fun end() {
        stopSelf()
    }

    override fun onDestroy() {
        destroyed = true
        mainHandler.removeCallbacksAndMessages(null)
        // Clear the instance FIRST so CallController.onAccepted can't reach a destroying service.
        if (instance === this) instance = null
        releaseAudio()
        CallController.destroy(notificationCallSid)
        super.onDestroy()
    }

    /** Decode a native-SQLite avatar data URL for an outgoing-call notification. */
    internal fun loadAvatar(src: String, name: String) {
        if (src.isEmpty()) {
            // No avatar image → render an initial-letter tile (matches the in-app avatar color exactly — the
            // same palette + name hash as UserAvatarComponent) instead of the app-logo fallback.
            avatarBitmap = LetterAvatar.render(this, name)
            mainHandler.post { refreshNotification() }
            SomsLog.d("SomsCall") { "loadAvatar: empty src → letter avatar ($name)" }
            return
        }
        Thread {
            val bmp = decodeDataUrlAvatar(src)
            SomsLog.d("SomsCall") {
                "loadAvatar: len=${src.length} bmp=${bmp != null}${if (bmp != null) " ${bmp.width}x${bmp.height}" else ""}"
            }
            if (bmp != null) {
                avatarBitmap = bmp
                mainHandler.post { refreshNotification() }
            }
        }.start()
    }

    /** Decode the base64 payload of a `data:` URL to a bitmap. */
    private fun decodeDataUrlAvatar(dataUrl: String): Bitmap? {
        return try {
            val b64 = dataUrl.substringAfter("base64,", "")
            if (b64.isEmpty()) return null
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        } catch (e: Exception) {
            null
        }
    }

    /** Re-post the current notification (incoming-ring or ongoing) so the now-loaded avatar icon shows. */
    fun refreshForPhase() {
        when (CallController.phase) {
            "incoming" -> CallController.callSid?.let { startIncomingForeground(it) }
            "starting", "calling", "ringing", "connecting", "connected", "reconnecting" -> startCallForeground()
            else -> {}
        }
    }

    /** Avatar completion uses the same phase-driven notification refresh as lifecycle transitions. */
    private fun refreshNotification() = refreshForPhase()

    /** Create the low-importance ongoing and audible high-importance incoming channels if absent. */
    private fun ensureChannels() {
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(CHANNEL_ONGOING) == null) {
            mgr.createNotificationChannel(
                NotificationChannel(CHANNEL_ONGOING, getString(R.string.call_channel_ongoing), NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Ongoing call anchor"
                    setShowBadge(false)
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 1000, 1000)
                },
            )
        }
        if (mgr.getNotificationChannel(CHANNEL_INCOMING) == null) {
            mgr.createNotificationChannel(
                NotificationChannel(CHANNEL_INCOMING, getString(R.string.call_channel_incoming), NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Incoming call ring"
                    // Calls have their own full-screen/heads-up surface and must not affect the message count.
                    setShowBadge(false)
                    // The channel carries the ringtone: an AUDIBLE sound is what makes the heads-up banner
                    // actually pop on OEMs like Huawei EMUI (a no-sound IMPORTANCE_HIGH channel lands silently
                    // in the shade). The system plays it when the incoming notification posts; CallRinger is
                    // NOT used (it would double). NOTE: a channel is immutable once created, so changing this
                    // sound requires the app be reinstalled (a fresh install) — the user clears the stale
                    // no-sound channel that way.
                    setSound(
                        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build(),
                    )
                },
            )
        }
    }

    companion object {
        /** Stable notification id for the call (the ringing card + the ongoing card share it — one replaces
         *  the other; distinct from RealtimeService's 0x6). */
        private const val NOTIF_ID = 0x9
        // v2 is intentional: older channels used Android's badge-enabled default, and setShowBadge cannot
        // be changed after a channel has been submitted to NotificationManager.
        private const val CHANNEL_ONGOING = "soms_calls_v1"
        private const val CHANNEL_INCOMING = "soms_calls_incoming_v1"

        /** Start the service in the incoming-ring mode (from the CALL_INCOMING FCM push). */
        private const val ACTION_INCOMING = "soms.action.CALL_INCOMING"
        /** A MainActivity launch with this action answers the incoming call (the notification Answer button). */
        const val ACTION_ANSWER = "soms.action.CALL_ANSWER"
        /** A MainActivity launch with this action just SHOWS the incoming-call UI (the full-screen intent) —
         *  distinct from ACTION_ANSWER so firing the FSI does NOT auto-accept. */
        const val ACTION_SHOW_INCOMING = "soms.action.CALL_SHOW"
        /** The callSid extra shared by the service start + the notification intents (MainActivity + the
         *  decline receiver read it). Public so those callers can reference it. */
        const val EXTRA_SID = "soms_call_sid"
        private const val EXTRA_CALLER_ACCOUNT = "soms_call_caller_account"
        private const val EXTRA_CALLER_NAMESPACE_ID = "soms_call_caller_namespace_id"
        private const val EXTRA_CALLER_NAME = "soms_call_caller_name"
        private const val EXTRA_CALLER_AVATAR = "soms_call_caller_avatar"
        private const val EXTRA_THREAD_ID = "soms_call_thread_id"
        private const val EXTRA_CALL_TYPE = "soms_call_type"
        private const val REQ_ANSWER = 7001
        private const val REQ_DECLINE = 7002
        private const val REQ_HANGUP = 7003
        private const val REQ_SHOW_INCOMING = 7004

        /** The live service instance, for CallController to reach [onAccepted] on the accept transition.
         *  @Volatile: written on main (onCreate/onDestroy), read on the call / JS bridge threads. */
        @Volatile var instance: CallService? = null
            private set

        /** Start the call FGS for an incoming ring. The trigger (SSE / HELLO / FCM) has already resolved
         *  the caller presentation from native SQLite and seeds [CallController] itself; this start passes
         *  the resolved facts inline, so the service only renders them. The high-priority FCM grant is the
         *  exemption that lets a backgrounded/killed app start a phoneCall FGS; the try/catch is
         *  belt-and-suspenders for a rare rejected start (the phone still won't ring, but the process won't
         *  crash). */
        fun startIncoming(
            ctx: Context,
            sid: String,
            callerAccount: String,
            callerNamespaceId: Int,
            threadId: Int,
            callType: String,
            callerName: String,
            callerAvatarDataUrl: String,
        ) {
            val binding = NotificationSessionBinding.capture(ctx) ?: run {
                SomsLog.w("SomsCall") { "incoming notification skipped: session identity is not ready" }
                return
            }
            val intent = Intent(ctx, CallService::class.java).apply {
                binding.attach(this, "incoming-service", sid)
                action = ACTION_INCOMING
                putExtra(EXTRA_SID, sid)
                putExtra(EXTRA_CALLER_ACCOUNT, callerAccount)
                putExtra(EXTRA_CALLER_NAMESPACE_ID, callerNamespaceId)
                putExtra(EXTRA_CALLER_NAME, callerName)
                putExtra(EXTRA_CALLER_AVATAR, callerAvatarDataUrl)
                putExtra(EXTRA_THREAD_ID, threadId)
                putExtra(EXTRA_CALL_TYPE, callType)
            }
            CallController.whenSessionResourcesReleased {
                if (!binding.isCurrent(ctx)) return@whenSessionResourcesReleased
                try {
                    ContextCompat.startForegroundService(ctx, intent)
                } catch (e: Exception) {
                    SomsLog.w("SomsCall") { "CallService.startIncoming skipped: ${e.javaClass.simpleName}: ${e.message}" }
                }
            }
        }
    }
}
