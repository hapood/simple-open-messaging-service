package com.soms.client

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.BuiltinAudioDecoderFactoryFactory
import org.webrtc.BuiltinAudioEncoderFactoryFactory
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.IceCandidate
import org.webrtc.IceCandidateErrorEvent
import org.webrtc.MediaConstraints
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.VideoTrack
import org.webrtc.SessionDescription.Type
import org.webrtc.audio.JavaAudioDeviceModule
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Process-global owner of the live 1:1 call's WebRTC state + the call lifecycle FSM. The server is the
 * signaling coordinator ONLY (it never carries media — see CallsService); the actual RTCPeerConnection +
 * the DTLS-SRTP media leg live HERE, in native Kotlin, NOT in the WebView. The WebView is a disposable
 * "chrome" layer: it drives the call via the [SomsCallInterface] bridge (initiate/accept/…/getSnapshot)
 * and consumes CALL_EVENT/CALL_SIGNAL over the existing SSE path; this object is the source of truth a
 * re-attached WebView re-derives via [snapshotJson].
 *
 * Why an `object` (process-global), not the [CallService] FGS instance: both [RealtimeService] (the SSE
 * owner) and [SomsCallInterface] (the JS bridge, in MainActivity) must reach the live PC with no reference
 * wiring between them — a `@Volatile` singleton lets either call [onFrame] / [initiate] / … directly. The
 * state also survives an Activity recreation (renderer reclaim → Activity restart) within the process; the
 * [CallService] FGS is the process anchor whose lifetime bounds a call (it is started on call begin and
 * stopped on end), but the PC + FSM live here.
 *
 * Threading: a dedicated single-thread [callExecutor] serializes every PC op + REST call (PeerConnection
 * methods are documented as "called from any thread, but not concurrently" — serializing avoids the
 * offer/answer/ICE reordering bugs concurrent access causes). The SSE listener hands frames in via [onFrame]
 * (a thread hop); the JS bridge hands commands via the public methods (also a thread hop). [snapshot] fields
 * are @Volatile so a synchronous [snapshotJson] read from the JS bridge thread never blocks on the executor.
 *
 * Phase 2 scope: AUDIO-only, same-server. Video capture / surface overlay (Phase 4), the connection-status
 * FSM polish (Phase 5), and federated glare (deferred) are not here yet. The offer/answer/ICE exchange +
 * the /calls REST sequence mirror docs/android-calls-client.md §2.
 */
object CallController {

    private const val TAG = "SomsCall"

    // Reconnect + accepted-backstop timing + the pure FSM/backstop decisions live in [CallFsm] (unit-tested).

    /** The volatile call snapshot the JS bridge reads synchronously via [snapshotJson] (a freshly-booted /
     *  re-attached WebView re-derives the call UI from this, no SSE wait). Fields are written on
     *  [callExecutor], read on the JS bridge thread — @Volatile for the primitive ref reads. */
    @Volatile var callSid: String? = null
        private set
    @Volatile var threadId: Int = 0
        private set
    @Volatile var peerUserId: Int = 0
        private set
    @Volatile var callType: String = "AUDIO"
        private set
    /** true = this side placed the call (caller); false = this side was rung (callee). */
    @Volatile var isCaller: Boolean = false
        private set
    /** The peer's display name. Set by [seedIncoming] from the CALL_INCOMING FCM push — a cold-started callee
     *  has no live SSE, so the web UI can't get the name from CALL_EVENT{incoming}; this carries it inline.
     *  Empty for the foreground path (the SSE incoming frame owns the name there). Surfaced via [snapshotJson]. */
    @Volatile var peerName: String = ""
        private set
    /** UI phase, the merged call-FSM ∪ RTCPeerConnection state (Phase 5 refines the labels):
     *  idle | calling | ringing | incoming | connecting | connected | reconnecting | ended. */
    @Volatile var phase: String = "idle"
        private set
    /** The last advisory media state from the PC (new/ gathering / connecting / connected / disconnected /
     *  failed) — drives the reconnecting/failed UX. */
    @Volatile var mediaState: String = "new"
        private set
    @Volatile var startedAt: Long = 0L
        private set
    @Volatile var muted: Boolean = false
        private set

    private val appContext: Context?
        get() = SomsApplication.appContext

    /** The incoming-call ring (ringtone/vibrate/wake) — extracted mechanics; the FSM owns the transitions
     *  ([CallRinger] uses a looping MediaPlayer). */
    private val ringer = CallRinger { appContext }
    /** The video half — EGL/capture/tracks/the sibling-surface overlays/swap. Extracted from the FSM
     *  ([VideoSurfaceManager]). */
    private val video = VideoSurfaceManager { appContext }

