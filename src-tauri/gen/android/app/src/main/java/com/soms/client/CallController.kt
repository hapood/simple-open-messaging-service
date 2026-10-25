package com.soms.client

import android.content.Context
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.BuiltinAudioDecoderFactoryFactory
import org.webrtc.BuiltinAudioEncoderFactoryFactory
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.IceCandidate
import org.webrtc.IceCandidateErrorEvent
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.VideoTrack
import org.webrtc.SessionDescription.Type
import org.webrtc.audio.JavaAudioDeviceModule
import java.util.concurrent.Executors

/** Android media/OS adapter. Rust owns call state, signaling, timeouts and recovery. The immutable
 * snapshot below is a presentation mirror; SDK callbacks report facts with their original lease. */
object CallController : NativeCallCallbacks {
    private val appContext: Context? get() = SomsApplication.appContext
    private val mainHandler = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "SomsCallMedia") }
    private val snapshotLock = Any()
    @Volatile private var presentation = JSONObject().put("snapshot", JSONObject().put("phase", "idle"))
    private val state: JSONObject get() = presentation.getJSONObject("snapshot")
    private val lease: Long get() = presentation.optLong("lease")
    val callSid: String? get() = state.optString("callSid").takeIf { !state.isNull("callSid") && it.isNotEmpty() }
    val threadId: Int get() = state.optInt("threadId")
    val peerUserId: Int get() = state.optInt("peerUserId")
    val peerName: String get() = state.optString("peerName")
    val peerAvatar: String get() = state.optString("peerAvatar")
    val peerAccount: String get() = state.optString("peerAccount")
    val peerNamespaceId: Int get() = state.optInt("peerNamespaceId", -1)
    val callType: String get() = state.optString("callType", "AUDIO")
    val phase: String get() = state.optString("phase", "idle")
    val muted: Boolean get() = state.optBoolean("muted")
    val speakerEnabled: Boolean get() = state.optBoolean("speakerEnabled")

    private val ringer = CallRinger { appContext }
    private val video = VideoSurfaceManager { appContext }
    private var factory: PeerConnectionFactory? = null
    private var audioDeviceModule: org.webrtc.audio.AudioDeviceModule? = null
    @Volatile private var pc: PeerConnection? = null
    private var audioSource: AudioSource? = null
    private var audioTrack: AudioTrack? = null
    @Volatile private var mediaLease = 0L
    @Volatile private var mediaPeer = 0L
    private var mediaRound: String? = null
    private var localIce = CallSignaling.LocalIce()
    private var remoteSections = emptyList<CallSignaling.Section>()
    private val obsoleteRemoteUfrags = HashSet<String>()
    private val pendingIce = mutableListOf<String>()
    private val resources = NativeCallResourceCancellation(
        enqueue = { action -> executor.execute(action) }, currentOwner = { callSid },
        release = { releaseHost(mediaLease, callSid) },
    )
    @Volatile private var phaseListener: ((String) -> Unit)? = null

    init { RustCallBridge.bind(this) }

    fun captureSessionResourceRevision(): Long? = resources.admitWhileOpen { true }
    fun prepareSessionResourceRelease(): () -> Unit {
        val previous = lease
        val release = resources.prepare()
        return { RustCallBridge.detach(previous); release() }
    }
    fun whenSessionResourcesReleased(action: () -> Unit) {
        resources.whenReleased {
            mainHandler.post { if (resources.isClosing) whenSessionResourcesReleased(action) else action() }
        }
    }

    private fun dispatch(data: JSONObject, expected: Long = lease,
                         sessionUuid: String = presentation.optString("loginSessionId")): Boolean = try {
        val result = JSONObject(RustCallBridge.command(expected, data.put("loginSessionId", sessionUuid).toString()))
        adopt(result)
        result.optBoolean("accepted")
    } catch (error: Exception) {
        SomsLog.w("SomsCall") { "Rust call command rejected: ${error.javaClass.simpleName}" }
        false
    }
    private fun user(type: String, data: JSONObject = JSONObject()) {
        val target = presentation
        val expected = target.optLong("lease")
        val session = target.optString("loginSessionId")
        if (!data.has("callSid")) data.put("callSid", target.getJSONObject("snapshot").opt("callSid"))
        resources.execute { dispatch(data.put("type", type), expected, session) }
    }
    private fun fact(owner: Long, peer: Long, type: String, data: JSONObject = JSONObject()) {
        if (!RustCallBridge.isLive(owner)) return
        dispatch(data.put("type", type).put("peer", peer), owner)
    }

    override fun onCommand(command: String) {
        val value = JSONObject(command)
        val owner = value.getLong("lease")
        val kind = value.getString("command")
        // Cleanup is valid even after login admission has ended, but can only dispose its own resources.
        if (kind == "release") {
            val sid = value.optString("callSid")
            executor.execute { releaseHost(owner, sid) }
            return
        }
        if (kind == "snapshot") {
            executor.execute { adopt(value) }
            return
        }
        resources.execute {
            if (!RustCallBridge.isCurrent(owner) || kind != "rejected" && !RustCallBridge.isLive(owner)) return@execute
            val peer = value.optLong("peer")
            try {
                when (kind) {
                    "start-outgoing" -> appContext?.let { CallService.startOutgoing(it, callSid ?: return@let, owner) }
                    "ring" -> {
                        val snapshot = value.getJSONObject("snapshot")
                        if (!RustCallBridge.canRing(owner)) return@execute
                        ringer.startRing()
                        appContext?.let { CallService.startIncoming(it, snapshot.getString("callSid"),
                            snapshot.optString("peerAccount"), snapshot.optInt("peerNamespaceId", -1),
                            snapshot.getInt("threadId"), snapshot.getString("callType"),
                            snapshot.optString("peerName"), snapshot.optString("peerAvatar"), owner) }
                    }
                    "stop-ring" -> ringer.stopRing()
                    "accepted" -> {
                        ringer.stopRing()
                        val service = CallService.instance
                        if (service != null) mainHandler.post { if (RustCallBridge.isCurrent(owner)) service.onAccepted() }
                        else appContext?.let { CallService.startOutgoing(it, callSid ?: return@let, owner) }
                    }
                    "create-peer" -> createPeer(owner, peer, value)
                    "dispose-peer" -> if (mediaLease == owner && mediaPeer == peer) disposeMedia()
                    "create-offer" -> createOffer(owner, peer, value)
                    "apply-offer" -> applyOffer(owner, peer, value)
                    "apply-answer" -> applyAnswer(owner, peer, value)
                    "ice" -> if (mediaLease == owner && mediaPeer == peer) applyIce(value.getString("payload"))
                    "mute" -> audioTrack?.setEnabled(!value.getBoolean("enabled"))
                    "speaker" -> mainHandler.post { if (RustCallBridge.isCurrent(owner)) CallService.instance?.setSpeakerEnabled(value.getBoolean("enabled")) }
                    "camera" -> {
                        val connection = pc ?: throw IllegalStateException("no media peer")
                        val enabled = value.getBoolean("enabled")
                        val existingTrack = video.hasLocalVideoTrack()
                        val ok = if (!enabled) { video.setCameraEnabled(false); true }
                            else if (existingTrack) { video.setCameraEnabled(true); true }
                            else video.setupVideoCapture(ensureFactory(), connection)
                        fact(owner, peer, "camera-ready", JSONObject().put("enabled", enabled && ok).put("ok", ok).put("trackCreated", enabled && ok && !existingTrack))
                    }
                    "rejected" -> SomsBridge.eval("window.__SOMS_CALL_REJECTED__ && window.__SOMS_CALL_REJECTED__('busy');")
                }
            } catch (error: Exception) {
                if (kind == "camera") fact(owner, peer, "camera-ready", JSONObject().put("enabled", false).put("ok", false))
                else fact(owner, peer, "media-error", JSONObject().put("stage", kind))
            }
        }
    }

    private fun adopt(envelope: JSONObject) {
        if (!envelope.has("snapshot")) return
        val owner = envelope.optLong("lease")
        val next = envelope.getJSONObject("snapshot")
        val cleanup = owner == lease && next.optString("phase") in setOf("idle", "ended")
        if (!cleanup && !RustCallBridge.isCurrent(owner)) return
        val previous = synchronized(snapshotLock) {
            if (envelope.optLong("revision") <= presentation.optLong("revision")) return
            val old = phase
            presentation = envelope
            old
        }
        publishPresentation()
        if (previous != phase) phaseListener?.invoke(phase)
    }
    private fun publishPresentation() {
        SomsBridge.eval("window.__SOMS_CALL_EVENT__ && window.__SOMS_CALL_EVENT__(${snapshotJson()});")
        mainHandler.post { CallService.instance?.refreshForPhase() }
    }
    fun snapshotJson(): String = JSONObject(state.toString()).put("swapped", video.swapped).toString()
    fun setPhaseListener(listener: ((String) -> Unit)?) { phaseListener = listener }

    fun initiate(targetThreadId: Int, sid: String, type: String, account: String, namespaceId: Int,
                 resourceRevision: Long, sessionUuid: String): Boolean {
        if (resources.admitWhileOpen(resourceRevision) { true } == null) return false
        return dispatch(JSONObject().put("type", "initiate").put("callSid", sid).put("threadId", targetThreadId)
            .put("callType", type).put("peerAccount", account).put("peerNamespaceId", namespaceId), sessionUuid = sessionUuid)
    }
    fun seedIncoming(sid: String, callerUserId: Int, account: String, namespaceId: Int,
                     tid: Int, type: String, source: String, sessionUuid: String) {
        resources.execute { dispatch(JSONObject().put("type", "incoming").put("callSid", sid)
            .put("peerUserId", callerUserId).put("peerAccount", account).put("peerNamespaceId", namespaceId)
            .put("threadId", tid).put("callType", type).put("source", source), sessionUuid = sessionUuid) }
    }
    fun onFrame(type: String, data: String, sessionUuid: String) {
        // Server facts already identify their login and call. The presentation mirror may
        // still show the previous lease while the incoming command waits in this queue.
        resources.execute { dispatch(JSONObject().put("type", "frame").put("event", type)
            .put("data", JSONObject(data)), 0L, sessionUuid) }
    }
    fun accept(sid: String) = user("accept", JSONObject().put("callSid", sid))
    fun decline(sid: String) = user("decline", JSONObject().put("callSid", sid))
    fun cancel(sid: String) = user("cancel", JSONObject().put("callSid", sid))
    fun end(sid: String, reason: String?) = user("end", JSONObject().put("callSid", sid).put("reason", reason))
    fun signal(sid: String, kind: String, payload: String) = user("signal", JSONObject().put("callSid", sid).put("kind", kind).put("payload", payload))
    fun upgradeToVideo() = user("upgrade")
    fun videoUpgradePermissionDenied() = user("permission-denied")
    fun setCameraEnabled(enabled: Boolean) = user("camera", JSONObject().put("enabled", enabled))
    fun setMuted(value: Boolean) = user("mute", JSONObject().put("enabled", value))
    fun setSpeakerEnabled(value: Boolean) = user("speaker", JSONObject().put("enabled", value))
    fun destroy(ownerCallSid: String?) { if (!ownerCallSid.isNullOrEmpty()) user("destroy", JSONObject().put("callSid", ownerCallSid)) }

    fun switchCamera() = video.switchCamera()
    fun hasLocalVideoTrack(): Boolean = video.hasLocalVideoTrack()
    fun setVideoRect(remoteRect: String?, selfRect: String?) = video.setVideoRect(remoteRect, selfRect)
    fun setSelfVideoPosition(x: Double, y: Double) = video.setSelfVideoPosition(x, y)
    fun setSystemPipMode(enabled: Boolean) = video.setSystemPipMode(enabled)
    fun remoteVideoSurfaceRect(): Rect? = video.remoteSurfaceRect()
    fun setVideoGeometryListener(listener: (() -> Unit)?) = video.setGeometryListener(listener)
    fun swapVideo() { if (video.swapVideo()) publishPresentation() }
    fun remoteVideoDimensions(): Pair<Int, Int>? = video.remoteDimensions()
    fun onWebViewGone() = video.onWebViewGone()

    private fun ensureFactory(): PeerConnectionFactory {
        factory?.let { return it }
        val ctx = appContext ?: throw IllegalStateException("no app context")
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(ctx).createInitializationOptions())
        val adm = JavaAudioDeviceModule.builder(ctx).createAudioDeviceModule()
        audioDeviceModule = adm
        return PeerConnectionFactory.builder().setAudioDeviceModule(adm)
            .setAudioEncoderFactoryFactory(BuiltinAudioEncoderFactoryFactory())
            .setAudioDecoderFactoryFactory(BuiltinAudioDecoderFactoryFactory())
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(video.eglBase().eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(video.eglBase().eglBaseContext))
            .createPeerConnectionFactory().also { factory = it }
    }
    private fun createPeer(owner: Long, peer: Long, command: JSONObject) {
        disposeMedia()
        mediaLease = owner; mediaPeer = peer
        val ice = command.optJSONArray("iceServers") ?: JSONArray()
        val servers = ArrayList<PeerConnection.IceServer>()
        for (index in 0 until ice.length()) {
            val server = ice.getJSONObject(index)
            val urls = when (val raw = server.get("urls")) {
                is String -> listOf(raw)
                is JSONArray -> List(raw.length()) { raw.getString(it) }
                else -> emptyList()
            }
            val builder = PeerConnection.IceServer.builder(urls)
            if (server.has("username")) builder.setUsername(server.getString("username"))
            if (server.has("credential")) builder.setPassword(server.getString("credential"))
            servers.add(builder.createIceServer())
        }
        val config = PeerConnection.RTCConfiguration(servers).apply {
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val factory = ensureFactory()
        var owned: PeerConnection? = null
        val connection = factory.createPeerConnection(config, observer(owner, peer) { owned })
            ?: throw IllegalStateException("createPeerConnection returned null")
        owned = connection; pc = connection
        val source = factory.createAudioSource(MediaConstraints().apply {
            listOf("googEchoCancellation", "googAutoGainControl", "googNoiseSuppression", "googHighpassFilter")
                .forEach { mandatory.add(MediaConstraints.KeyValuePair(it, "true")) }
        })
        audioSource = source
        val track = factory.createAudioTrack("ARDAMSa0", source)
        audioTrack = track
        connection.addTrack(track, listOf("ARDAMS"))
        val camera = command.optBoolean("video") && video.setupVideoCapture(factory, connection)
        fact(owner, peer, "peer-ready", JSONObject().put("cameraEnabled", camera))
    }
    private fun alive(connection: PeerConnection, owner: Long, peer: Long): Boolean =
        !resources.isClosing && pc === connection && mediaLease == owner && mediaPeer == peer && RustCallBridge.isLive(owner)

    private fun observer(owner: Long, peer: Long, owned: () -> PeerConnection?) = object : PeerConnection.Observer {
        private val ice = localIce
        override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {}
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {
            val connection = owned() ?: return
            if (state != PeerConnection.IceGatheringState.COMPLETE || !alive(connection, owner, peer)) return
            val sdp = connection.localDescription?.description ?: return
            for (candidate in ice.gathered(sdp)) candidate(connection, candidate.candidate, candidate.mid, candidate.index, candidate.ufrag)
        }
        private fun candidate(connection: PeerConnection, value: String, mid: String?, index: Int, ufrag: String) {
            resources.execute {
                if (!alive(connection, owner, peer) || !ice.claim(value, mid, index, ufrag)) return@execute
                val payload = JSONObject().put("candidate", value).put("sdpMid", mid ?: JSONObject.NULL)
                    .put("sdpMLineIndex", index).put("usernameFragment", ufrag)
                fact(owner, peer, "local-ice", JSONObject().put("payload", payload.toString()))
            }
        }
        override fun onIceCandidate(value: IceCandidate) {
            val connection = owned() ?: return
            if (!alive(connection, owner, peer)) return
            val ufrag = ice.identify(value.sdp, value.sdpMid, value.sdpMLineIndex) ?: return
            candidate(connection, value.sdp, value.sdpMid, value.sdpMLineIndex, ufrag)
        }
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
        override fun onIceCandidateError(event: IceCandidateErrorEvent?) {}
        override fun onAddStream(stream: MediaStream?) {}
        override fun onRemoveStream(stream: MediaStream?) {}
        override fun onDataChannel(dc: DataChannel?) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {
            val connection = owned() ?: return
            val track = receiver?.track()
            if (track is VideoTrack) resources.execute { if (alive(connection, owner, peer)) video.onRemoteTrack(track) }
        }
        override fun onConnectionChange(state: PeerConnection.PeerConnectionState?) {
            val connection = owned() ?: return
            val name = state?.name?.lowercase() ?: return
            resources.execute { if (alive(connection, owner, peer)) fact(owner, peer, "connection", JSONObject().put("state", name)) }
        }
    }

    private fun constraints(video: Boolean, restart: Boolean = false) = MediaConstraints().apply {
        mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))
        mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", video.toString()))
        if (restart) mandatory.add(MediaConstraints.KeyValuePair("iceRestart", "true"))
    }
    private fun createOffer(owner: Long, peer: Long, command: JSONObject) {
        val connection = pc ?: throw IllegalStateException("no peer")
        check(alive(connection, owner, peer) && connection.signalingState() == PeerConnection.SignalingState.STABLE)
        val id = command.getString("id"); mediaRound = id
        if (command.optBoolean("restart")) connection.restartIce()
        connection.createOffer(description(connection, owner, peer, id, true), constraints(command.optBoolean("video"), command.optBoolean("restart")))
    }
    private fun applyOffer(owner: Long, peer: Long, command: JSONObject) {
        val connection = pc ?: throw IllegalStateException("no peer")
        check(alive(connection, owner, peer) && connection.signalingState() == PeerConnection.SignalingState.STABLE)
        val id = command.getString("id"); mediaRound = id
        remote(connection, owner, peer, id, Type.OFFER, command.getString("payload")) {
            connection.createAnswer(description(connection, owner, peer, id, false), constraints(command.optBoolean("video")))
        }
    }
    private fun applyAnswer(owner: Long, peer: Long, command: JSONObject) {
        val connection = pc ?: throw IllegalStateException("no peer")
        val id = command.getString("id")
        check(alive(connection, owner, peer) && mediaRound == id && connection.signalingState() == PeerConnection.SignalingState.HAVE_LOCAL_OFFER)
        val sdp = command.getString("payload")
        remote(connection, owner, peer, id, Type.ANSWER, sdp) {
            check(connection.signalingState() == PeerConnection.SignalingState.STABLE)
            val negotiated = CallSignaling.videoNegotiated(connection.localDescription?.description.orEmpty(), sdp,
                command.optBoolean("sending"), command.optBoolean("receiving"))
            mediaRound = null
            fact(owner, peer, "answer-applied", JSONObject().put("id", id).put("videoNegotiated", negotiated))
        }
    }
    private fun remote(connection: PeerConnection, owner: Long, peer: Long, id: String, type: Type, sdp: String, next: () -> Unit) {
        connection.setRemoteDescription(object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription?) {}
            override fun onCreateFailure(error: String?) {}
            override fun onSetSuccess() = resources.execute {
                if (!alive(connection, owner, peer) || mediaRound != id) return@execute
                val sections = CallSignaling.sections(sdp)
                val ufrags = sections.mapNotNull { it.ufrag }.toSet()
                obsoleteRemoteUfrags.addAll(remoteSections.mapNotNull { it.ufrag }.filter { it !in ufrags })
                obsoleteRemoteUfrags.removeAll(ufrags); remoteSections = sections
                val buffered = pendingIce.toList(); pendingIce.clear(); buffered.forEach { applyIce(it) }
                try { next() } catch (_: Exception) { fact(owner, peer, "media-error") }
            }
            override fun onSetFailure(error: String?) = resources.execute {
                if (alive(connection, owner, peer) && mediaRound == id) fact(owner, peer, "media-error")
            }
        }, SessionDescription(type, sdp))
    }
    private fun description(connection: PeerConnection, owner: Long, peer: Long, id: String, offering: Boolean) = object : SdpObserver {
        private fun current() = alive(connection, owner, peer) && mediaRound == id
        override fun onCreateSuccess(sdp: SessionDescription?) = resources.execute {
            if (!current()) return@execute
            if (sdp == null) { fact(owner, peer, "media-error"); return@execute }
            localIce.remember(sdp.description)
            connection.setLocalDescription(object : SdpObserver {
                override fun onCreateSuccess(sdp: SessionDescription?) {}
                override fun onCreateFailure(error: String?) {}
                override fun onSetSuccess() = resources.execute published@{
                    if (!current()) return@published
                    val expected = if (offering) PeerConnection.SignalingState.HAVE_LOCAL_OFFER else PeerConnection.SignalingState.STABLE
                    if (connection.signalingState() != expected) { fact(owner, peer, "media-error"); return@published }
                    if (!offering) mediaRound = null
                    fact(owner, peer, if (offering) "offer-ready" else "answer-ready", JSONObject().put("id", id).put("payload", sdp.description))
                }
                override fun onSetFailure(error: String?) = resources.execute { if (current()) fact(owner, peer, "media-error") }
            }, sdp)
        }
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String?) = resources.execute { if (current()) fact(owner, peer, "media-error") }
        override fun onSetFailure(error: String?) = resources.execute { if (current()) fact(owner, peer, "media-error") }
    }
    private fun applyIce(payload: String) {
        val connection = pc ?: return
        val data = runCatching { JSONObject(payload) }.getOrNull() ?: return
        val allowed = setOf("candidate", "sdpMid", "sdpMLineIndex", "usernameFragment")
        val lineIndex = data.opt("sdpMLineIndex")
        val validIndex = lineIndex == null || lineIndex == JSONObject.NULL || lineIndex is Number && lineIndex.toDouble() in 0.0..65535.0 && lineIndex.toDouble() % 1.0 == 0.0
        if (data.keys().asSequence().any { it !in allowed } || !validIndex ||
            data.has("candidate") && data.opt("candidate") !is String ||
            data.has("sdpMid") && !data.isNull("sdpMid") && data.opt("sdpMid") !is String ||
            data.opt("usernameFragment") !is String || !CallSignaling.validIceUfrag(data.getString("usernameFragment"))) return
        val mid = data.optString("sdpMid").takeIf { !data.isNull("sdpMid") && data.has("sdpMid") }
        val index = if (data.has("sdpMLineIndex") && !data.isNull("sdpMLineIndex")) data.getInt("sdpMLineIndex") else -1
        val ufrag = data.getString("usernameFragment")
        when (CallSignaling.remoteIce(remoteSections, obsoleteRemoteUfrags, ufrag, mid, index)) {
            CallSignaling.IceDecision.BUFFER -> { if (payload.length <= 16_384 && pendingIce.size < 256) pendingIce.add(payload); return }
            CallSignaling.IceDecision.DROP -> return
            CallSignaling.IceDecision.APPLY -> {}
        }
        val embedded = CallSignaling.candidateUfrag(data.optString("candidate"))
        if (embedded != null && embedded != ufrag) return
        connection.addIceCandidate(IceCandidate(mid, index, data.optString("candidate")))
    }
    private fun disposeMedia() {
        val previous = pc; pc = null
        audioTrack?.dispose(); audioTrack = null
        audioSource?.dispose(); audioSource = null
        video.tearDown(); previous?.dispose()
        mediaRound = null; localIce = CallSignaling.LocalIce()
        remoteSections = emptyList(); obsoleteRemoteUfrags.clear(); pendingIce.clear()
    }
    private fun releaseHost(owner: Long, sid: String?) {
        if (mediaLease == owner) disposeMedia()
        if (lease <= owner) ringer.stopRing()
        mainHandler.post { if (sid != null) CallService.instance?.stopOwned(sid) }
    }
}
