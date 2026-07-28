package com.soms.client

import android.content.Context
import android.graphics.Color
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.EglBase
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SurfaceTextureHelper
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoCapturer
import org.webrtc.VideoFrame
import org.webrtc.VideoSink
import org.webrtc.VideoSource
import org.webrtc.VideoTrack

/**
 * Owns the VIDEO half of a 1:1 call: the EGL base, the camera capture + local track, the remote track, the
 * two sibling-of-the-WebView [SurfaceViewRenderer] overlays (the barcode-scanner technique), the self↔peer
 * swap, and the surface rect positioning. Extracted from [CallController] so the FSM owns transitions + this
 * owns the surface/sink mechanics (it was ~250 lines of view + WebRTC glue in the FSM object).
 *
 * The WebView is transparent over the native surfaces (CallController sets the WebView background transparent
 * while a video call is active); this manager positions the surfaces over the transparent "holes" the Angular
 * chrome reports via [setVideoRect]. See [[webrtc-android-video-surface-gotchas]] for the two non-obvious
 * runtime traps handled here: the two-SurfaceView z-order (self = media overlay) + the track→renderer sink
 * race ([relinkVideoSinks] called from every arrival point).
 *
 * Not a singleton — [CallController] holds one instance for the process. Thread-safe where it must be:
 * [relinkVideoSinks] is @Synchronized; view ops hop to [mainHandler]; track/sink fields are @Volatile.
 *
 * @param contextProvider lazily yields the app context (the FSM outlives any Activity — reads
 * [SomsApplication.appContext]).
 */
class VideoSurfaceManager(private val contextProvider: () -> Context?) {