    private val initLock = Any()
    private var factory: PeerConnectionFactory? = null
    private var audioDeviceModule: org.webrtc.audio.AudioDeviceModule? = null
    @Volatile private var pc: PeerConnection? = null
    @Volatile private var audioSource: AudioSource? = null
    @Volatile private var localAudioTrack: AudioTrack? = null
    /** Callee-side buffer for the SDP offer + ICE candidates that arrive BEFORE accept creates the PC. The
     *  caller sends the offer + trickles ICE right after initiate, which routinely reaches the callee while
     *  it is still ringing (before the user taps accept) — without buffering, `pc == null` drops them and the
     *  call never negotiates (stuck in connecting → server ringing-timeout → missed). Flushed by
     *  [flushPending] once accept builds the PC. */
    private var pendingOffer: String? = null
    private val pendingIce = mutableListOf<String>()

    // ── video ─────────────────────────────────────────────────────────────────────
    // The EGL base, camera capture, tracks, the sibling-surface overlays, and the swap all live in
    // [video] (VideoSurfaceManager). See that class for the ⚠️ on-device-verification note + the
    // z-order / sink-race gotchas.

    /** UI-thread handler — the reconnect + accepted backstops post here (view-tree ops live in VideoSurfaceManager). */
    private val mainHandler = Handler(Looper.getMainLooper())

    /** True once the caller has tried an ICE restart for this call, so the reconnect backstop's second firing
     *  fails instead of restarting again (one restart attempt, then give up). Reset in [teardown]/[initiate]. */
    @Volatile private var iceRestartTried = false
    /** Posted on [mainHandler] when the PC goes DISCONNECTED; hops to [callExecutor]. Cancelled on CONNECTED +
     *  [teardown]. Bounds "Reconnecting…": after the grace the caller restarts ICE once (re-arming a shorter
     *  backstop), then the call fails. */
    private val reconnectBackstop = Runnable { onReconnectBackstop() }

    private fun onReconnectBackstop() {
        callExecutor.execute {
            if (phase != "reconnecting") return@execute // recovered, or already ended
            if (callSid == null) return@execute
            if (CallFsm.shouldRestartOnReconnect(isCaller, iceRestartTried, pc != null)) {
                iceRestartTried = true
                SomsLog.i(TAG) { "reconnect backstop -> ICE restart (caller); re-arming short backstop" }
                runCatching {
                    val c = pc!!
                    c.restartIce()
                    c.createOffer(offerSdpObserver, iceRestartConstraints())
                }.onFailure { SomsLog.w(TAG) { "ICE restart failed: ${it.message}" } }
                mainHandler.postDelayed(reconnectBackstop, CallFsm.RECONNECT_BACKSTOP_SHORT_MS)
            } else {
                SomsLog.i(TAG) { "reconnect backstop -> fail (callee, or restart exhausted)" }
                fail("failed")
            }
        }
    }

    // The killed-callee lost-offer case is now handled server-side: the server stages the offer + ICE
    // (CallsService signaling store) + the callee FETCHES it on accept (fetchSignaling). No client-side
    // re-offer backstop / acceptedTimer is needed.

    /** Serial executor for every PC op + REST call (see class doc). Named for logcat. */
    private val callExecutor = Executors.newSingleThreadExecutor { r -> Thread(r, "SomsCall") }

    /** Synchronous REST client for the /calls endpoints. Long-ish timeouts: ICE trickling + a flaky peer
     *  can make a signal relay slow; the call must not abort on a tight timeout. */
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .build()

    // ── factory / PC construction ─────────────────────────────────────────────────

