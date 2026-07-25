package com.soms.client

import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.HapticFeedbackConstants
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
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())

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
    fun setupVideoCapture(factory: PeerConnectionFactory, connection: PeerConnection) {
        val ctx = contextProvider() ?: return
        val base = eglBase()
        val enumerator = Camera2Enumerator(ctx)
        val names = enumerator.deviceNames
        var name: String? = null
        for (n in names) if (enumerator.isFrontFacing(n)) { name = n; break }
        if (name == null && names.isNotEmpty()) name = names[0]
        val deviceName = name ?: run { SomsLog.w(TAG) { "no camera device" }; return }
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
    }

    /** Flip front↔back camera (WhatsApp/FaceTime). */
    fun switchCamera() {
        (videoCapturer as? CameraVideoCapturer)?.switchCamera(null)
    }

    /** Camera on/off (mute video, keep audio). */
    fun setCameraEnabled(enabled: Boolean) {
        localVideoTrack?.setEnabled(enabled)
    }

    /** The remote video's frame dimensions (rotated), or null until the first frame — for PiP aspect sizing. */
    fun remoteDimensions(): Pair<Int, Int>? =
        if (remoteWidth > 0 && remoteHeight > 0) remoteWidth to remoteHeight else null

    /** Store the peer's inbound video track (from the PC's onAddTrack) + sink it once the renderer mounts. The
     *  dimensions probe is attached here (once) so [remoteDimensions] is populated as soon as frames flow. */
    fun onRemoteTrack(track: VideoTrack) {
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
            positionSelf(v, selfRect)
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
        val big = remoteRenderer    // full-bleed surface (behind the WebView)
        val pip = selfRenderer      // PiP overlay surface (media-overlay)
        if (local != null) { big?.let { local.removeSinkSafe(it) }; pip?.let { local.removeSinkSafe(it) } }
        if (remote != null) { big?.let { remote.removeSinkSafe(it) }; pip?.let { remote.removeSinkSafe(it) } }
        // Default: local→PiP (self-view), remote→big (peer full-bleed). Swapped: local→big, remote→PiP.
        val (localTarget, remoteTarget) = if (swapped) big to pip else pip to big
        local?.let { l -> localTarget?.let { l.addSinkSafe(it, "local") } }
        remote?.let { r -> remoteTarget?.let { r.addSinkSafe(it, "remote") } }
        big?.setMirror(swapped)     // big shows the local cam ⇔ swapped
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
            lp.setMargins((o.optDouble("x", 0.0) * d).toInt(), (o.optDouble("y", 0.0) * d).toInt(), 0, 0)
            self.layoutParams = lp
        } catch (e: Exception) {
            SomsLog.w(TAG) { "setVideoRect parse: ${e.message}" }
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