    /** Shared EGL base for the renderers + the capture SurfaceTextureHelper. Lazy (audio calls skip it). */
    @Volatile private var eglBase: EglBase? = null
    @Volatile private var videoCapturer: VideoCapturer? = null
    @Volatile private var videoSource: VideoSource? = null
    @Volatile private var localVideoTrack: VideoTrack? = null
    /** The peer's inbound video track (stored in [onRemoteTrack], sunk to a renderer by [relinkVideoSinks]
     *  once the renderer is mounted). Not disposed here (the PC owns it). */
    @Volatile private var remoteVideoTrack: VideoTrack? = null
    /** Self↔remote swap (tap the self PiP): when true the LOCAL camera renders full-bleed + the peer's in the
     *  PiP (mirrors follow in [relinkVideoSinks]). */
    @Volatile var swapped = false
        private set
    private var captureThreadHelper: SurfaceTextureHelper? = null
    /** Remote video renderer — full-bleed sibling behind the (transparent) WebView. Null until [setVideoRect]. */
    @Volatile private var remoteRenderer: SurfaceViewRenderer? = null
    /** Local-camera (self-view) renderer — a small positioned sibling above the WebView (media-overlay z). */
    @Volatile private var selfRenderer: SurfaceViewRenderer? = null
    /** Rect presence is independent for each renderer. In particular Android PiP hides the self surface while
     *  keeping the remote surface alive; CSS cannot hide these sibling-of-WebView native views. */
    @Volatile private var remoteVisible = false
    @Volatile private var selfVisible = false
    /** System Activity PiP suppresses the in-app self surface without discarding its requested layout. */
    @Volatile private var systemPipMode = false
    /** The self renderer's committed layout origin in device px. Drag frames use translation relative to this
     *  stable base; pointer-up commits the final rect and resets translation to zero. */
    @Volatile private var selfBaseX = 0
    @Volatile private var selfBaseY = 0
    /** The WebView's saved background, restored on detach (the overlay sets it TRANSPARENT while video is up). */
    private var savedWebViewBg: android.graphics.drawable.Drawable? = null
    /** The last remote frame dimensions, tracked by [dimensionsSink] so PiP can size its window to the video
     *  (not the screen — avoids letterboxing). 0 until the first remote frame. */
    @Volatile private var remoteWidth = 0
    @Volatile private var remoteHeight = 0
    /** A passive sink on the remote track that records the frame dimensions (for [remoteDimensions]). Separate
     *  from the renderer sinks so [relinkVideoSinks]'s detach/reattach never touches it. */
    private val dimensionsSink = VideoSink { frame ->
        val f = frame ?: return@VideoSink
        if (f.rotatedWidth != remoteWidth || f.rotatedHeight != remoteHeight) {
            remoteWidth = f.rotatedWidth
            remoteHeight = f.rotatedHeight
            mainHandler.post { geometryListener?.invoke() }
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var geometryListener: (() -> Unit)? = null

    /** Lazily create the shared EGL base once (reused across calls + borrowed by the PeerConnectionFactory's
     *  video encode/decode factories via [eglBase]). */
    fun eglBase(): EglBase {
        eglBase?.let { return it }
        val base = EglBase.create()
        eglBase = base
        return base
    }

    /** Create the front-camera capturer + a local VideoTrack + add it to the PC (the self-view renderer
     *  attaches in [setVideoRect] when the WebView reports its hole rects). AUDIO calls skip this. */
    fun setupVideoCapture(factory: PeerConnectionFactory, connection: PeerConnection): Boolean {
        if (localVideoTrack != null) {
            localVideoTrack?.setEnabled(true)
            return true
        }
        val ctx = contextProvider() ?: return false
        val base = eglBase()
        val enumerator = Camera2Enumerator(ctx)
        val names = enumerator.deviceNames
        var name: String? = null
        for (n in names) if (enumerator.isFrontFacing(n)) { name = n; break }
        if (name == null && names.isNotEmpty()) name = names[0]
        val deviceName = name ?: run {
            SomsLog.w(TAG) { "no camera device" }
            return false
        }
        val capturer = enumerator.createCapturer(deviceName, CameraEventsHandler)
        videoCapturer = capturer
        val helper = SurfaceTextureHelper.create("SomsCapture", base.eglBaseContext)
        captureThreadHelper = helper
        val source = factory.createVideoSource(false /* isScreencast — camera capture */)
        videoSource = source
        capturer.initialize(helper, ctx, source.capturerObserver)
        try {
            capturer.startCapture(640, 480, 30)
        } catch (e: Exception) {
            SomsLog.w(TAG) { "startCapture failed: ${e.message}" }
        }
        val vtrack = factory.createVideoTrack("ARDAMSv0", source)
        localVideoTrack = vtrack
        connection.addTrack(vtrack)
        relinkVideoSinks() // the self renderer may already be mounted (ensureRenderers raced ahead) — sink now
        return true
    }

    /** Flip front↔back camera (WhatsApp/FaceTime). */
    fun switchCamera() {
        (videoCapturer as? CameraVideoCapturer)?.switchCamera(null)
    }

    /** Camera on/off (mute video, keep audio). */
    fun setCameraEnabled(enabled: Boolean) {
        localVideoTrack?.setEnabled(enabled)
    }

    fun hasLocalVideoTrack(): Boolean = localVideoTrack != null

    fun isCameraEnabled(): Boolean = localVideoTrack?.enabled() == true

    /** The remote video's frame dimensions (rotated), or null until the first frame — for PiP aspect sizing. */
    fun remoteDimensions(): Pair<Int, Int>? =
        if (remoteWidth > 0 && remoteHeight > 0) remoteWidth to remoteHeight else null

    /** Store the peer's inbound video track (from the PC's onAddTrack) + sink it once the renderer mounts. The
     *  dimensions probe is attached here (once) so [remoteDimensions] is populated as soon as frames flow. */
    fun onRemoteTrack(track: VideoTrack) {
        SomsLog.d(TAG) { "onRemoteTrack: peer video track arrived" }
        remoteVideoTrack = track
        runCatching { track.addSink(dimensionsSink) }
        relinkVideoSinks()
    }

    /** Mount/position the remote + self video surfaces as siblings of the WebView, OR detach (both rects
     *  null). `remoteRect`/`selfRect` are JSON `{x,y,w,h}` in CSS px the WebView reports; null hides them.
     *  Runs on the UI thread (the renderers are Views + addView touches the view tree). */
    fun setVideoRect(remoteRect: String?, selfRect: String?) {
        mainHandler.post {
            val v = SomsBridge.webView ?: return@post
            if (remoteRect == null && selfRect == null) { detachVideoSurfaces(v); return@post }
            ensureRenderers(v)
            val nextRemoteVisible = remoteRect != null
            val nextSelfVisible = selfRect != null
            val visibilityChanged =
                nextRemoteVisible != remoteVisible || nextSelfVisible != selfVisible
            remoteVisible = nextRemoteVisible
            selfVisible = nextSelfVisible
            remoteRenderer?.visibility = if (remoteVisible) View.VISIBLE else View.GONE
            selfRenderer?.visibility = if (selfVisible && !systemPipMode) View.VISIBLE else View.GONE
            positionRemote(v, remoteRect)
            positionSelf(v, selfRect)
            // Position-only updates must never detach/reattach video sinks. Relink only when the physical
            // target set changes (mount/show/hide, notably entering/leaving Android system PiP).
            if (visibilityChanged) relinkVideoSinks()
        }
    }

    /** Native-first system PiP switch: media surfaces change before the disposable Web chrome catches up. */
    fun setSystemPipMode(enabled: Boolean) {
        val update = update@ {
            if (systemPipMode == enabled) return@update
            systemPipMode = enabled
            selfRenderer?.visibility = if (selfVisible && !enabled) View.VISIBLE else View.GONE
            relinkVideoSinks()
        }
        if (Looper.myLooper() == Looper.getMainLooper()) update()
        else mainHandler.post { update() }
    }

    fun setGeometryListener(listener: (() -> Unit)?) {
        geometryListener = listener
    }

    /** Current remote video bounds in screen coordinates for PictureInPictureParams.sourceRectHint. */
    fun remoteSurfaceRect(): Rect? {
        val renderer = remoteRenderer ?: return null
        if (!remoteVisible || renderer.visibility != View.VISIBLE) return null
        return Rect().takeIf { renderer.getGlobalVisibleRect(it) && !it.isEmpty }
    }

    /** High-frequency drag path. Move the already-mounted self renderer with a compositor translation only:
     *  no JSON, layoutParams, view-tree layout, or track↔sink relink. Coordinates are absolute CSS px; the
     *  translation is relative to the last rect committed by [positionSelf]. */
    fun setSelfVideoPosition(xCss: Double, yCss: Double) {
        mainHandler.post {
            val webView = SomsBridge.webView ?: return@post
            val self = selfRenderer ?: return@post
            if (!selfVisible) return@post
            val d = webView.context.resources.displayMetrics.density
            self.translationX = (xCss * d).toFloat() - selfBaseX
            self.translationY = (yCss * d).toFloat() - selfBaseY
        }
    }

    /** Create the two SurfaceViewRenderer siblings + sink the local track to the self renderer. Idempotent.
     *  Remote is added first (BEHIND the WebView — it is transparent over it); the self renderer is a media
     *  overlay ABOVE the remote (so the self PiP floats over the peer's video), still below the transparent
     *  WebView. Both renderers are SurfaceViews — separate hardware-composited layers whose RELATIVE z-order
     *  is NOT guaranteed when both are left at the default (bottom) layer: SurfaceFlinger orders them per
     *  device/Android version, and on newer Android (reproduced on a Huawei DBY-W09 / API 31) the full-screen
     *  remote composited ABOVE the small self, hiding it entirely (the same two views rendered fine on an
     *  Android 9 device). setZOrderMediaOverlay(true) on the self surface forces it above the remote media
     *  layer regardless of version — the standard AppRTCMobile self-view pattern. Must be set BEFORE addView
     *  (the surface is allocated on attach; the z-order is fixed then). */
    private fun ensureRenderers(webView: WebView) {
        if (remoteRenderer != null) return
        val parent = webView.parent as? ViewGroup ?: return
        val base = eglBase()
        val density = webView.context.resources.displayMetrics.density
        val remote = SurfaceViewRenderer(webView.context).apply {
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        remote.init(base.eglBaseContext, null)
        parent.addView(remote, 0) // default z-order (bottom media layer) → behind the WebView (transparent over it)
        val self = SurfaceViewRenderer(webView.context).apply {
            layoutParams = FrameLayout.LayoutParams((120 * density).toInt(), (160 * density).toInt())
        }
        self.init(base.eglBaseContext, null)
        self.setMirror(true) // front-camera mirror, like the mainstream self-view
        self.setZOrderMediaOverlay(true) // force the self surface above the remote media layer (version-safe)
        parent.addView(self)
        remoteRenderer = remote
        selfRenderer = self
        SomsLog.d(TAG) { "ensureRenderers: mounted remote+self SurfaceViewRenderers" }
        webView.bringToFront()
        if (savedWebViewBg == null) { savedWebViewBg = webView.background; webView.setBackgroundColor(Color.TRANSPARENT) }
        relinkVideoSinks() // sink local→PiP + remote→full per the swap state (whichever halves now exist)
    }

    /** (Re)wire the video sinks for whichever track + renderer halves exist RIGHT NOW, honoring [swapped].
     *  Called whenever EITHER half appears — the renderers mount in [ensureRenderers], the local track is
     *  created in [setupVideoCapture], the remote track is signaled in [onRemoteTrack], and the mapping flips
     *  on [swapVideo] — so the arrival order is irrelevant: a sink lands the instant both halves of a pair
     *  exist. This fixes the race where ensureRenderers ran before setupVideoCapture created the local track
     *  (so `localVideoTrack` was null → addSink was a no-op → the self renderer rendered 0 frames, observed as
     *  an empty self-view box). Each call fully detaches then re-attaches (swap-safe; addSink is a de-duplicated
     *  set, the remove is belt-and-braces so a flip leaves no stale mapping). Thread-safe — VideoTrack
     *  add/removeSink + SurfaceViewRenderer.setMirror are all safe off-main. */
    @Synchronized
    fun relinkVideoSinks() {
        val local = localVideoTrack
        val remote = remoteVideoTrack
        val rawBig = remoteRenderer
        val rawPip = selfRenderer
        val big = rawBig?.takeIf { remoteVisible } // full-bleed surface (behind the WebView)
        val effectiveSelfVisible = selfVisible && !systemPipMode
        val pip = rawPip?.takeIf { effectiveSelfVisible } // PiP overlay surface (media-overlay)
        SomsLog.d(TAG) { "relink: local=${local != null} remote=${remote != null} big=${big != null} pip=${pip != null} swapped=$swapped" }
        // Always detach from BOTH physical renderers before selecting the visible targets. A renderer that
        // just changed to GONE is intentionally absent from `big`/`pip`, but may still hold the old sink.
        if (local != null) { rawBig?.let { local.removeSinkSafe(it) }; rawPip?.let { local.removeSinkSafe(it) } }
        if (remote != null) { rawBig?.let { remote.removeSinkSafe(it) }; rawPip?.let { remote.removeSinkSafe(it) } }
        // Default: local→PiP (self-view), remote→big (peer full-bleed). Swapped: local→big, remote→PiP.
        // With no PiP renderer (Android system PiP), always show the peer in the remaining big renderer.
        // Preserve `swapped` itself so leaving system PiP restores the user's prior in-app mapping.
        val (localTarget, remoteTarget) =
            if (!effectiveSelfVisible) null to big
            else if (swapped) big to pip
            else pip to big
        local?.let { l -> localTarget?.let { l.addSinkSafe(it, "local") } }
        remote?.let { r -> remoteTarget?.let { r.addSinkSafe(it, "remote") } }
        big?.setMirror(effectiveSelfVisible && swapped) // system PiP forces remote→big; never mirror peer
        pip?.setMirror(!swapped)    // pip shows the local cam ⇔ !swapped
    }

    private fun VideoTrack.addSinkSafe(r: SurfaceViewRenderer, label: String) =
        runCatching { addSink(r) }.onFailure { SomsLog.w(TAG, it) { "addSink $label failed" } }
    private fun VideoTrack.removeSinkSafe(r: SurfaceViewRenderer) =
        runCatching { removeSink(r) }.onFailure { SomsLog.w(TAG, it) { "removeSink failed" } }

    /** Swap which video is full-bleed vs PiP (tap the self PiP): flips [swapped] + re-sinks so the local
     *  camera renders full-bleed and the peer's in the PiP (mirrors follow). The surfaces + z-order stay put;
     *  only the track→renderer mapping + the mirror flip. No-op if no video surfaces are mounted. Fires a
     *  view-level haptic (no VIBRATE permission; respects the system haptic setting). */
    fun swapVideo() {
        if (remoteRenderer == null && selfRenderer == null) return
        swapped = !swapped
        relinkVideoSinks()
        mainHandler.post { SomsBridge.webView?.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY) }
    }

    /** Reposition the self renderer to the reported CSS rect (× density → device px). */
    private fun positionSelf(webView: WebView, selfRect: String?) {
        val r = selfRect ?: return
        val self = selfRenderer ?: return
        try {
            val o = org.json.JSONObject(r)
            val d = webView.context.resources.displayMetrics.density
            val lp = FrameLayout.LayoutParams(
                (o.optDouble("w", 120.0) * d).toInt(),
                (o.optDouble("h", 160.0) * d).toInt(),
            )
            selfBaseX = (o.optDouble("x", 0.0) * d).toInt()
            selfBaseY = (o.optDouble("y", 0.0) * d).toInt()
            lp.setMargins(selfBaseX, selfBaseY, 0, 0)
            self.layoutParams = lp
            self.translationX = 0f
            self.translationY = 0f
        } catch (e: Exception) {
            SomsLog.w(TAG) { "setVideoRect parse: ${e.message}" }
        }
    }

    /** Position the remote renderer to the reported CSS rect. The current UI reports full viewport, but
     *  honoring the bridge contract keeps split-screen, foldables, and future non-fullscreen layouts correct. */
    private fun positionRemote(webView: WebView, remoteRect: String?) {
        val r = remoteRect ?: return
        val remote = remoteRenderer ?: return
        try {
            val o = org.json.JSONObject(r)
            val d = webView.context.resources.displayMetrics.density
            val lp = FrameLayout.LayoutParams(
                (o.optDouble("w", (webView.width / d).toDouble()) * d).toInt(),
                (o.optDouble("h", (webView.height / d).toDouble()) * d).toInt(),
            )
            lp.setMargins(
                (o.optDouble("x", 0.0) * d).toInt(),
                (o.optDouble("y", 0.0) * d).toInt(),
                0,
                0,
            )
            remote.layoutParams = lp
            // Wait until ViewRoot commits the new bounds; sourceRectHint must describe the actual Surface,
            // not the previous layout pass.
            remote.post { geometryListener?.invoke() }
        } catch (e: Exception) {
            SomsLog.w(TAG) { "set remote video rect parse: ${e.message}" }
        }
    }

    /** Remove the renderers + restore the WebView background. Safe to call when not attached. */
    private fun detachVideoSurfaces(webView: WebView) {
        val parent = webView.parent as? ViewGroup
        localVideoTrack?.let { lt -> selfRenderer?.let { runCatching { lt.removeSink(it) } }; remoteRenderer?.let { runCatching { lt.removeSink(it) } } }
        remoteVideoTrack?.let { rt -> selfRenderer?.let { runCatching { rt.removeSink(it) } }; remoteRenderer?.let { runCatching { rt.removeSink(it) } } }
        remoteRenderer?.let { runCatching { parent?.removeView(it); it.release() } }
        selfRenderer?.let { runCatching { parent?.removeView(it); it.release() } }
        remoteRenderer = null
        selfRenderer = null
        remoteVisible = false
        selfVisible = false
        systemPipMode = false
        selfBaseX = 0
        selfBaseY = 0
        if (savedWebViewBg != null) { webView.background = savedWebViewBg; savedWebViewBg = null }
        else webView.setBackgroundColor(Color.WHITE)
    }

    /** The WebView (the surface host) is GONE — either destroyed (Activity teardown) or replaced by a new one
     *  (recreation). The prior surfaces (siblings of that WebView's view tree) are now orphaned: detach their
     *  sinks, release them, null the refs so [ensureRenderers] re-creates fresh ones on the next host (its guard
     *  would otherwise skip, leaving the rebuilt UI video-less). The tracks/PC are untouched — the call survives
     *  a WebView/Activity loss; only the View surfaces are released here. Called from BOTH onWebViewCreate (the
     *  old host is gone) + MainActivity.onDestroy (the current host is gone). */
    fun onWebViewGone() {
        localVideoTrack?.let { lt ->
            remoteRenderer?.let { runCatching { lt.removeSink(it) } }
            selfRenderer?.let { runCatching { lt.removeSink(it) } }
        }
        remoteVideoTrack?.let { rt ->
            remoteRenderer?.let { runCatching { rt.removeSink(it) } }
            selfRenderer?.let { runCatching { rt.removeSink(it) } }
        }
        remoteRenderer?.let { runCatching { it.release() } }
        selfRenderer?.let { runCatching { it.release() } }
        remoteRenderer = null
        selfRenderer = null
        remoteVisible = false
        selfVisible = false
        systemPipMode = false
        selfBaseX = 0
        selfBaseY = 0
        savedWebViewBg = null
    }

    /** Release the capture + local track/source + the overlay surfaces (the remote track is PC-owned; only
     *  its sinks are detached). Called by CallController.teardown. */
    fun tearDown() {
        try {
            videoCapturer?.stopCapture()
        } catch (e: Exception) {
            SomsLog.w(TAG) { "stopCapture: ${e.message}" }
        }
        remoteVideoTrack?.let { runCatching { it.removeSink(dimensionsSink) } }
        videoCapturer?.dispose()
        captureThreadHelper?.dispose()
        localVideoTrack?.dispose()
        videoSource?.dispose()
        videoCapturer = null
        captureThreadHelper = null
        localVideoTrack = null
        remoteVideoTrack = null
        swapped = false
        remoteWidth = 0
        remoteHeight = 0
        videoSource = null
        val webViewForDetach = SomsBridge.webView
        mainHandler.post { webViewForDetach?.let { detachVideoSurfaces(it) } }
    }

    /** Camera-events sink Camera2Enumerator.createCapturer requires (logs only — the call recovers via ICE /
     *  the connection state on a camera error). */
    private object CameraEventsHandler : CameraVideoCapturer.CameraEventsHandler {
        override fun onCameraError(errorDescription: String?) { SomsLog.w(TAG) { "camera error: $errorDescription" } }
        override fun onCameraDisconnected() {}
        override fun onCameraFreezed(errorDescription: String?) { SomsLog.w(TAG) { "camera frozen: $errorDescription" } }
        override fun onCameraOpening(cameraName: String?) {}
        override fun onFirstFrameAvailable() {}
        override fun onCameraClosed() {}
    }

    private companion object {
        private const val TAG = "SomsCall"
    }
}