    /** Lazily build the PeerConnectionFactory once per process (the factory is expensive + owns native
     *  media codecs; reuse it across calls). The Android NetworkMonitor is enabled via the init options so
     *  WebRTC can BIND candidate sockets to non-default networks (e.g. use a cellular IPv6 host candidate
     *  while the device's default route is WiFi) — without it the media leg is stuck on the default network
     *  and a WiFi-default-but-no-IPv6 / cellular-has-IPv6 device can't reach an IPv6-only peer. */
    private fun ensureFactory(): PeerConnectionFactory {
        factory?.let { return it }
        synchronized(initLock) {
            factory?.let { return it }
            val ctx = appContext ?: throw IllegalStateException("CallController: no app context")
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(ctx)
                    .createInitializationOptions(),
            )
            val adm = JavaAudioDeviceModule.builder(ctx).createAudioDeviceModule()
            audioDeviceModule = adm
            // Shared EGL context for the video encode/decode factories (owned by VideoSurfaceManager, which
            // also uses it for the capture SurfaceTextureHelper + the SurfaceViewRenderers). Borrowed here so
            // the factories are wired at factory-build time (a PC without video factories can build a
            // VideoTrack but never encode/decode it → no frames).
            val eglCtx = video.eglBase().eglBaseContext
            val f = PeerConnectionFactory.builder()
                .setAudioDeviceModule(adm)
                .setAudioEncoderFactoryFactory(BuiltinAudioEncoderFactoryFactory())
                .setAudioDecoderFactoryFactory(BuiltinAudioDecoderFactoryFactory())
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglCtx, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglCtx))
                .createPeerConnectionFactory()
            factory = f
            return f
        }
    }

    /** Build the RTCConfiguration from the server-fetched ICE servers + the liveness/recovery policy.
     *  - GATHER_CONTINUALLY: re-gather candidates when the network changes (WiFi↔cellular handoff), so a
     *    mid-call handoff can recover via ICE restart instead of failing.
     *  - ALL: gather host + srflx + relay (host gives the same-LAN direct path; relay needs TURN, OFF now).
     *  IPv6 candidates are on by default (never disable — a cellular-IPv6 path may be the only one that
     *  works when the default WiFi lacks IPv6). */
    private fun rtcConfig(iceServers: List<PeerConnection.IceServer>): PeerConnection.RTCConfiguration {
        val cfg = PeerConnection.RTCConfiguration(iceServers)
        // GATHER_CONTINUALLY: re-gather candidates when the network changes (WiFi↔cellular handoff), so a
        // mid-call handoff can recover via ICE restart. The defaults (iceTransportsType=ALL → host+srflx+relay,
        // UNIFIED_PLAN, BALANCED) are correct — only continual gathering needs setting. IPv6 stays on (a
        // cellular-IPv6 path may be the only one that works when the default WiFi lacks IPv6).
        cfg.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        return cfg
    }

    /** Create the PC for the current call, wire the audio track (mic), and the observer (ICE candidate
     *  trickle + connection-state → /calls/connected + reconnecting/failed). Caller-side: the offer is
     *  created after this by [initiate]. Callee-side: the remote offer is applied by [applySignal]. */
    private fun createPeerConnection(): PeerConnection {
        val f = ensureFactory()
        val iceServers = fetchIceServers()
        val connection = f.createPeerConnection(rtcConfig(iceServers), observer)
            ?: throw IllegalStateException("createPeerConnection returned null")
        pc = connection
        // Audio source + track. goog constraints = the standard AEC/AGC/NS toggles for comms audio.
        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googHighpassFilter", "true"))
        }
        val source = f.createAudioSource(constraints)
        audioSource = source
        val track = f.createAudioTrack("ARDAMSa0", source)
        localAudioTrack = track
        connection.addTrack(track, listOf("ARDAMS"))
        if (callType == "VIDEO") video.setupVideoCapture(f, connection)
        return connection
    }

    // ── video delegation (the logic lives in [video] / VideoSurfaceManager) ────────

    /** Flip front↔back camera. No-op on an AUDIO call. */
    fun switchCamera() = video.switchCamera()

    /** Camera on/off (mute video, keep audio). */
    fun setCameraEnabled(enabled: Boolean) = video.setCameraEnabled(enabled)

    /** Mount/position the remote + self video surfaces, or detach (both rects null). */
    fun setVideoRect(remoteRect: String?, selfRect: String?) = video.setVideoRect(remoteRect, selfRect)

    /** Swap which video is full-bleed vs PiP (tap the self PiP). No-op on an AUDIO call. */
    fun swapVideo() = video.swapVideo()

    /** The remote video's rotated frame dimensions, or null until the first frame — for PiP aspect sizing. */
    fun remoteVideoDimensions(): Pair<Int, Int>? = video.remoteDimensions()

    /** The WebView is gone (Activity destroy or recreation) — release the orphaned video surfaces (the tracks
     *  + PC survive; the call continues audio-only until a new WebView re-reports rects). */
    fun onWebViewGone() = video.onWebViewGone()

    // ── the PC observer: ICE trickle + connection state ───────────────────────────

    private val observer = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
            // Older callback; onConnectionChange (below) is the modern source — keep this for logging.
            SomsLog.i(TAG) { "onIceConnectionChange $state" }
        }
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {
            SomsLog.i(TAG) { "iceGathering $state" }
        }

        /** A local ICE candidate is ready → trickle it to the peer over /calls/signal. */
        override fun onIceCandidate(candidate: IceCandidate) {
            val sid = callSid ?: return
            val peer = peerUserId.takeIf { it != 0 } ?: return
            SomsLog.i(TAG) { "local ICE candidate → relay (sdpMid=${candidate.sdpMid})" }
            val payload = JSONObject()
                .put("candidate", candidate.sdp)
                .put("sdpMid", candidate.sdpMid ?: "")
                .put("sdpMLineIndex", candidate.sdpMLineIndex)
                .toString()
            postSignal(sid, peer, "ice", payload)
        }

        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
        override fun onIceCandidateError(event: IceCandidateErrorEvent?) {
            SomsLog.w(TAG) { "iceCandidateError $event" }
        }
        override fun onAddStream(stream: org.webrtc.MediaStream?) {} // deprecated (UNIFIED_PLAN uses onAddTrack)
        override fun onRemoveStream(stream: org.webrtc.MediaStream?) {}
        override fun onDataChannel(dc: org.webrtc.DataChannel?) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(receiver: org.webrtc.RtpReceiver?, streams: Array<out org.webrtc.MediaStream>?) {
            // Remote video: store the track + sink via relinkVideoSinks. The renderer may not be mounted yet
            // (onAddTrack fires during SDP negotiation, before the WebView's setVideoRect creates it), so
            // storing the track + relinking means the sink lands the moment BOTH halves exist (not the
            // `remoteRenderer ?: return` early-drop that previously lost the track on the race). Remote AUDIO
            // is auto-routed by the AudioDeviceModule — no sink needed.
            val track = receiver?.track()
            if (track is VideoTrack) {
                video.onRemoteTrack(track)
            }
        }

        /** The modern connection-state callback (supersedes onIceConnectionChange for state). Drives the
         *  real connect marker + the reconnecting/failed UX. */
        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {
            val s = newState?.name?.lowercase() ?: return
            mediaState = s
            SomsLog.i(TAG) { "connectionState=$s phase=$phase" }
            when (newState) {
                PeerConnection.PeerConnectionState.CONNECTED -> {
                    cancelReconnectBackstop()
                    if (phase != "connected") {
                        phase = "connected"
                        startedAt = System.currentTimeMillis()
                        pushSnapshot()
                    }
                    val sid = callSid ?: return
                    callExecutor.execute { postConnected(sid) }
                }
                PeerConnection.PeerConnectionState.DISCONNECTED -> {
                    // Transient (a blip / handoff). Do NOT fail immediately — GATHER_CONTINUALLY regathers on a
                    // network change and recovers most of these inside the backstop window; the caller's ICE
                    // restart covers the stale-credentials case. Mark reconnecting so the UI shows it calmly,
                    // and arm the backstop so a real drop can't hang here forever.
                    if (phase == "connected") phase = "reconnecting"
                    pushSnapshot()
                    armReconnectBackstop()
                }
                PeerConnection.PeerConnectionState.FAILED -> {
                    // ICE gave up. End the call as failed (the server maps endReason=failed → the `failed`
                    // CALL bubble with duration, since we did connect).
                    fail("failed")
                }
                else -> {}
            }
        }
    }

    // ── inbound frames (CALL_SIGNAL / CALL_EVENT) from RealtimeService ────────────

    /** Entry point for [RealtimeService.onEvent] — runs in BOTH fg and bg (a CALL_SIGNAL ICE frame must
     *  reach the native PC even while the WebView is suspended — the whole point of native-owned WebRTC).
     *  Hops onto [callExecutor] for serial handling. No-op when no live call matches (a stray frame after
     *  end). */
    fun onFrame(type: String, data: String) {
        callExecutor.execute {
            try {
                when (type) {
                    "CALL_SIGNAL" -> handleSignalFrame(JSONObject(data))
                    "CALL_EVENT" -> handleEventFrame(JSONObject(data))
                }
            } catch (e: Exception) {
                SomsLog.w(TAG) { "onFrame $type failed: ${e.message}" }
            }
        }
    }

    /** Route one relayed WebRTC frame. The callee may receive the offer + early ICE BEFORE accept creates the
     *  PC (the caller sends them right after initiate, while the callee is still ringing) — buffer those and
     *  flush in [accept] once the PC exists; otherwise `pc == null` drops them and the call never negotiates. */
    private fun handleSignalFrame(obj: JSONObject) {
        val kind = obj.optString("kind")
        val payload = obj.optString("payload")
        if (pc == null) {
            when (kind) {
                "offer" -> { pendingOffer = payload; SomsLog.i(TAG) { "buffered offer (pc not created yet — pre-accept)" } }
                "ice" -> { pendingIce.add(payload); SomsLog.i(TAG) { "buffered ICE (${pendingIce.size}) pre-accept" } }
            }
            return
        }
        applySignal(pc!!, kind, payload)
    }

    /** Apply one relayed frame to an EXISTING pc: offer→setRemoteDescription+createAnswer, answer→
     *  setRemoteDescription, ice→addIceCandidate. */
    private fun applySignal(connection: PeerConnection, kind: String, payload: String) {
        when (kind) {
            "offer" -> {
                SomsLog.i(TAG) { "applying remote offer → setRemoteDescription + createAnswer" }
                setRemote(connection, Type.OFFER, payload)
                connection.createAnswer(answerSdpObserver, offerAnswerConstraints())
            }
            "answer" -> {
                SomsLog.i(TAG) { "applying remote answer → setRemoteDescription" }
                setRemote(connection, Type.ANSWER, payload)
                if (phase == "calling" || phase == "ringing") {
                    phase = "connecting"
                    pushSnapshot()
                }
            }
            "ice" -> {
                val p = JSONObject(payload)
                connection.addIceCandidate(
                    IceCandidate(p.optString("sdpMid"), p.optInt("sdpMLineIndex"), p.optString("candidate")),
                )
            }
        }
    }

    /** Flush the callee's buffered offer + ICE now that accept has built the PC. Offer first (setRemote +
     *  answer), then the queued ICE candidates (addIceCandidate is valid after setRemoteDescription). */
    private fun flushPending(connection: PeerConnection) {
        pendingOffer?.let { applySignal(connection, "offer", it); pendingOffer = null }
        if (pendingIce.isNotEmpty()) {
            SomsLog.i(TAG) { "flushing ${pendingIce.size} buffered ICE candidate(s)" }
            for (p in pendingIce) applySignal(connection, "ice", p)
            pendingIce.clear()
        }
    }

    /** Fetch the staged offer + ICE from `/calls/:sid/signaling` + apply them (the offline-callee path: the
     *  offer was staged server-side because the callee had no live SSE when it trickled). Reuses [applySignal]
     *  for the setRemoteDescription+createAnswer + addIceCandidate paths. A no-op if the fetch fails (the call
     *  then times out / fails via the connection state — same as any signaling loss). */
    private fun fetchAndApplySignaling(connection: PeerConnection, sid: String) {
        val staged = fetchSignaling(sid) ?: return
        val offer = staged.optString("offer", "")
        if (offer.isEmpty()) return
        val iceCount = staged.optJSONArray("ice")?.length() ?: 0
        SomsLog.i(TAG) { "no buffered offer -> applied staged offer from server (+$iceCount ICE)" }
        applySignal(connection, "offer", offer)
        val ice = staged.optJSONArray("ice")
        if (ice != null) for (i in 0 until ice.length()) applySignal(connection, "ice", ice.getString(i))
    }

    /** GET /calls/:callSid/signaling → the staged offer + caller ICE for the callee (the server's
     *  store-and-forward copy). Returns null on any failure (auth/network/parse). */
    private fun fetchSignaling(callSid: String): JSONObject? {
        val origin = activeOrigin() ?: return null
        return get("$origin${SomsSecureStore.API_PREFIX}/calls/$callSid/signaling")
    }

    /** Apply one lifecycle event to the FSM + drive the JS UI via [pushSnapshot]. The incoming/accepted/
     *  connected/ended/… types mirror docs/android-calls-client.md. ringing (Phase 1 server event) flips
     *  the caller's label Calling…→Ringing…. */
    private fun handleEventFrame(obj: JSONObject) {
        val type = obj.optString("type")
        val sid = obj.optString("callSid")
        if (sid.isNotEmpty() && callSid != null && sid != callSid) return // not our call (stray frame)
        when (type) {
            "incoming" -> {
                // We are the CALLEE. Seed the incoming context (the PC is created on accept).
                callSid = sid
                threadId = obj.optInt("threadId")
                peerUserId = obj.optInt("callerUserId")
                callType = obj.optString("callType", "AUDIO")
                isCaller = false
                phase = "incoming"
                startedAt = 0L
                pushSnapshot()
                // Ack that this device is alerting the user → the caller's UI shows "Ringing…" (Phase 1).
                callExecutor.execute { postRinging(sid) }
            }
            "ringing" -> {
                val np = CallFsm.nextPhase(phase, isCaller, "ringing")
                if (np != null) { phase = np; pushSnapshot() }
            }
            "accepted" -> {
                val np = CallFsm.nextPhase(phase, isCaller, "accepted")
                if (np != null) {
                    phase = np
                    pushSnapshot()
                }
            }
            "connected" -> {
                if (CallFsm.nextPhase(phase, isCaller, "connected") != null) {
                    phase = "connected"
                    startedAt = obj.optLong("startedAt", System.currentTimeMillis())
                    pushSnapshot()
                }
            }
            "declined", "cancelled", "missed", "ended" -> {
                if (CallFsm.nextPhase(phase, isCaller, type) == "ended") {
                    phase = "ended"
                    pushSnapshot()
                    teardown()
                }
            }
        }
    }

    // ── SDP observers (offer/answer → setLocalDescription → relay) ────────────────

    private fun offerAnswerConstraints(): MediaConstraints =
        MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"))
        }

    /** setRemoteDescription wrapper that logs failure (a bad SDP usually means a signaling race; the call
     *  will time out / fail via the connection state rather than crash here). */
    private fun setRemote(connection: PeerConnection, type: Type, sdp: String) {
        connection.setRemoteDescription(object : SdpObserver {
            override fun onCreateSuccess(p0: SessionDescription?) {}
            override fun onSetSuccess() { SomsLog.i(TAG) { "setRemoteDescription($type) ok" } }
            override fun onCreateFailure(p0: String?) {}
            override fun onSetFailure(error: String?) { SomsLog.w(TAG) { "setRemoteDescription($type) failed: $error" } }
        }, SessionDescription(type, sdp))
    }

    private val offerSdpObserver = object : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription?) {
            val connection = pc ?: return
            val sid = callSid ?: return
            if (sdp == null) return
            SomsLog.i(TAG) { "offer created → setLocalDescription + relay" }
            connection.setLocalDescription(EmptySdpObserver, sdp)
            postSignal(sid, peerUserId, "offer", sdp.description)
        }
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String?) { SomsLog.w(TAG) { "createOffer failed: $error" } }
        override fun onSetFailure(error: String?) {}
    }

    private val answerSdpObserver = object : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription?) {
            val connection = pc ?: return
            val sid = callSid ?: return
            if (sdp == null) return
            SomsLog.i(TAG) { "answer created → setLocalDescription + relay" }
            connection.setLocalDescription(EmptySdpObserver, sdp)
            postSignal(sid, peerUserId, "answer", sdp.description)
        }
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String?) { SomsLog.w(TAG) { "createAnswer failed: $error" } }
        override fun onSetFailure(error: String?) {}
    }

    private object EmptySdpObserver : SdpObserver {
        override fun onCreateSuccess(p0: SessionDescription?) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(p0: String?) {}
        override fun onSetFailure(p0: String?) {}
    }

    // ── public API (the SomsCallInterface bridge calls these) ─────────────────────

    /** Caller starts a call. POST /calls/initiate → create the PC + offer + trickle ICE. The [CallService]
     *  FGS must already be running (started by the bridge before this) so the process is anchored + audio
     *  routing is in comms mode. */
    fun initiate(calleeUserId: Int, sid: String, type: String) {
        callExecutor.execute {
            try {
                val origin = activeOrigin() ?: run { SomsLog.w(TAG) { "initiate: no origin" }; return@execute }
                val res = post("$origin${SomsSecureStore.API_PREFIX}/calls/initiate",
                    JSONObject().put("callSid", sid).put("calleeUserId", calleeUserId).put("callType", type))
                if (res == null) return@execute
                callSid = sid
                threadId = res.optInt("threadId")
                peerUserId = calleeUserId
                callType = type
                isCaller = true
                phase = "calling"
                startedAt = 0L
                iceRestartTried = false
                peerName = ""
                pushSnapshot()
                val connection = createPeerConnection()
                connection.createOffer(offerSdpObserver, offerAnswerConstraints())
            } catch (e: Exception) {
                SomsLog.w(TAG) { "initiate failed: ${e.message}" }
            }
        }
    }

    /** Callee accepts the incoming ring. POST /calls/accept, then create the PC (the remote offer was
     *  applied by [handleSignalFrame] on the offer signal — but if the offer has not arrived yet, createAnswer
     *  will run when it does; the PC must exist to receive it). */
    fun accept(sid: String) {
        // Stop the incoming ring immediately on the user's tap (before the network round-trip — UX). Comms
        // audio is acquired AFTER the server confirms this device is the answering one (below).
        ringer.stopRing()
        callExecutor.execute {
            try {
                val origin = activeOrigin() ?: return@execute
                // The server is authoritative: if the call is no longer ringing (another device already
                // answered, or it ended), POST /calls/accept returns a non-zero code (CALL_NOT_FOUND) → `post`
                // returns null. This is the "late" device — dismiss + tear down; don't build a PC for a call
                // already answered elsewhere.
                val accepted = post("$origin${SomsSecureStore.API_PREFIX}/calls/accept", JSONObject().put("callSid", sid)) != null
                if (!accepted) {
                    SomsLog.i(TAG) { "accept rejected by server (answered/ended on another device) -> dismiss" }
                    phase = "ended"; pushSnapshot(); teardown(); return@execute
                }
                CallService.instance?.onAccepted() // confirmed the answering device — switch to comms audio
                val connection = pc ?: createPeerConnection()
                val hadOffer = pendingOffer != null
                flushPending(connection) // applies the buffered offer + ICE (the online case)
                if (!hadOffer) {
                    // The SSE never delivered the offer — the callee was offline when it trickled. Pull the
                    // authoritative staged copy from the server (CallsService signaling store) + apply it.
                    fetchAndApplySignaling(connection, sid)
                }
                phase = "connecting"
                pushSnapshot()
            } catch (e: Exception) {
                SomsLog.w(TAG) { "accept failed: ${e.message}" }
            }
        }
    }

    fun decline(sid: String) {
        ringer.stopRing() // stop the incoming ring at once — before the POST (teardown runs only after the network round-trip)
        callExecutor.execute {
            val origin = activeOrigin() ?: return@execute
            post("$origin${SomsSecureStore.API_PREFIX}/calls/decline", JSONObject().put("callSid", sid))
            phase = "ended"; pushSnapshot(); teardown()
        }
    }

    fun cancel(sid: String) {
        ringer.stopRing()
        callExecutor.execute {
            val origin = activeOrigin() ?: return@execute
            post("$origin${SomsSecureStore.API_PREFIX}/calls/cancel", JSONObject().put("callSid", sid))
            phase = "ended"; pushSnapshot(); teardown()
        }
    }

    fun end(sid: String, reason: String?) {
        ringer.stopRing()
        callExecutor.execute {
            val origin = activeOrigin() ?: return@execute
            val body = JSONObject().put("callSid", sid)
            if (!reason.isNullOrBlank()) body.put("endReason", reason)
            post("$origin${SomsSecureStore.API_PREFIX}/calls/end", body)
            phase = "ended"; pushSnapshot(); teardown()
        }
    }

    /** Relay one WebRTC frame to the peer. The JS bridge forwards frames the Angular layer generates only on
     *  the web fallback path; on Android the native observers post offers/answers/ICE directly, so this is
     *  primarily the renegotiate/media-state path. */
    fun signal(sid: String, toUserId: Int, kind: String, payload: String) = callExecutor.execute {
        postSignal(sid, toUserId, kind, payload)
    }

    /** Mute/unmute the mic (local audio track enabled state). */
    fun setMuted(value: Boolean) {
        muted = value
        localAudioTrack?.setEnabled(!value)
        pushSnapshot()
    }

    /** Synchronous JSON snapshot of the live call (or `{phase:"idle"}` when none) — the JS bridge returns
     *  this from window.SomsCall.getSnapshot() so a re-attached WebView re-derives the call UI instantly. */
    fun snapshotJson(): String = JSONObject()
        .put("phase", phase)
        .put("callSid", callSid ?: JSONObject.NULL)
        .put("threadId", threadId)
        .put("peerUserId", peerUserId)
        .put("peerName", peerName)
        .put("callType", callType)
        .put("isCaller", isCaller)
        .put("mediaState", mediaState)
        .put("startedAt", startedAt)
        .put("muted", muted)
        .put("swapped", video.swapped)
        .toString()

    /** Called by CallService.onDestroy (the FGS is being torn down): release the PC + tracks. Safe to call
     *  when already idle. */
    fun destroy() {
        callExecutor.execute { teardown() }
    }

    // ── reconnect backstop + failure ──────────────────────────────────────────────

    private fun armReconnectBackstop() {
        cancelReconnectBackstop()
        mainHandler.postDelayed(reconnectBackstop, CallFsm.reconnectBackstopDelayMs(isCaller))
    }

    private fun cancelReconnectBackstop() {
        mainHandler.removeCallbacks(reconnectBackstop)
    }

    /** End the active call as failed/ended: cancel any pending reconnect, flip the phase, POST /calls/end, and
     *  tear down locally (don't rely on the CALL_EVENT{ended} echo — the failure may be a dead network). Safe
     *  from any thread; the network + PC work hops to [callExecutor]. [teardown] is idempotent if the echo
     *  later lands. */
    private fun fail(reason: String) {
        cancelReconnectBackstop()
        val sid = callSid
        if (phase != "ended" && phase != "idle") { phase = "ended"; pushSnapshot() }
        if (sid == null) return
        callExecutor.execute { postEnd(sid, reason); teardown() }
    }

    /** ICE-restart renegotiation constraints: the initial offer's constraints + iceRestart=true (fresh ICE
     *  ufrag/pwd so a new gather supersedes the stale pair). The callee answers through the normal offer→answer
     *  path — no callee-side change. */
    private fun iceRestartConstraints(): MediaConstraints = offerAnswerConstraints().apply {
        mandatory.add(MediaConstraints.KeyValuePair("iceRestart", "true"))
    }

    // ── incoming-call wake-up (Phase 6) ───────────────────────────────────────────

    /** Seed the incoming call from the CALL_INCOMING FCM push (the killed/backgrounded path): set the snapshot
     *  (incl. [peerName], carried inline since a cold-started callee has no live SSE for CALL_EVENT{incoming}),
     *  flip to the incoming phase, ack alerting (POST /calls/ringing → the caller shows "Ringing…"), and start
     *  the ring. Idempotent: a no-op if this call is already incoming (the SSE path got there first); ignored
     *  if a different call is active (busy). Runs on the caller thread; the ring + the ringing POST are
     *  side-effect-safe there (POST hops to [callExecutor]). */
    fun seedIncoming(sid: String, callerUserId: Int, name: String, tid: Int, type: String) {
        if (phase != "idle") {
            if (callSid == sid) return // already ringing this call (SSE beat the push) — no-op
            return                      // a different call is live (busy) — ignore the stray push
        }
        callSid = sid
        threadId = tid
        peerUserId = callerUserId
        peerName = name
        callType = type
        isCaller = false
        phase = "incoming"
        startedAt = 0L
        iceRestartTried = false
        pushSnapshot()
        callExecutor.execute { postRinging(sid) } // ack alerting → the caller's UI shows "Ringing…"
        ringer.startRing()
    }

    // ── teardown + REST helpers ───────────────────────────────────────────────────

    /** Release the PC + tracks + audio source for the current call, and stop the [CallService] anchor
     *  (releases MODE_IN_COMMUNICATION + the wake lock + the ongoing notification). Leaves the factory
     *  (expensive, reused across calls). Idempotent — safe against the CallService.onDestroy →
     *  [destroy] → teardown re-entry (pc is already null on the second pass; stopService is a no-op when the
     *  service isn't running). */
    private fun teardown() {
        val connection = pc
        pc = null
        localAudioTrack?.dispose()
        localAudioTrack = null
        audioSource?.dispose()
        audioSource = null
        // Video teardown (capture/tracks/surfaces) lives in [video].
        video.tearDown()
        connection?.dispose()
        appContext?.stopService(Intent(appContext, CallService::class.java))
        if (phase != "ended") phase = "idle"
        callSid = null
        threadId = 0
        peerUserId = 0
        startedAt = 0L
        mediaState = "new"
        iceRestartTried = false
        peerName = ""
        ringer.stopRing()
        cancelReconnectBackstop()
        pendingOffer = null
        pendingIce.clear()
        pushSnapshot()
    }

    /** The origin native REST calls use — the ACTIVE origin (primary or the LAN secondary Kotlin switched
     *  to), so a call's signaling follows the same origin the SSE did (no origin split mid-call). */
    private fun activeOrigin(): String? = appContext?.let { SomsSecureStore.getActiveOrigin(it) }

    private fun token(): String? = appContext?.let { SomsSecureStore.getSessionToken(it) }

    /** GET /calls/ice-servers → the RTCConfiguration's iceServers (STUN + time-limited TURN REST creds;
     *  TURN is OFF in current SOMS, so this is often empty/STUN-only — never hardcode a STUN URL). */
    private fun fetchIceServers(): List<PeerConnection.IceServer> {
        val origin = activeOrigin() ?: return emptyList()
        val res = get("$origin${SomsSecureStore.API_PREFIX}/calls/ice-servers") ?: return emptyList()
        val arr = res.optJSONArray("iceServers") ?: return emptyList()
        val out = ArrayList<PeerConnection.IceServer>(arr.length())
        for (i in 0 until arr.length()) {
            val e = arr.getJSONObject(i)
            val builder = PeerConnection.IceServer.builder(listOf(*jsonStrings(e, "urls")))
            if (e.has("username")) builder.setUsername(e.getString("username"))
            if (e.has("credential")) builder.setPassword(e.getString("credential"))
            out.add(builder.createIceServer())
        }
        return out
    }

    private fun jsonStrings(obj: JSONObject, key: String): Array<String> = when (val v = obj.get(key)) {
        is String -> arrayOf(v)
        is JSONArray -> Array(v.length()) { v.getString(it) }
        else -> emptyArray()
    }

    private fun postSignal(callSid: String, toUserId: Int, kind: String, payload: String) {
        val origin = activeOrigin() ?: return
        post(
            "$origin${SomsSecureStore.API_PREFIX}/calls/signal",
            JSONObject()
                .put("callSid", callSid)
                .put("toUserId", toUserId)
                .put("kind", kind)
                .put("payload", payload),
        )
    }

    private fun postRinging(callSid: String) {
        val origin = activeOrigin() ?: return
        post("$origin${SomsSecureStore.API_PREFIX}/calls/ringing", JSONObject().put("callSid", callSid))
    }

    private fun postConnected(callSid: String) {
        val origin = activeOrigin() ?: return
        post("$origin${SomsSecureStore.API_PREFIX}/calls/connected", JSONObject().put("callSid", callSid))
    }

    private fun postEnd(callSid: String, reason: String) {
        val origin = activeOrigin() ?: return
        post(
            "$origin${SomsSecureStore.API_PREFIX}/calls/end",
            JSONObject().put("callSid", callSid).put("endReason", reason),
        )
    }

    /** POST JSON; returns the parsed `data` object on code 0, else null (logs the code). */
    private fun post(url: String, body: JSONObject): JSONObject? {
        val tok = token() ?: run { SomsLog.w(TAG) { "post $url: no token" }; return null }
        val req = Request.Builder()
            .url(url)
            .addHeader("Authorization", "Bearer $tok")
            .addHeader("Content-Type", "application/json")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()
        return exec(req)
    }

    /** GET with the bearer; returns the parsed `data` object on code 0. */
    private fun get(url: String): JSONObject? {
        val tok = token() ?: return null
        val req = Request.Builder()
            .url(url)
            .addHeader("Authorization", "Bearer $tok")
            .get()
            .build()
        return exec(req)
    }

    private fun exec(req: Request): JSONObject? = try {
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                SomsLog.w(TAG) { "${req.method} ${req.url.encodedPath} → ${resp.code}" }
                return null
            }
            val envelope = JSONObject(resp.body?.string().orEmpty())
            if (envelope.optInt("code", -1) != 0) {
                SomsLog.w(TAG) { "${req.url.encodedPath} biz code=${envelope.optInt("code")} msg=${envelope.optString("message")}" }
                return null
            }
            envelope.optJSONObject("data")
        }
    } catch (e: Exception) {
        SomsLog.w(TAG) { "${req.method} ${req.url.encodedPath} failed: ${e.message}" }
        null
    }

    /** Notified on a phase CHANGE (idle/incoming/…/ended) — registered by MainActivity to toggle the
     *  show-when-locked / turn-screen-on flags so an incoming ring surfaces over the lock screen. */
    @Volatile private var phaseListener: ((String) -> Unit)? = null
    fun setPhaseListener(listener: ((String) -> Unit)?) { phaseListener = listener }
    @Volatile private var lastNotifiedPhase: String = "idle"

    /** Push the current snapshot to the WebView so the Angular call UI (if attached) reflects a transition
     *  it can't get from the SSE path (media-state changes, phase transitions the native FSM owns). A no-op
     *  when no WebView is attached (SomsBridge.eval is a no-op); the next getSnapshot() catches it up. Also
     *  fires [phaseListener] on a phase change. */
    private fun pushSnapshot() {
        val p = phase
        SomsBridge.eval("window.__SOMS_CALL_EVENT__ && window.__SOMS_CALL_EVENT__(${snapshotJson()});")
        if (p != lastNotifiedPhase) { lastNotifiedPhase = p; phaseListener?.invoke(p) }
    }
}
