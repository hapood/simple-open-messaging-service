package com.soms.client

import android.Manifest
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.Context
import android.content.ContentValues
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.media.MediaRecorder
import android.provider.Settings
import android.provider.MediaStore
import android.graphics.Color
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import android.util.TypedValue
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.graphics.drawable.Icon
import android.util.Log
import android.util.Rational
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.BackEventCompat
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.enableEdgeToEdge
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * The app's single activity. Owns the FCM lifecycle integration:
 *
 *  - Foreground flag: onResume/onStop flip [SomsMessagingService.appInForeground] so the FCM service
 *    suppresses system notifications while the user is already looking at the chat (SSE has it).
 *  - Deep links: a notification tap carries EXTRA_THREAD_ID. Cold start captures it before the webview
 *    exists (SomsBridge.DeepLink); onWebViewCreate consumes it. Warm start (app already running) routes
 *    it straight to the live webview via window.__SOMS_DEEP_LINK__.
 *  - Token bridge: kicks off the Firebase token task in onCreate and exposes the result to JS via the
 *    SomsFcm @JavascriptInterface (added in onWebViewCreate) and the window.__SOMS_FCM_TOKEN__ hook.
 *  - Back button: hardware-back is routed to the web nav state machine (window.__SOMS_BACK__), which peels
 *    one layer (pane → aside → chat → home); a SomsBack @JavascriptInterface lets JS finish the activity
 *    when the nav stack is empty (at home). TauriActivity sets handleBackNavigation=false, so we own back.
 *  - Safe-area insets: measures the status-bar / gesture-bar insets via WindowInsets and exposes them to
 *    JS as SomsShell.getSafeInsets() (a @JavascriptInterface added in onWebViewCreate). Android WebView
 *    is edge-to-edge but env(safe-area-inset-*) returns 0, so this is the only way the web layer learns
 *    the per-device inset to pad content below the status bar (see --soms-safe-top in _tokens.scss).
 *  - IME (keyboard) height: the same edge-to-edge gap blinds window.visualViewport to the soft keyboard, so
 *    the IME inset is measured via WindowInsets (Type.ime) and published as one structured
 *    window.__SOMS_IME_EVENT__ stream (per-frame via WindowInsetsAnimation on API 30+; snapshot-readable)
 *    web's KbdOffsetDirective can lift the chat input bar above the keyboard (see ime-insets.service.ts).
 *
 * The webview reference comes from WryActivity.onWebViewCreate — the idiomatic Tauri v2 hook — rather
 * than fishing it out of the view tree, so this stays stable across Tauri versions.
 */
class MainActivity : TauriActivity() {
    private var launchOverlay: View? = null
    private var launchStatus: TextView? = null
    private var pendingSystemBarDark: Boolean? = null
    private val launchTimeout = Runnable { dismissLaunchOverlay() }
    private var currentPipParams: PictureInPictureParams? = null
    private var nativePhotoRequestId: String? = null
    private var nativeFileRequestId: String? = null
    private var pendingMediaSave: Pair<String, File>? = null
    private val nativePhotoPicker = registerForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(),
    ) { uris ->
        val requestId = nativePhotoRequestId.orEmpty()
        nativePhotoRequestId = null
        NativeUploadManager.pickerReturned(requestId)
        NativeUploadManager.accept(this, uris, "image", requestId)
        nativeComposer.restoreAfterExternalPicker()
    }
    private val legacyMediaSaver = registerForActivityResult(
        ActivityResultContracts.CreateDocument("*/*"),
    ) { uri ->
        val pending = pendingMediaSave
        pendingMediaSave = null
        val cancelled = uri == null
        val success = if (uri == null || pending == null) {
            false
        } else {
            try {
                contentResolver.openOutputStream(uri, "w")!!.use { output ->
                    pending.second.inputStream().use { input -> input.copyTo(output) }
                }
                true
            } catch (e: Exception) {
                Log.e("SOMS", "Legacy document save failed", e)
                false
            }
        }
        pending?.first?.let { requestId ->
            val script =
                "window.__SOMS_MEDIA_SAVE_RESULT__?.({" +
                    "requestId:${JSONObject.quote(requestId)},success:$success,cancelled:$cancelled})"
            SomsBridge.webView?.post {
                SomsBridge.webView?.evaluateJavascript(script, null)
            }
        }
    }
    private val nativeFilePicker = registerForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
        val requestId = nativeFileRequestId.orEmpty()
        nativeFileRequestId = null
        NativeUploadManager.pickerReturned(requestId)
        NativeUploadManager.accept(this, uris, "file", requestId)
        nativeComposer.restoreAfterExternalPicker()
    }

    // System-bar insets (status bar / gesture bar) in CSS px, measured per-device via WindowInsets
    // (see installInsetsListener). Android WebView is edge-to-edge but env(safe-area-inset-*) is 0, so
    // the web layer reads these via SomsShell.getSafeInsets() to pad content below the status bar.
    @Volatile private var safeInsetTopCss = 0
    @Volatile private var safeInsetBottomCss = 0
    // Navigation-bar / gesture bottom inset in DEVICE px, stashed from onApplyWindowInsets so the pre-API-30
    // visible-frame IME source (computeImeFromVisibleFrame) can subtract it — the visible display frame
    // excludes the nav bar together with the keyboard, so it must be peeled off to isolate the IME height.
    @Volatile private var navBottomDevicePx = 0
    // Soft-keyboard (IME) height in CSS px — VERSION-GATED, one authoritative source per branch (NOT a max
    // of two). API 30+: Type.ime() is the official, reliable inset (onApplyWindowInsets delivers the settled
    // value; a WindowInsetsAnimation callback pushes per-frame during the open/close animation). Pre-API 30:
    // Type.ime() is only an AndroidX backport that mis-splits IME vs nav on OEM ROMs (Honor Android 8 / EMUI
    // returns 0 with the keyboard open), so it is ignored; an OnGlobalLayoutListener measures the IME via
    // getWindowVisibleDisplayFrame — the canonical pre-IME-insets technique. (Type.ime() and the visible
    // frame derive from the SAME system window-frame data pre-30, so combining them would add complexity
    // without an independent signal; the visible frame is the more direct, more reliable query.) Pushed to JS
    // as structured geometry events in CSS px and readable at boot via getImeSnapshot(). Android WebView's
    // visualViewport doesn't reflect the IME (edge-to-edge, window undivided), so this is the only source of
    // the keyboard height for the web layer.
    @Volatile private var imeHeightCss = 0
    // Captured in WindowInsetsAnimation.onPrepare, before the end-state insets are applied. onStart runs
    // after that layout and imeHeightCss may already contain the destination, so it cannot identify the
    // animation direction reliably there.
    @Volatile private var imeAnimationStartCss = 0
    @Volatile private var imeAnimationPrepared = false
    @Volatile private var imeAnimationId = 0
    @Volatile private var imeAnimationRequestId: Long? = null
    // Visibility is independent of bottom occlusion: a floating IME is visible while reporting a zero
    // bottom inset. The web state machine uses visibility to choose the active keyboard surface and height
    // only for layout.
    @Volatile private var imeVisible = false
    @Volatile private var imeRequestId: Long? = null
    @Volatile private var imeRequestVisible: Boolean? = null
    private val nativeComposer by lazy { NativeComposerController(this) }
    private var nativeVoiceRecorder: MediaRecorder? = null
    private var nativeVoiceFile: File? = null
    private var nativeVoiceStartedAt = 0L
    private var nativeVoiceDurationMs = 0L
    private var nativeVoiceCapTask: Runnable? = null
    private var nativeVoiceContextId = 0L
    private var nativeVoiceThreadId = 0L
    private var pendingVoiceStart: (() -> Unit)? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) captureSharedText(intent)
        installLaunchOverlay()
        // Seed SomsLog's file sink path before any subsystem logs. Release keeps writes disabled until the
        // persisted/hidden runtime debug gate is enabled by the web layer.
        SomsLog.init(this)
        // System Back → the native composer first, otherwise the WebView. The predictive event stream is
        // optional: cached/current web bundles without it keep receiving the legacy __SOMS_BACK__ commit.
        // TauriActivity sets handleBackNavigation=false (WryActivity's web-history default is off), so this
        // callback is the single Android owner of both button Back and gesture Back.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            private var gestureStarted = false
            private var nativeOwnsGesture = false

            override fun handleOnBackStarted(backEvent: BackEventCompat) {
                gestureStarted = true
                nativeOwnsGesture = nativeComposer.canHandleBack()
                if (!nativeOwnsGesture) emitPredictiveBack("start", backEvent)
            }

            override fun handleOnBackProgressed(backEvent: BackEventCompat) {
                if (!nativeOwnsGesture) emitPredictiveBack("progress", backEvent)
            }

            override fun handleOnBackCancelled() {
                if (!nativeOwnsGesture) emitPredictiveBack("cancel")
                gestureStarted = false
                nativeOwnsGesture = false
            }

            override fun handleOnBackPressed() {
                // Three-button navigation may commit without a predictive start callback. In that case sample
                // native ownership now; a gesture that did start keeps its frozen owner through commit.
                val handledNatively = if (gestureStarted) {
                    nativeOwnsGesture && nativeComposer.handleBack()
                } else {
                    nativeComposer.handleBack()
                }
                gestureStarted = false
                nativeOwnsGesture = false
                if (!handledNatively) emitPredictiveBack("commit")
            }
        })
        // Capture the cold-start deep link (notification tap that launched the process) before the
        // webview exists; onWebViewCreate will deliver it to JS.
        intent?.let { offerNotificationTap(it) }
        // Cold-start answer: the user tapped Answer on the incoming-call notification (the FCM wake-up rang
        // the phone; CallController is already seeded incoming). Accept natively now — the webview boots and
        // shows the connecting UI from the snapshot.
        if (intent?.action == CallService.ACTION_ANSWER) {
            intent.getStringExtra(CallService.EXTRA_SID)?.let { handleCallAnswer(it, intent) }
        }
        // Reflect call-phase changes in the show-when-locked / turn-screen-on flags (lock-screen incoming UI).
        CallController.setPhaseListener {
            runOnUiThread {
                applyCallDisplayFlags()
                updateVideoPipParams()
                // Android has no public "exit PiP but keep this Activity backgrounded" API. Finishing the
                // disposable Web Activity is the clean terminal transition; the native call is already ended.
                if (isInPictureInPictureMode && (it == "idle" || it == "ended")) finish()
            }
        }
        CallController.setVideoGeometryListener { runOnUiThread { updateVideoPipParams() } }
        applyCallDisplayFlags()
        // Kick off the FCM token fetch, throttled to once/day (a mainland-China device without GMS shouldn't hammer
        // Google on every launch). First run (no cached token) always fetches so FCM works from session one.
        maybeFetchFcmToken()
        // Schedule the mainland-China fallback poller (~6h periodic). Idempotent across process launches via KEEP:
        // re-enqueuing the same unique work name leaves the existing schedule intact. The worker self-skips
        // when no notification token (logged out) or when the app is foregrounded. Network constraint so the
        // poller is deferred until the device is online (no offline wake → failed fetch → wasted wake lock);
        // KEEP leaves an already-scheduled instance's constraints unchanged, so this applies on a fresh
        // schedule (reinstall / first launch).
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            NOTIF_SYNC_WORK,
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<NotificationSyncWorker>(6, TimeUnit.HOURS)
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
                )
                .build(),
        )
        // Measure system-bar insets (status bar / gesture bar) so the web layer can pad content below
        // them. Fires on the first layout pass (~1 frame after attach) and on every inset change.
        installInsetsListener()
    }

    /** Publish Android's Predictive Back lifecycle without requiring the current web bundle to implement it.
     *  Commit falls back to the established zero-argument handler, preserving button/hardware Back behavior
     *  until Angular opts into the richer event stream. Coordinates stay in physical WebView pixels; progress
     *  is normalized by Android to 0..1 and swipeEdge uses BackEventCompat's LEFT/RIGHT integer constants. */
    private fun emitPredictiveBack(kind: String, event: BackEventCompat? = null) {
        val payload = JSONObject().apply {
            put("kind", kind)
            if (event != null) {
                put("progress", event.progress.toDouble())
                put("touchX", event.touchX.toDouble())
                put("touchY", event.touchY.toDouble())
                put("swipeEdge", event.swipeEdge)
            }
        }
        val fallback = if (kind == "commit") {
            "else{window.__SOMS_BACK__?.();}"
        } else {
            ""
        }
        SomsBridge.eval(
            "if(window.__SOMS_PREDICTIVE_BACK__){window.__SOMS_PREDICTIVE_BACK__($payload);}" + fallback,
        )
    }

    /**
     * Native continuation of Android's system splash. It uses the same solid brand background and logo,
     * but can remain above the WebView while Angular restores the session, resolves its first route, and
     * paints stable content. The small lower-left label is deliberately secondary to the centered mark.
     */
    private fun installLaunchOverlay() {
        val decor = window.decorView as? ViewGroup ?: return
        val density = resources.displayMetrics.density
        fun dp(value: Int) = Math.round(value * density)

        val overlay = FrameLayout(this).apply {
            setBackgroundColor(Color.rgb(233, 225, 213))
            isClickable = true
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            elevation = dp(16).toFloat()
        }
        val logo = ImageView(this).apply {
            // VectorDrawable: unlike the 108dp adaptive-launcher PNG, this remains sharp on the
            // platform-standard 288dp transparent splash canvas at every display density.
            setImageResource(R.drawable.splash_logo)
            scaleType = ImageView.ScaleType.FIT_CENTER
            contentDescription = null
        }
        overlay.addView(
            logo,
            // Match Android 12+'s transparent splash-icon canvas. The mark deliberately occupies
            // about half of this canvas, yielding a ~144dp visible bubble inside the 192dp safe zone.
            FrameLayout.LayoutParams(dp(288), dp(288), Gravity.CENTER),
        )

        val status = TextView(this).apply {
            setText(R.string.splash_preparing)
            setTextColor(Color.argb(170, 25, 33, 42))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setTypeface(typeface, Typeface.NORMAL)
            letterSpacing = 0.04f
            maxLines = 1
            includeFontPadding = false
        }
        overlay.addView(
            status,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.START or Gravity.BOTTOM,
            ).apply {
                marginStart = dp(24)
                bottomMargin = dp(28)
            },
        )

        decor.addView(
            overlay,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        launchOverlay = overlay
        launchStatus = status
        overlay.postDelayed(launchTimeout, LAUNCH_TIMEOUT_MS)
    }

    private fun updateLaunchStage(stage: String) {
        val label = when (stage) {
            "session" -> R.string.splash_restoring_session
            "config" -> R.string.splash_loading_config
            "interface" -> R.string.splash_preparing_interface
            else -> return
        }
        launchStatus?.setText(label)
    }

    private fun applySystemBarTheme(dark: Boolean) {
        if (launchOverlay != null) {
            pendingSystemBarDark = dark
            return
        }
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.isAppearanceLightStatusBars = !dark
        controller.isAppearanceLightNavigationBars = !dark
    }

    private fun dismissLaunchOverlay() {
        val overlay = launchOverlay ?: return
        launchOverlay = null
        launchStatus = null
        overlay.removeCallbacks(launchTimeout)
        overlay.animate()
            .alpha(0f)
            .setDuration(LAUNCH_FADE_MS)
            .withEndAction {
                (overlay.parent as? ViewGroup)?.removeView(overlay)
                pendingSystemBarDark?.let {
                    pendingSystemBarDark = null
                    applySystemBarTheme(it)
                }
            }
            .start()
    }

    override fun dispatchTouchEvent(event: android.view.MotionEvent): Boolean {
        // Let the WebView resolve ACTION_DOWN against the current (keyboard-open) layout before an
        // outside touch dismisses the native composer keyboard and changes the WebView geometry.
        // The same event is dispatched exactly once; no delayed or synthetic click is needed.
        val handled = super.dispatchTouchEvent(event)
        nativeComposer.handleOutsideTouch(event)
        return handled
    }

    /** Install a WindowInsets listener on the content view that measures the status-bar / gesture-bar
     *  insets (device px), converts to integer CSS px (÷ density), stores them for
     *  SomsShell.getSafeInsets(), and pushes live updates to the webview. Per-device — never hardcoded. */
    private fun installInsetsListener() {
        val content = findViewById<View>(android.R.id.content) ?: return
        ViewCompat.setOnApplyWindowInsetsListener(content) { _, insets ->
            val status = insets.getInsets(WindowInsetsCompat.Type.statusBars())
            val nav = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
            // Bottom inset = max(navigation bar, mandatory gesture area). navigationBars() covers the
            // 3-button nav bar; mandatorySystemGestures() covers the gesture pill on full-screen /
            // bezel-less (全面屏) devices, where navigationBars() alone can under-report on some OEM
            // ROMs — taking the max guarantees the app content always clears the system bar on every
            // navigation mode. (systemGestures — the wider back-swipe zone — is intentionally excluded:
            // it would over-pad.)
            val gestures = insets.getInsets(WindowInsetsCompat.Type.mandatorySystemGestures())
            // On pre-R EMUI, the compat navigationBars() value expands to the full IME height while the
            // keyboard is visible (for example 781 px on RVL-AL09). The stable inset remains the actual
            // system-bar size, so use it on those releases; otherwise the visible-frame IME calculation
            // subtracts the keyboard from itself and can only ever report zero.
            navBottomDevicePx =
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
                    // Gesture insets are also approximated from legacy system-window insets on old
                    // releases and can therefore contain the IME. The stable bottom is the only value
                    // here whose contract excludes transient visibility changes.
                    insets.stableInsetBottom
                } else {
                    maxOf(nav.bottom, gestures.bottom)
                }
            val d = resources.displayMetrics.density
            safeInsetTopCss = Math.round(status.top / d)
            safeInsetBottomCss = Math.round(navBottomDevicePx / d)
            // IME is version-gated here — see imeHeightCss. API 30+ trusts Type.ime() (the WindowInsetsAnimation
            // callback below tracks it per-frame during the open/close animation). Pre-API 30 ignores Type.ime()
            // (its Compat backport is unreliable on OEM ROMs) and defers the IME to the OnGlobalLayoutListener
            // installed below, so it does NOT push here on pre-R.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
                imeHeightCss = Math.max(0, Math.round(ime.bottom / d))
                imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
                if (!imeAnimationPrepared) {
                    pushImeEvent(
                        phase = "change",
                        targetCss = imeHeightCss,
                        isFinal = true,
                    )
                }
                nativeComposer.updateInsets(ime.bottom, navBottomDevicePx)
            } else {
                val derivedIme = computeImeFromVisibleFrame(content, navBottomDevicePx)
                imeHeightCss = Math.max(0, Math.round(derivedIme / d))
                imeVisible = derivedIme > 0
                // Pre-R cannot predict a trustworthy endpoint. Follow the observed frame visually, but
                // commit geometry only after the global-layout source has remained stable.
                nativeComposer.updateImeAnimationProgress(derivedIme, navBottomDevicePx)
            }
            applySafeInsetsToWebView()
            insets
        }
        // On API 30+ the IME animates open/close (~250ms). Follow it frame-by-frame so the chat input bar
        // slides up in sync with the keyboard (DISPATCH_MODE_STOP: we own the lift — the WebView must NOT
        // auto-resize/scroll for the IME during the animation; after the animation onApplyWindowInsets above
        // fires once with the settled inset). Below API 30 this callback is inert; the visible-frame listener
        // below publishes every observed geometry frame and a debounced final.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ViewCompat.setWindowInsetsAnimationCallback(content,
                object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_STOP) {
                    override fun onPrepare(animation: WindowInsetsAnimationCompat) {
                        if (animation.typeMask and WindowInsetsCompat.Type.ime() != 0) {
                            nativeComposer.onImeAnimationPrepare()
                            imeAnimationStartCss = imeHeightCss
                            imeAnimationPrepared = true
                            imeAnimationId += 1
                            imeAnimationRequestId = imeRequestId
                            pushImeEvent(
                                phase = "prepare",
                                currentCss = imeAnimationStartCss,
                                isFinal = false,
                                requestId = imeAnimationRequestId,
                            )
                        }
                    }

                    override fun onStart(
                        animation: WindowInsetsAnimationCompat,
                        bounds: WindowInsetsAnimationCompat.BoundsCompat,
                    ): WindowInsetsAnimationCompat.BoundsCompat {
                        if (animation.typeMask and WindowInsetsCompat.Type.ime() != 0) {
                            val d = resources.displayMetrics.density
                            val lower = Math.max(0, Math.round(bounds.lowerBound.bottom / d))
                            val upper = Math.max(0, Math.round(bounds.upperBound.bottom / d))
                            // onStart follows the end-state layout, so use the pre-layout value captured in
                            // onPrepare. Pick the opposite (farther) bound; this also handles a visible IME
                            // animating between two different heights.
                            val target =
                                if (Math.abs(imeAnimationStartCss - lower) <= Math.abs(imeAnimationStartCss - upper)) upper
                                else lower
                            pushImeEvent(
                                phase = "start",
                                currentCss = imeAnimationStartCss,
                                targetCss = target,
                                durationMs = animation.durationMillis,
                                isFinal = false,
                                requestId = imeAnimationRequestId,
                            )
                        }
                        return bounds
                    }

                    override fun onProgress(
                        insets: WindowInsetsCompat,
                        runningAnims: MutableList<WindowInsetsAnimationCompat>,
                    ): WindowInsetsCompat {
                        val d = resources.displayMetrics.density
                        imeHeightCss = Math.max(0, Math.round(insets.getInsets(WindowInsetsCompat.Type.ime()).bottom / d))
                        imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
                        nativeComposer.updateImeAnimationProgress(
                            insets.getInsets(WindowInsetsCompat.Type.ime()).bottom,
                            navBottomDevicePx,
                        )
                        pushImeEvent(
                            phase = "progress",
                            isFinal = false,
                            requestId = imeAnimationRequestId,
                        )
                        return insets
                    }

                    override fun onEnd(animation: WindowInsetsAnimationCompat) {
                        if (animation.typeMask and WindowInsetsCompat.Type.ime() != 0) {
                            imeAnimationPrepared = false
                            // onEnd can follow a cancelled/reversed animation. Re-sample root insets rather
                            // than trusting the last progress frame, then publish one authoritative final.
                            ViewCompat.getRootWindowInsets(content)?.let { finalInsets ->
                                val d = resources.displayMetrics.density
                                imeHeightCss = Math.max(
                                    0,
                                    Math.round(finalInsets.getInsets(WindowInsetsCompat.Type.ime()).bottom / d),
                                )
                                imeVisible = finalInsets.isVisible(WindowInsetsCompat.Type.ime())
                            }
                            pushImeEvent(
                                phase = "end",
                                targetCss = imeHeightCss,
                                isFinal = true,
                                requestId = imeAnimationRequestId,
                            )
                            nativeComposer.onImeAnimationEnd()
                            imeAnimationRequestId = null
                        }
                    }
                })
        }
        // Pre-API-30 IME source: a global-layout listener that recomputes the keyboard height from the content
        // view's visible display frame. Every observed geometry change is still published as progress so the
        // native protocol loses no information; today's web layout deliberately ignores those old-platform
        // progress frames and commits only the debounced final. (onApplyWindowInsets also delivers Type.ime()
        // pre-30, but its Compat backport is unreliable on OEM ROMs — see imeHeightCss.) Gated to pre-R:
        // on API 30+ Type.ime() plus WindowInsetsAnimation are authoritative.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            var finalRunnable: Runnable? = null
            content.viewTreeObserver.addOnGlobalLayoutListener {
                val d = resources.displayMetrics.density
                val derived = computeImeFromVisibleFrame(content, navBottomDevicePx)
                val derivedCss = Math.max(0, Math.round(derived / d))
                if (derivedCss != imeHeightCss) {
                    imeHeightCss = derivedCss
                    imeVisible = derivedCss > 0
                    nativeComposer.updateImeAnimationProgress(derived, navBottomDevicePx)
                    pushImeEvent(
                        phase = "progress",
                        targetCss = derivedCss,
                        isFinal = false,
                    )
                    finalRunnable?.let(content::removeCallbacks)
                    finalRunnable = Runnable {
                        pushImeEvent(
                            phase = "change",
                            targetCss = imeHeightCss,
                            isFinal = true,
                        )
                    }.also { content.postDelayed(it, 80L) }
                }
            }
        }
        ViewCompat.requestApplyInsets(content)
    }

    /** Pre-API-30 source of the soft-keyboard (IME) height. The AndroidX WindowInsetsCompat.Type.ime() backport
     *  mis-splits IME vs navigation bar on some OEM ROMs (observed Honor Android 8 / EMUI:
     *  Type.ime().bottom == 0 while the keyboard is open), so on pre-R we measure the IME directly from the
     *  content view's visible display frame, which excludes the status bar, the navigation bar AND the IME.
     *  Hence (content height − visible-frame bottom − already-measured nav/gesture inset) = IME height.
     *  Returns DEVICE px (caller converts to CSS px). */
    private fun computeImeFromVisibleFrame(content: View, navBottomDevicePx: Int): Int {
        val rect = android.graphics.Rect()
        content.getWindowVisibleDisplayFrame(rect)
        return Math.max(0, content.height - rect.bottom - navBottomDevicePx)
    }

    /** Push the latest insets to the webview as --soms-safe-top / --soms-safe-bottom on :root. A no-op
     *  before the page has loaded (the eval lands on about:blank, harmless) — the first paint is handled
     *  by main.ts reading SomsShell.getSafeInsets(). This path covers inset CHANGES (rotation) post-load. */
    private fun applySafeInsetsToWebView() {
        val v = SomsBridge.webView ?: return
        val js = "document.documentElement.style.setProperty('--soms-safe-top','${safeInsetTopCss}px');" +
            "document.documentElement.style.setProperty('--soms-safe-bottom','${safeInsetBottomCss}px');"
        v.evaluateJavascript(js, null)
    }

    /** One atomic native→web geometry event. Kotlin reports Android facts in WebView CSS px; the Angular
     *  keyboard state machine owns every layout and native↔custom handoff decision. */
    private fun pushImeEvent(
        phase: String,
        currentCss: Int = imeHeightCss,
        targetCss: Int? = null,
        durationMs: Long = 0,
        isFinal: Boolean,
        requestId: Long? = imeRequestId,
    ) {
        val v = SomsBridge.webView ?: return
        val payload = JSONObject()
            .put("phase", phase)
            .put("currentPx", currentCss)
            .put("targetPx", targetCss ?: JSONObject.NULL)
            .put("durationMs", durationMs)
            .put("animationId", imeAnimationId)
            .put("requestId", requestId ?: JSONObject.NULL)
            .put("visible", imeVisible)
            .put("isFinal", isFinal)
            .toString()
        v.evaluateJavascript(
            "window.__SOMS_IME_EVENT__&&window.__SOMS_IME_EVENT__($payload);",
            null,
        )
        if (
            isFinal &&
            requestId != null &&
            imeRequestId == requestId &&
            imeRequestVisible == imeVisible
        ) {
            imeRequestId = null
            imeRequestVisible = null
        }
    }

    /** Atomic visibility request. DOM focus and keyboard-mode policy remain entirely in Angular. */
    private fun setImeVisible(visible: Boolean, requestId: Long) {
        val v = SomsBridge.webView ?: return
        imeRequestId = requestId
        imeRequestVisible = visible
        runOnUiThread {
            v.post {
                val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager
                val controller = WindowInsetsControllerCompat(window, v)
                if (imeVisible == visible) {
                    pushImeEvent(
                        phase = "change",
                        targetCss = imeHeightCss,
                        isFinal = true,
                    )
                    return@post
                }
                if (visible) {
                    // Re-establish the WebView/InputConnection for the explicit emoji → system-keyboard
                    // handoff. Normal editor taps use Chromium's automatic keyboard policy.
                    v.requestFocusFromTouch()
                    imm.restartInput(v)
                    controller.show(WindowInsetsCompat.Type.ime())
                    // WindowInsetsController is the primary API. Some older OEM WebViews ignore it even
                    // with a live InputConnection; only then issue the InputMethodManager fallback.
                    v.postDelayed({
                        if (imeRequestId == requestId && !imeVisible) {
                            imm.restartInput(v)
                            imm.showSoftInput(v, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
                        }
                    }, 120L)
                } else {
                    controller.hide(WindowInsetsCompat.Type.ime())
                    imm.hideSoftInputFromWindow(v.windowToken, 0)
                }
            }
        }
    }

    /** Pin the WebView renderer at the highest app-requestable priority (IMPORTANT) and keep it there even
     *  while the app is backgrounded (waivedWhenNotVisible=false), so the renderer is effectively never
     *  reclaimed for memory while the process lives — app resumes are seamless, with no renderer-reclaim
     *  reload (the HELLO-replay path then only ever fires on actual process death). Applied app-wide, not
     *  call-scoped. Trade-off, stated plainly: the renderer (~tens of MB) stays pinned whenever the app is
     *  backgrounded, so on the low-RAM Huawei RVL-AL09 / DBY-W09 fleet this raises the app's background
     *  footprint and can bring the costlier process-death (vs the cheaper renderer-reclaim) closer under
     *  heavy system load — a deliberate, app-wide choice in favor of resume smoothness. Applied on every
     *  WebView (re)creation so a recreated WebView re-acquires the policy. Guarded by RENDER_PRIORITY_POLICY
     *  feature support (API 26+ / a Chromium WebView provider); a safe no-op on older WebView cores. UI
     *  thread only (it touches the WebView). */
    private fun applyCallRendererPolicy() {
        val v = SomsBridge.webView ?: return
        // Framework WebView.setRendererPriorityPolicy (API 26/Oreo+): keep the renderer at IMPORTANT
        // priority even while backgrounded (waivedWhenNotVisible=false) so it isn't reclaimed for memory
        // while the app is backgrounded — app resumes are seamless. A no-op on API < 26 (the guard).
        // androidx.webkit does NOT expose this; it's the framework method.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            v.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        }
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        // Enable Chrome DevTools remote inspection (edge://inspect · chrome://inspect over adb) for DEBUG
        // builds ONLY — the JS context is fully exposed (DOM read, arbitrary JS eval), so shipping it in a
        // release APK would be a security hole. Wry/Tauri v2 does NOT auto-enable this even for debuggable
        // builds; it must be turned on explicitly. Static on WebView → applies process-wide to every WebView.
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        // Lock page zoom at the engine level: this is a native shell, not a zoomable web page, and
        // pinch-zooming it breaks the virtual-scroll kernel's integer-pixel height model. The viewport
        // meta in index.html (`user-scalable=no`) is the same lock for the PWA/browser build; here we
        // enforce it authoritatively on the WebView, which is robust against OEM WebView cores that
        // ignore the meta — notably the aged Huawei RVL-AL09 (Android 9) / DBY-W09 (Android 12) fleet.
        // setSupportZoom(false) disables every zoom path (pinch, double-tap, buttons); turning the
        // built-in zoom controls off guarantees no +/- overlay surfaces regardless of OEM defaults.
        webView.settings.setSupportZoom(false)
        webView.settings.setBuiltInZoomControls(false)
        SomsBridge.webView = webView
        // Expose the Kotlin→JS-callable surface (token read + permission request). Added once here,
        // when the webview is created, rather than repeatedly in onResume.
        webView.addJavascriptInterface(SomsFcmInterface(this), "SomsFcm")
        // window.SomsBack.exit() — the JS nav state machine calls it to finish the activity when
        // hardware-back has nothing left to peel (at home).
        webView.addJavascriptInterface(SomsBackInterface(this), "SomsBack")
        // window.SomsShell.getSafeInsets() — the web app reads the per-device status-bar inset here (in
        // main.ts, before bootstrap) to set --soms-safe-top for a FOUC-free first paint. Android WebView's
        // env(safe-area-inset-top) is 0, so this @JavascriptInterface is the only source.
        webView.addJavascriptInterface(SomsShellInterface(this), "SomsShell")
        // window.SomsSecureStore.getApiOrigin()/setApiOrigin() — the WebView-independent persistence the
        // web seeds apiOrigin from at boot and the native SSE (RealtimeService)
        // reads. Added here, before the page boots, so runtime.ts's synchronous seed read resolves the
        // native store (not a stale injected global).
        webView.addJavascriptInterface(SomsSecureStoreInterface(this), "SomsSecureStore")
        // window.SomsCall.* — the command direction of the native call bridge (initiate / accept / … /
        // getSnapshot); the Angular CallAdapter facade calls these. The EVENT direction rides the existing
        // window.__SOMS_EVENT__ (CALL_EVENT/CALL_SIGNAL) + CallController's window.__SOMS_CALL_EVENT__
        // snapshot push. Added before the page boots like the other bridges.
        webView.addJavascriptInterface(SomsCallInterface(this), "SomsCall")
        // Privacy-scoped system picker + native streaming uploads. File bytes never cross into the
        // webview; JS receives metadata, a bounded preview, progress, and the final API envelope.
        webView.addJavascriptInterface(SomsUploadInterface(this), "SomsUpload")
        // Rust downloads authenticated media into the app-private shared cache. This bridge performs
        // only the Android-specific final copy into MediaStore; file bytes never pass through JS.
        webView.addJavascriptInterface(SomsMediaInterface(this), "SomsMedia")
        // Durable hand-off for Android's share sheet. The payload stays in native memory until the future
        // recipient-selection flow acknowledges it, so a WebView reload can read it again.
        webView.addJavascriptInterface(SomsShareInterface(), "SomsShare")
        // Dormant native Media3 video player: its JS bridge is intentionally not registered while the app
        // uses the WebView player. Restore this line together with the Gradle dependencies and manifest entry.
        // webView.addJavascriptInterface(SomsVideoInterface(this), "SomsVideo")
        // Pin the renderer at IMPORTANT priority even while the app is backgrounded (app-wide, on every
        // WebView (re)creation — see applyCallRendererPolicy).
        applyCallRendererPolicy()
        // Deliver anything that arrived before the webview was ready.
        SomsBridge.FcmToken.current?.let { emitToken(it) }
        SomsBridge.eval("window.__SOMS_DEEP_LINK__ && window.__SOMS_DEEP_LINK__();")
        notifyShareAvailable()
        // This (re)created WebView replaces any prior one — release its orphaned video surfaces so the next
        // rect report re-creates them here (ensureRenderers's guard would otherwise skip).
        CallController.onWebViewGone()
    }

    /**
     * Public-media save boundary. Rust owns network access, authentication, cache deduplication and
     * integrity; this bridge accepts only a canonical file below this app's cache/media directory.
     * Android 10+ copies into MediaStore; Android 7–9 uses the system document picker without broad
     * external-storage permission.
     */
    private class SomsMediaInterface(activity: MainActivity) {
        private val activityRef = java.lang.ref.WeakReference(activity)

        @JavascriptInterface
        fun save(requestId: String, cachePath: String, filename: String, mimeType: String): String {
            val activity = activityRef.get() ?: return ""
            val context = activity.applicationContext

            val mediaRoot = File(context.cacheDir, "media").canonicalFile
            val source = try {
                File(cachePath).canonicalFile
            } catch (e: Exception) {
                Log.e("SOMS", "Invalid media cache path", e)
                return ""
            }
            if (!source.isFile || source.parentFile != mediaRoot) {
                Log.w("SOMS", "Rejected media save outside cache root")
                return ""
            }

            val safeName = filename
                .substringAfterLast('/')
                .substringAfterLast('\\')
                .trim()
                .ifEmpty { "download" }
            val type = mimeType.ifBlank { "application/octet-stream" }
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                activity.runOnUiThread {
                    activity.pendingMediaSave = requestId to source
                    activity.legacyMediaSaver.launch(safeName)
                }
                return "pending"
            }
            val (collection, relativePath) = when {
                type.startsWith("image/") ->
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI to "Pictures/SOMS"
                type.startsWith("video/") ->
                    MediaStore.Video.Media.EXTERNAL_CONTENT_URI to "Movies/SOMS"
                else ->
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI to "Download/SOMS"
            }
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, safeName)
                put(MediaStore.MediaColumns.MIME_TYPE, type)
                put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val resolver = context.contentResolver
            val uri = resolver.insert(collection, values) ?: return ""
            return try {
                resolver.openOutputStream(uri, "w")!!.use { output ->
                    source.inputStream().use { input -> input.copyTo(output) }
                }
                values.clear()
                values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                uri.toString()
            } catch (e: Exception) {
                resolver.delete(uri, null, null)
                Log.e("SOMS", "MediaStore save failed", e)
                ""
            }
        }
    }

    /*
     * Dormant native Media3 video bridge. Kept verbatim for a possible future re-enable; because the
     * entire declaration is commented out, VideoPlayerActivity is not resolved by the current build.
    private class SomsVideoInterface(activity: MainActivity) {
        private val activityRef = java.lang.ref.WeakReference(activity)

        @JavascriptInterface
        fun open(
            streamUrl: String,
            thumbnailUploadUrl: String,
            digest: String,
            hasThumbnail: Boolean,
        ) {
            val activity = activityRef.get() ?: return
            activity.runOnUiThread {
                activity.startActivity(
                    Intent(activity, VideoPlayerActivity::class.java)
                        .putExtra(VideoPlayerActivity.EXTRA_STREAM_URL, streamUrl)
                        .putExtra(VideoPlayerActivity.EXTRA_THUMBNAIL_UPLOAD_URL, thumbnailUploadUrl)
                        .putExtra(VideoPlayerActivity.EXTRA_HAS_THUMBNAIL, hasThumbnail)
                        .putExtra(VideoPlayerActivity.EXTRA_DIGEST, digest),
                )
            }
        }
    }
    */

    private class SomsUploadInterface(activity: MainActivity) {
        private val activityRef = java.lang.ref.WeakReference(activity)

        @JavascriptInterface
        fun pickPhotos(requestId: String) {
            val activity = activityRef.get() ?: return
            activity.runOnUiThread {
                activity.nativePhotoRequestId = requestId
                activity.nativePhotoPicker.launch(
                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo),
                )
            }
        }

        @JavascriptInterface
        fun pickFile(requestId: String) {
            val activity = activityRef.get() ?: return
            activity.runOnUiThread {
                activity.nativeFileRequestId = requestId
                activity.nativeFilePicker.launch(arrayOf("*/*"))
            }
        }

        @JavascriptInterface
        fun upload(
            uploadId: String,
            attemptId: String,
            kind: String,
            clientMessageId: String?,
            fieldsJson: String?,
        ) {
            activityRef.get()?.let {
                NativeUploadManager.upload(
                    it.applicationContext,
                    uploadId,
                    attemptId,
                    kind,
                    clientMessageId,
                    fieldsJson,
                )
            }
        }

        @JavascriptInterface
        fun discard(uploadId: String) {
            NativeUploadManager.discard(uploadId)
        }

        @JavascriptInterface
        fun release(uploadId: String) {
            NativeUploadManager.release(uploadId)
        }

        @JavascriptInterface
        fun cancel(uploadId: String, attemptId: String) {
            NativeUploadManager.cancel(uploadId, attemptId)
        }

        @JavascriptInterface
        fun getState(uploadId: String): String {
            return NativeUploadManager.state(uploadId)
        }

        @JavascriptInterface
        fun finish(uploadId: String, attemptId: String, succeeded: Boolean) {
            NativeUploadManager.finishAttempt(uploadId, attemptId, succeeded)
        }
    }

    /** Defensive fallback: locate the Tauri WebView in the window's view tree and hand it to SomsBridge.
     *  Idempotent. onWebViewCreate is the primary registration site — it always fires, because wry
     *  calls WryActivity.setWebView -> onWebViewCreate once the WebView is built — but that call is
     *  asynchronous w.r.t. the activity lifecycle and can land after the first onResume, so this
     *  view-tree scan is a belt-and-suspenders catch for that race window. Also called from the dev
     *  bubble's tap, by which point the WebView is guaranteed mounted. */
    internal fun captureWebView() {
        if (SomsBridge.webView != null) return
        val root = window.decorView as? ViewGroup ?: return
        firstWebView(root)?.let { SomsBridge.webView = it }
    }

    private fun firstWebView(root: ViewGroup): WebView? {
        for (i in 0 until root.childCount) {
            when (val c = root.getChildAt(i)) {
                is WebView -> return c
                is ViewGroup -> firstWebView(c)?.let { return it }
            }
        }
        return null
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        captureSharedText(intent)
        // Warm start: app already running, user tapped a notification. Route straight to the live
        // webview. (setIntent is unnecessary — singleTask + CLEAR_TOP keeps the back stack sane.)
        if (offerNotificationTap(intent)) {
            SomsBridge.eval("window.__SOMS_DEEP_LINK__ && window.__SOMS_DEEP_LINK__();")
        }
        // Warm-start answer: the app was already running when the user tapped Answer on the ringing notif.
        if (intent.action == CallService.ACTION_ANSWER) {
            intent.getStringExtra(CallService.EXTRA_SID)?.let { handleCallAnswer(it, intent) }
        }
    }

    private fun captureSharedText(intent: Intent?) {
        val text = NativeShareLogic.normalizedText(
            intent?.action,
            intent?.type,
            intent?.getStringExtra(Intent.EXTRA_TEXT),
        ) ?: return
        SomsBridge.Share.pending = SomsBridge.SharedText(UUID.randomUUID().toString(), text)
        notifyShareAvailable()
    }

    private fun notifyShareAvailable() {
        if (SomsBridge.Share.pending == null) return
        SomsBridge.eval("window.__SOMS_SHARE_AVAILABLE__?.();")
    }

    private class SomsShareInterface {
        @JavascriptInterface
        fun getPending(): String? = SomsBridge.Share.pending?.let { pending ->
            JSONObject().apply {
                put("id", pending.id)
                put("text", pending.text)
            }.toString()
        }

        @JavascriptInterface
        fun acknowledge(id: String): Boolean {
            synchronized(SomsBridge.Share) {
                if (SomsBridge.Share.pending?.id != id) return false
                SomsBridge.Share.pending = null
                return true
            }
        }
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        // Auto-enter PiP for an active VIDEO call when the user leaves (home / recents). The native remote
        // SurfaceViewRenderer is a sibling of the WebView, so it keeps rendering scaled into the PiP window;
        // the Angular chrome is hidden via __SOMS_PIP__ (onPictureInPictureModeChanged). AUDIO calls do NOT
        // PiP — they background to the ongoing-call notification (already posted by CallService).
        if (CallController.callType != "VIDEO") return
        val p = CallController.phase
        if (p != "connected" && p != "reconnecting") return
        // Remove the in-app self surface before WindowManager captures the transition. Android 12+ then
        // auto-enters from the preconfigured params; older releases still need the explicit call.
        CallController.setSystemPipMode(true)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            enterVideoPiP()
        } else {
            // Auto-enter can be disabled by the user/system. Do not leave the self surface suppressed if no
            // PiP transition actually follows this leave hint.
            window.decorView.postDelayed({
                if (!isInPictureInPictureMode) CallController.setSystemPipMode(false)
            }, PIP_ENTER_CONFIRM_MS)
        }
    }

    /** Build + enter the PiP params for the active video call. The aspect ratio follows the current window
     *  (clamped to the PiP range). PiP params are API 26+; older devices simply skip it. */
    private fun enterVideoPiP() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        try {
            updateVideoPipParams()
            val entered = currentPipParams?.let { enterPictureInPictureMode(it) } ?: false
            if (!entered) CallController.setSystemPipMode(false)
        } catch (e: Exception) {
            SomsLog.w("SomsActivity") { "PiP enter failed: ${e.message}" }
            CallController.setSystemPipMode(false)
        }
    }

    /** Preconfigure the system transition while the video is steady. Android 12+ auto-enter starts at the
     *  Home gesture's first frame; sourceRectHint anchors the animation to the actual native remote Surface. */
    private fun updateVideoPipParams() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val phase = CallController.phase
        val eligible = CallController.callType == "VIDEO" &&
            (phase == "connected" || phase == "reconnecting")
        val builder = PictureInPictureParams.Builder()
            .setAspectRatio(pipAspectRatio())
            .setActions(if (eligible) buildPipActions() else emptyList())
        CallController.remoteVideoSurfaceRect()?.let { builder.setSourceRectHint(it) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder
                .setAutoEnterEnabled(eligible)
                .setSeamlessResizeEnabled(true)
        }
        val params = builder.build()
        currentPipParams = params
        runCatching { setPictureInPictureParams(params) }
            .onFailure { SomsLog.w("SomsActivity") { "PiP params failed: ${it.message}" } }
    }

    /** System-owned controls remain usable while the Web chrome is hidden in PiP. Broadcast intents route to
     *  the process-global CallController, so they also work when the Activity is paused. */
    private fun buildPipActions(): List<RemoteAction> {
        val binding = CallService.instance?.currentNotificationSession() ?: return emptyList()
        val sid = CallController.callSid ?: return emptyList()
        val icon = Icon.createWithResource(this, R.drawable.ic_notification)
        val muteIntent = Intent(this, SomsActionReceiver::class.java)
            .putExtra(SomsActionReceiver.EXTRA_CALL_TOGGLE_MUTE, true)
            .putExtra(CallService.EXTRA_SID, sid)
        binding.attach(muteIntent, "pip-mute", sid)
        val mutePi = PendingIntent.getBroadcast(
            this,
            PIP_REQ_MUTE,
            muteIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val endIntent = Intent(this, SomsActionReceiver::class.java)
            .putExtra(SomsActionReceiver.EXTRA_CALL_END, sid)
        binding.attach(endIntent, "pip-end", sid)
        val endPi = PendingIntent.getBroadcast(
            this,
            PIP_REQ_END,
            endIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return listOf(
            RemoteAction(icon, getString(R.string.pip_toggle_mute), getString(R.string.pip_toggle_mute), mutePi),
            RemoteAction(icon, getString(R.string.pip_hang_up), getString(R.string.pip_hang_up), endPi),
        )
    }

    /** The PiP aspect ratio: the remote video's frame dimensions if known (the PiP window should match the
     *  video → no letterbox), else the window size until the first frame arrives. Clamped to the valid PiP
     *  range [1/2.39, 2.39]. */
    private fun pipAspectRatio(): Rational {
        val (w, h) = CallController.remoteVideoDimensions() ?: run {
            val content = findViewById<View>(android.R.id.content)
            val cw = content?.takeIf { it.width > 0 }?.width ?: resources.displayMetrics.widthPixels
            val ch = content?.takeIf { it.height > 0 }?.height ?: resources.displayMetrics.heightPixels
            cw to ch
        }
        val ratio = w.toFloat() / h.toFloat()
        return when {
            ratio < 1f / 2.39f -> Rational(1, 3)
            ratio > 2.39f -> Rational(3, 1)
            else -> Rational(w, h)
        }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        CallController.setSystemPipMode(isInPictureInPictureMode)
        // Tell the web chrome it's in PiP so it hides the top-bar/controls/self-view (only the native remote
        // video should show in the PiP window). The native surfaces are siblings of the WebView, so they keep
        // rendering regardless; the web just stops drawing chrome over them.
        SomsBridge.eval("window.__SOMS_PIP__ && window.__SOMS_PIP__($isInPictureInPictureMode);")
    }

    override fun onResume() {
        super.onResume()
        applyCallDisplayFlags()
        // Belt-and-suspenders WebView capture for the async-creation race (see captureWebView). Usually
        // a no-op because onWebViewCreate has already set SomsBridge.webView.
        captureWebView()
        SomsMessagingService.appInForeground = true
        SomsLog.i("Ui") { "onResume → appInForeground=true" }
        // App visible: start the realtime service and, if background realtime is enabled, promote it
        // BEFORE leaving the activity. The persistent FGS notification stays visible across fg/bg;
        // onStop cannot safely start a new FGS after Android has classified the app as backgrounded.
        // The start is guarded for two reasons:
        //  1. No session token yet (pre-login, e.g. right after the server-config handoff) → openStream()
        //     stopSelf's immediately, so the start is pointless; skip it. Mirrors onStop's token guard.
        //  2. onResume can fire while the system still considers the process "background" (during the
        //     init→main window handoff, or a crash-restart), and startService then throws
        //     BackgroundServiceStartNotAllowedException (Android 12+). Letting that propagate crashes the
        //     activity ("Unable to resume activity") → process killed → restart → onResume → throw — the
        //     nonstop crash-restart loop seen as a flicker. Catching it is safe: the next fg/bg cycle
        //     retries, and any missed realtime frames are backstopped by the WebView's HWM catch-up.
        if (SomsSecureStore.getSessionToken(this) != null) {
            try {
                startRealtimeServiceWhileVisible()
            } catch (e: RuntimeException) {
                Log.w("SomsActivity", "realtime start skipped: ${e.javaClass.simpleName}: ${e.message}")
            }
        }
        // Keep other conversations' cards on return. The foreground chat clears only its own card
        // through the WebView notification adapter once the visible chat state is known.
    }

    override fun onStop() {
        super.onStop()
        SomsMessagingService.appInForeground = false
        SomsLog.i("Ui") {
            "onStop → appInForeground=false fgsEnabled=${SomsSecureStore.getForegroundServiceEnabled(this)} tokenPresent=${SomsSecureStore.getSessionToken(this) != null}"
        }
        // Never start/promote a service after leaving the visible state. The enabled FGS was promoted
        // while visible; with the toggle off (or on logout), background delivery uses FCM / WorkManager.
        if (!SomsSecureStore.getForegroundServiceEnabled(this) ||
            SomsSecureStore.getSessionToken(this) == null) {
            stopService(Intent(this, RealtimeService::class.java))
        }
    }

    override fun onDestroy() {
        launchOverlay?.removeCallbacks(launchTimeout)
        launchOverlay = null
        launchStatus = null
        finishNativeVoiceRecording(cancel = true)
        nativeComposer.destroy()
        // Drop the webview reference so a destroyed activity can be GC'd; the FCM service may keep
        // running in the process but its eval() becomes a no-op until the next activity attaches.
        SomsBridge.webView = null
        // Release the process-global hooks bound to THIS activity so they neither fire on a dead activity (a
        // phase change after destroy would otherwise runOnUiThread -> applyCallDisplayFlags on a gone window)
        // nor hold orphaned video surfaces. The call itself survives (CallController + CallService FGS are
        // process-global); only the activity-bound bindings are dropped here.
        CallController.setPhaseListener(null)
        CallController.setVideoGeometryListener(null)
        CallController.onWebViewGone()
        super.onDestroy()
    }

    internal fun nativeVoiceRecording(): Boolean = nativeVoiceFile != null

    internal fun cancelPendingNativeVoiceStart() {
        pendingVoiceStart = null
    }

    internal fun beginNativeVoiceRecording(
        contextId: Long,
        threadId: Long,
        @Suppress("UNUSED_PARAMETER") actionId: Long,
    ) {
        if (nativeVoiceFile != null || threadId <= 0L) return
        val start = { startNativeVoiceRecorder(contextId, threadId) }
        if (
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            start()
        } else {
            pendingVoiceStart = start
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_VOICE_PERM)
        }
    }

    @Suppress("DEPRECATION")
    private fun startNativeVoiceRecorder(contextId: Long, threadId: Long) {
        val file = File(cacheDir, "voice-${UUID.randomUUID()}.m4a")
        val recorder = MediaRecorder()
        try {
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            recorder.setAudioEncodingBitRate(64_000)
            recorder.setAudioSamplingRate(44_100)
            recorder.setOutputFile(file.absolutePath)
            recorder.prepare()
            recorder.start()
            nativeVoiceRecorder = recorder
            nativeVoiceFile = file
            nativeVoiceStartedAt = android.os.SystemClock.elapsedRealtime()
            nativeVoiceDurationMs = 0L
            nativeVoiceContextId = contextId
            nativeVoiceThreadId = threadId
            nativeComposer.onVoiceRecordingStarted()
            nativeVoiceCapTask = Runnable {
                val active = nativeVoiceRecorder ?: return@Runnable
                nativeVoiceDurationMs = VoiceRecordingGesture.MAX_DURATION_MS
                nativeVoiceRecorder = null
                runCatching { active.stop() }
                runCatching { active.release() }
                nativeComposer.onVoiceRecordingCapped()
                // Keep nativeVoiceFile and the composer gesture alive. ACTION_UP still chooses send/cancel.
            }.also {
                window.decorView.postDelayed(it, VoiceRecordingGesture.MAX_DURATION_MS)
            }
        } catch (error: Throwable) {
            runCatching { recorder.release() }
            file.delete()
            SomsLog.w("Voice", error) { "native recorder start failed" }
            nativeComposer.onVoiceRecordingFinished()
            android.widget.Toast.makeText(
                this,
                getString(R.string.composer_recording_failed),
                android.widget.Toast.LENGTH_SHORT,
            ).show()
        }
    }

    internal fun finishNativeVoiceRecording(cancel: Boolean) {
        val recorder = nativeVoiceRecorder
        val file = nativeVoiceFile
        if (recorder == null && file == null) return
        nativeVoiceCapTask?.let { window.decorView.removeCallbacks(it) }
        nativeVoiceCapTask = null
        val duration = if (nativeVoiceDurationMs > 0L) {
            nativeVoiceDurationMs
        } else {
            android.os.SystemClock.elapsedRealtime() - nativeVoiceStartedAt
        }
        nativeVoiceRecorder = null
        nativeVoiceFile = null
        nativeVoiceDurationMs = 0L
        nativeComposer.onVoiceRecordingFinished()
        if (recorder != null) {
            runCatching { recorder.stop() }
            runCatching { recorder.release() }
        }
        if (cancel || VoiceRecordingGesture.isTooShort(duration) || file == null || !file.isFile || file.length() == 0L) {
            file?.delete()
            if (!cancel && VoiceRecordingGesture.isTooShort(duration)) {
                android.widget.Toast.makeText(
                    this,
                    getString(R.string.composer_recording_too_short),
                    android.widget.Toast.LENGTH_SHORT,
                ).show()
            }
            return
        }
        RustUploadBridge.uploadVoicePath(
            file.absolutePath,
            nativeVoiceContextId,
            nativeVoiceThreadId,
            UUID.randomUUID().toString(),
            duration,
            file.length(),
        )
    }

    /** Result of the POST_NOTIFICATIONS prompt (Android 13+). We don't branch on grant/deny — the Settings
     *  panel re-reads [SomsFcmInterface.getNotificationStatus] for the live state — but we DO record that a
     *  request has been shown, so `canRequest` can distinguish "never asked" from "permanently denied":
     *  `shouldShowRequestPermissionRationale` returns false in BOTH cases, so this flag is the discriminator. */
    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_POST_NOTIF) {
            SomsSecureStore.setNotifPermRequested(this, true)
            return
        }
        if (requestCode == REQ_VOICE_PERM) {
            val start = pendingVoiceStart
            pendingVoiceStart = null
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
                start?.invoke()
            } else if (start != null) {
                android.widget.Toast.makeText(
                    this,
                    getString(R.string.composer_recording_permission_denied),
                    android.widget.Toast.LENGTH_SHORT,
                ).show()
            }
            return
        }
        if (requestCode == REQ_CALL_PERMS) {
            // The deferred initiate/accept that awaited a RECORD_AUDIO (+ CAMERA for VIDEO) grant. Run it
            // only if every requested permission was granted; otherwise drop the call (the mic/camera is
            // unusable). pendingCallStart is one-shot — cleared here either way.
            val granted = grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }
            val action = pendingCallStart
            val denied = pendingCallDenied
            pendingCallStart = null
            pendingCallDenied = null
            if (granted) action?.invoke()
            else {
                denied?.invoke()
                SomsLog.w("Ui") { "call media permission denied" }
            }
        }
    }

    /** Push the token to the web app's rotation hook. Safe to call whether or not the webview is
     *  attached — SomsBridge.eval no-ops when it isn't, and onWebViewCreate re-emits the current token. */
    private fun emitToken(token: String) {
        SomsBridge.eval("window.__SOMS_FCM_TOKEN__ && window.__SOMS_FCM_TOKEN__(${SomsBridge.jsonStr(token)});")
    }

    /** Navigate the web app to a thread. Calls window.__SOMS_DEEP_LINK__ if registered; the web app
     *  installs that handler at boot (PushService.init), so warm-start routing lands immediately. */
    private fun offerNotificationTap(intent: Intent): Boolean = SomsBridge.DeepLink.offer(
        intent.getStringExtra(SomsMessagingService.EXTRA_THREAD_ID),
        intent.getIntExtra(SomsMessagingService.EXTRA_SESSION_ID, -1),
        intent.getStringExtra(SomsMessagingService.EXTRA_API_ORIGIN),
        SomsSecureStore.getSessionId(this),
        SomsSecureStore.getApiOrigin(this),
    )

    /** Fetch the current FCM registration token asynchronously and stash it for the JS bridge. Delegates to
     *  [SomsFirebase] — under the dynamic-config model FirebaseApp is initialized from the server-fetched
     *  config (persisted in SomsSecureStore at process start by [SomsApplication]), not a bundled
     *  google-services.json. [SomsFirebase.ensureInitialized] is a no-op when already initialized this
     *  process; it returns null only when no config is persisted yet (first run / cleared), in which case
     *  FCM is unavailable and we skip silently — the app runs on foreground SSE + the WorkManager poller. */
    private fun fetchFcmToken() {
        val playServices = GoogleApiAvailability.getInstance()
        val playServicesCode = playServices.isGooglePlayServicesAvailable(this)
        if (playServicesCode != ConnectionResult.SUCCESS) {
            SomsBridge.FcmToken.lastError =
                "PLAY_SERVICES_${playServices.getErrorString(playServicesCode)}"
            return
        }
        if (SomsFirebase.ensureInitialized(this) == null) {
            SomsBridge.FcmToken.lastError = "FIREBASE_NOT_CONFIGURED"
            return
        }
        SomsFirebase.requestToken(this)
    }

    /** Request POST_NOTIFICATIONS (Android 13+) if not yet granted. Called from JS after the first
     *  login so the prompt has user context, not on cold launch. */
    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_POST_NOTIF)
        }
    }

    /** Persist the background-poll preference AND cancel / re-enqueue the WorkManager schedule. Called
     *  from the SomsFcm @JavascriptInterface (setPollingEnabled) — JS is the user-facing surface; this is
     *  the effect on the native schedule. WorkManager is thread-safe, so no thread hop is needed. */
    private fun applyPollingEnabled(enabled: Boolean) {
        SomsSecureStore.setPollingEnabled(this, enabled)
        val wm = WorkManager.getInstance(this)
        if (enabled) {
            // KEEP leaves any existing schedule intact — idempotent, matching the onCreate baseline.
            wm.enqueueUniquePeriodicWork(
                NOTIF_SYNC_WORK,
                ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<NotificationSyncWorker>(6, TimeUnit.HOURS).build(),
            )
        } else {
            wm.cancelUniqueWork(NOTIF_SYNC_WORK)
        }
    }

    /** Start or re-deliver the realtime service only while the activity is visible. A background-enabled
     *  session needs the FGS notification even while in-app, so there is no onStop promotion race. */
    private fun startRealtimeServiceWhileVisible() {
        val intent = Intent(this, RealtimeService::class.java).setAction(RealtimeService.ACTION_FOREGROUND)
        if (SomsSecureStore.getForegroundServiceEnabled(this)) startForegroundService(intent)
        else startService(intent)
    }

    private fun applyForegroundServiceEnabled(enabled: Boolean) {
        if (!SomsMessagingService.appInForeground) {
            // A settings callback can race onStop. Never attempt a new FGS from the background.
            if (!enabled) stopService(Intent(this, RealtimeService::class.java))
            return
        }
        if (SomsSecureStore.getSessionToken(this) == null) return
        try {
            startRealtimeServiceWhileVisible()
        } catch (e: RuntimeException) {
            Log.w("SomsActivity", "realtime toggle start skipped: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    /** Start the active-call foreground service (CallService — the process anchor + the call's audio
     *  routing). Idempotent: starting an already-running service re-delivers onStartCommand (harmless —
     *  acquireAudio is replace-by-token). Guarded against the Android 12+ background-service-start
     *  restriction: a call begins from a user gesture while foregrounded (Phase 2), so this path is allowed;
     *  the catch is belt-and-suspenders for the rare fg/bg race during the init→main window handoff, mirroring
     *  onResume's RealtimeService start guard. Called by SomsCallInterface.initiate / accept. */
    internal fun startCallService() {
        try {
            val binding = NotificationSessionBinding.capture(this) ?: return
            val serviceIntent = Intent(this, CallService::class.java)
            val sid = CallController.callSid ?: return
            serviceIntent.putExtra(CallService.EXTRA_SID, sid)
            binding.attach(serviceIntent, "outgoing-service", sid)
            startForegroundService(serviceIntent)
        } catch (e: RuntimeException) {
            Log.w("SomsActivity", "call service start skipped: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    /** The deferred call-start action awaiting a RECORD_AUDIO (+ CAMERA for VIDEO) grant. One-shot: cleared
     *  in [onRequestPermissionsResult] whether granted or not. Null when no call is pending a permission. */
    private var pendingCallStart: (() -> Unit)? = null
    private var pendingCallDenied: (() -> Unit)? = null

    /** Accept the incoming call launched from its ringing notification's Answer button / full-screen intent.
     *  CallController was already seeded incoming by the FCM wake-up (CallService.startIncoming); accept stops
     *  the ring + switches to comms audio + POSTs /calls/accept + builds the PC. Mic (+ camera for VIDEO) is
     *  gated first (same path as the in-app accept button). Runs on the UI thread (onCreate/onNewIntent). */
    private fun handleCallAnswer(sid: String, source: Intent?) {
        val binding = NotificationSessionBinding.fromIntent(source) ?: return
        if (!binding.isCurrent(this) || CallController.callSid != sid) return
        ensureCallPermissions(CallController.callType) {
            // Permission UI can outlive logout or server/account switching.
            if (binding.isCurrent(this) && CallController.callSid == sid) CallController.accept(sid)
        }
    }

    /** Show the call UI over the lock screen + turn the screen on while a call is live (so an incoming ring on
     *  a locked device surfaces the call UI), and revert otherwise (the app must not pin over the lock screen
     *  when no call is active). Call-gated (not manifest always-on) — re-evaluated on each phase change
     *  ([CallController.setPhaseListener]) + the activity lifecycle. */
    private fun applyCallDisplayFlags() {
        val live = CallController.phase.let { it != "idle" && it != "ended" }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(live)
            setTurnScreenOn(live)
        } else {
            val flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            if (live) window.addFlags(flags) else window.clearFlags(flags)
        }
    }

    /** Ensure RECORD_AUDIO (+ CAMERA for VIDEO) is granted before a call captures media; run [andThen]
     *  (startCallService + CallController.initiate/accept) once granted. The native RTCPeerConnection is NOT
     *  the WebView, so RustWebChromeClient.onPermissionRequest (which grants AUDIO_CAPTURE to the WebView
     *  only) does NOT cover it — without this the mic captures SILENCE (WebRtcAudioRecord releases its
     *  resources with no permission) and the call connects with no audio. The grant persists, so this prompts
     *  at most once per permission. Must run on the UI thread (permission requests are Activity-scoped). */
    internal fun ensureCallPermissions(callType: String, andThen: () -> Unit) {
        // Request the FULL call-media permission set up front in ONE batched prompt, so the user grants once
        // and audio + video + Bluetooth-headset routing all work afterwards — no piecemeal re-prompts. The
        // native RTCPeerConnection is NOT the WebView, so RustWebChromeClient.onPermissionRequest
        // (WebView-only) does not cover it; without RECORD_AUDIO the mic captures SILENCE (the call connects
        // with no audio). CAMERA is for VIDEO calls; BLUETOOTH_CONNECT is for routing call audio to a headset
        // (dangerous on API 31+, normal below → checkSelfPermission returns GRANTED there, so it's only added
        // where it matters). `callType` is kept for future granularity (e.g. skip CAMERA on a pure-AUDIO
        // flow) but the current policy is "ask for all once". UI thread (permission requests are Activity-scoped).
        // Only the permissions the call ACTUALLY uses: RECORD_AUDIO (mic) + CAMERA (video). BLUETOOTH_CONNECT
        // is intentionally NOT requested — it's only needed to route call audio to a BT headset, which isn't
        // implemented yet (CallService sets MODE_IN_COMMUNICATION; no startBluetoothSco). Requesting an unused
        // permission is premature (and it's an API 31+ perm that returns DENIED on older devices, which used
        // to fail the whole batch). When BT-headset routing lands, request it JUST-IN-TIME on detecting a
        // connected headset (AudioManager BluetoothHeadset profile) so the prompt only fires when relevant.
        val perms = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (callType == "VIDEO") add(Manifest.permission.CAMERA)
        }
        val needed = perms.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (needed.isEmpty()) {
            andThen()
            return
        }
        pendingCallStart = andThen
        pendingCallDenied = null
        requestPermissions(needed.toTypedArray(), REQ_CALL_PERMS)
    }

    /** Camera is requested just-in-time when an established audio call upgrades. A denial is non-terminal:
     *  the native controller reports a failed upgrade while the existing microphone/audio connection stays
     *  active. */
    private fun ensureVideoPermission(andThen: () -> Unit, onDenied: () -> Unit) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            andThen()
            return
        }
        pendingCallStart = andThen
        pendingCallDenied = onDenied
        requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CALL_PERMS)
    }

    /** Next scheduled WorkManager poll time (epoch ms), or -1 if not scheduled. For the Settings display.
     *  Blocks on the work-info query — safe because @JavascriptInterface methods run on a background thread. */
    private fun nextPullTime(): Long {
        return try {
            val info = WorkManager.getInstance(this)
                .getWorkInfosForUniqueWork(NOTIF_SYNC_WORK).get().firstOrNull()
                ?: return -1L
            val t = info.nextScheduleTimeMillis
            if (t == Long.MIN_VALUE || t <= 0L) -1L else t
        } catch (e: Exception) {
            -1L
        }
    }

    /** FCM availability check, throttled to once/day (explicit user wish — a mainland-China device without GMS
     *  shouldn't hammer Google on every launch). First run (no cached token) always checks; thereafter
     *  auto at most every [FCM_CHECK_INTERVAL_MS]; a manual "check now" (requestFcmCheck) bypasses it. */
    private fun maybeFetchFcmToken() {
        val now = System.currentTimeMillis()
        val hasToken = SomsBridge.FcmToken.current != null
        if (hasToken && now - SomsSecureStore.getFcmLastCheck(this) < FCM_CHECK_INTERVAL_MS) return
        fetchFcmToken()
        SomsSecureStore.setFcmLastCheck(this, now)
    }

    /** JS-callable surface exposed as window.SomsFcm. Mirrors Ipc.kt's @JavascriptInterface pattern.
     *  Methods run on a background JS thread, so anything touching the UI threads back to runOnUiThread. */
    private class SomsFcmInterface(activity: MainActivity) {
        private val activityRef = java.lang.ref.WeakReference(activity)

        /** Synchronous read of the current FCM token (or null). The web app polls this at boot/login. */
        @JavascriptInterface
        fun getToken(): String? = SomsBridge.FcmToken.current

        @JavascriptInterface
        fun preparePushRegistration(requestId: String, replace: Boolean) {
            val a = activityRef.get() ?: return
            a.runOnUiThread { SomsFirebase.preparePushRegistration(a, requestId, replace) }
        }

        /** Trigger an async token refresh (Firebase re-issues via the token task + onNewToken). */
        @JavascriptInterface
        fun requestToken() {
            val a = activityRef.get() ?: return
            a.runOnUiThread { a.fetchFcmToken() }
        }

        /** Request the system POST_NOTIFICATIONS permission (Android 13+). */
        @JavascriptInterface
        fun requestNotificationPermission() {
            val a = activityRef.get() ?: return
            a.runOnUiThread { a.requestNotificationPermission() }
        }

        // Historical bridge names; the value is an opaque {id, threadId, sessionId} JSON receipt.
        // Echo the exact receipt only after JS accepts selection, not merely on reading the tap.
        @JavascriptInterface
        fun getPendingThreadId(): String? = SomsBridge.DeepLink.peek()

        @JavascriptInterface
        fun acknowledgeThreadId(receipt: String) = SomsBridge.DeepLink.acknowledge(receipt)

        @JavascriptInterface
        fun clearMessageNotifications() {
            val a = activityRef.get() ?: return
            SomsMessagingService.clearSessionMessageNotifs(a)
        }

        /** UI state only: Rust owns the notification projection and Kotlin owns presentation. */
        @JavascriptInterface
        fun setActiveThreadId(threadId: Int) {
            val a = activityRef.get() ?: return
            val selected = threadId.takeIf { it > 0 } ?: -1
            SomsMessagingService.activeThreadId = selected
            if (selected > 0 && SomsMessagingService.appInForeground)
                a.runOnUiThread { SomsMessagingService.clearThreadNotification(a, selected) }
        }

        /** Push the session token (POST /auth/login, app client) into encrypted storage so the Kotlin-owned
         *  /events stream (RealtimeService) and the background Rust thread-feed fetchers
         *  (FCM / WorkManager) can authenticate while the WebView is suspended. Called from JS on login;
         *  pass null/empty on logout to clear. */
        @JavascriptInterface
        fun setSessionToken(token: String?) {
            val a = activityRef.get() ?: return
            SomsSecureStore.setSessionToken(a, token)
            // The realtime service lifecycle follows the session: a freshly-persisted token (login) opens
            // the /events stream the WebView consumes; clearing it (logout) tears the stream down.
            // A login may race the activity leaving the screen. Start/promote only while visible;
            // otherwise FCM / WorkManager cover the background until the next onResume.
            if (token.isNullOrEmpty()) {
                SomsBridge.DeepLink.clear()
                a.stopService(Intent(a, RealtimeService::class.java))
            } else if (SomsMessagingService.appInForeground) {
                try {
                    a.startRealtimeServiceWhileVisible()
                } catch (e: RuntimeException) {
                    Log.w("SomsActivity", "realtime login start skipped: ${e.javaClass.simpleName}: ${e.message}")
                }
            }
        }

        /** Synchronous read of the persisted session token from encrypted storage — the SAME store
         *  setSessionToken writes and RealtimeService reads. The WebView's AuthService.restoreSession calls
         *  this on a cold start to re-establish the session with NO plaintext copy in JS storage (so the
         *  token rests encrypted only). Returns null when no token is stored (logged out / first run). */
        @JavascriptInterface
        fun getSessionToken(): String? {
            val a = activityRef.get() ?: return null
            return SomsSecureStore.getSessionToken(a)
        }

        /** Synchronous read of the RealtimeService's last-pushed connection state
         *  ('connecting'|'open'|'reconnecting'|'closed'), so a freshly-booted WebView can seed its
         *  connection-state signal before the next transition (Kotlin only pushes on transitions). */
        @JavascriptInterface
        fun getConnState(): String = RustRuntimeBridge.realtimeGetState()

        /** Delegate login reachability to the same Rust origin selector used by the realtime runtime. */
        @JavascriptInterface
        fun pickActiveOrigin(): String? {
            if (activityRef.get() == null) return null
            return RustRuntimeBridge.realtimePickOrigin()
        }

        /** User tapped the disconnected chip: tell RealtimeService to cancel its pending backoff and
         *  reconnect immediately (parity with the worker's retry-now and Rust's sse_net(online:true)).
         *  Delivered as an Intent action the same way ACTION_FOREGROUND/BACKGROUND are; a no-op if the
         *  stream is already open. */
        @JavascriptInterface
        fun retryNow() {
            val a = activityRef.get() ?: return
            a.startService(Intent(a, RealtimeService::class.java).setAction(RealtimeService.ACTION_RETRY))
        }

        /** HELLO-timeout path (the client's 10s HELLO watchdog fired): the open stream is unusable — no
         *  HELLO within the deadline — so the WebView asks Kotlin to CANCEL the open EventSource + reopen it
         *  (JS cannot close the native socket). The fresh connection re-pushes HELLO. Distinct from
         *  [retryNow] (ACTION_RETRY), which only cancels pending backoff and is a no-op against an already-
         *  open stream — useless for the dead-open case the HELLO-timeout detects. */
        @JavascriptInterface
        fun forceReconnect() {
            val a = activityRef.get() ?: return
            a.startService(Intent(a, RealtimeService::class.java).setAction(RealtimeService.ACTION_FORCE_RECONNECT))
        }

        /** Re-attached-WebView (renderer reclaim / FGS-pre-connected cold start) handshake replay: hand the
         *  freshly-booted WebView the cached+merged HELLO. A retained open `/events` stream does NOT re-push
         *  HELLO on its own (it is sent once per register), so this cache (kept fresh by
         *  the Rust runtime) is how the WebView bootstraps (userId / threadRevision /
         *  profileRev / latestMessage) without a reconnect. No-op when the cache is empty
         *  (the facade's HELLO-timeout backstop then force-reconnects for a fresh one). */
        @JavascriptInterface
        fun replayHello() {
            val activity = activityRef.get() ?: return
            val token = synchronized(SomsSecureStore) { SomsSecureStore.getSessionToken(activity) }
            val raw = RustRuntimeBridge.realtimeReplayHello() ?: return
            val snapshot = org.json.JSONObject(raw)
            val generation = snapshot.getLong("generation")
            val hello = snapshot.getJSONObject("hello")
            activity.runOnUiThread {
                if (token != SomsSecureStore.getSessionToken(activity) || !RustRuntimeBridge.realtimeIsCurrent(generation)) return@runOnUiThread
                SomsBridge.eval("window.__SOMS_EVENT__ && window.__SOMS_EVENT__('HELLO', $hello);")
            }
        }

        /** Whether the 6-hour background-sync poller is enabled (default true). Read by the Settings page
         *  to render the toggle's initial state. */
        @JavascriptInterface
        fun getPollingEnabled(): Boolean {
            val a = activityRef.get() ?: return true
            return SomsSecureStore.getPollingEnabled(a)
        }

        /** Enable/disable the 6-hour background-sync poller — persists the pref into encrypted storage
         *  AND cancels / re-enqueues the WorkManager schedule. */
        @JavascriptInterface
        fun setPollingEnabled(enabled: Boolean) {
            val a = activityRef.get() ?: return
            a.applyPollingEnabled(enabled)
        }

        /** Whether the dataSync foreground service (RealtimeService) is enabled (default true). */
        @JavascriptInterface
        fun getForegroundServiceEnabled(): Boolean {
            val a = activityRef.get() ?: return false
            return SomsSecureStore.getForegroundServiceEnabled(a)
        }

        /** Enable/disable the foreground service — persists the pref and starts/stops it to match. */
        @JavascriptInterface
        fun setForegroundServiceEnabled(enabled: Boolean) {
            val a = activityRef.get() ?: return
            SomsSecureStore.setForegroundServiceEnabled(a, enabled)
            a.applyForegroundServiceEnabled(enabled)
        }

        /** The away-notification grouping pref — "thread" (one card per conversation, default) or "all" (one
         *  folded card). Device-local; the next background fetch sends it as `grouping`. Read by the Settings
         *  page to render the segmented control's initial state. */
        @JavascriptInterface
        fun getNotificationPreviewMode(): String {
            if (activityRef.get() == null) return "message"
            return ClientStateDb.getNotificationPreviewMode()
        }

        /** Set the away-notification grouping pref ("thread" | "all"). Persists immediately; takes effect on
         *  the next background fetch (no live notification to rebuild). */
        @JavascriptInterface
        fun setNotificationPreviewMode(mode: String) {
            val a = activityRef.get() ?: return
            ClientStateDb.setNotificationPreviewMode(mode)
            SomsMessagingService.clearAllMessageNotifs(a)
        }

        @JavascriptInterface
        fun getNotificationAlertPolicy(): String {
            if (activityRef.get() == null) return "cooldown_5s"
            return ClientStateDb.getNotificationAlertPolicy()
        }

        @JavascriptInterface
        fun setNotificationAlertPolicy(policy: String) {
            if (activityRef.get() == null) return
            ClientStateDb.setNotificationAlertPolicy(policy)
        }

        /** Next scheduled WorkManager poll time (epoch ms), or -1 if not scheduled. For the Settings row. */
        @JavascriptInterface
        fun getNextPullTime(): Long {
            val a = activityRef.get() ?: return -1L
            return a.nextPullTime()
        }

        /** FCM status snapshot for the Settings page: `{ hasToken, lastCheck }`. `hasToken` is the proxy
         *  for "FCM available" (a token was obtained → Google Play Services present). */
        @JavascriptInterface
        fun getFcmStatus(): String {
            val a = activityRef.get()
            val hasToken = SomsBridge.FcmToken.current != null
            val lastCheck = a?.let { SomsSecureStore.getFcmLastCheck(it) } ?: 0L
            val playServices = GoogleApiAvailability.getInstance()
            val playServicesCode = a?.let { playServices.isGooglePlayServicesAvailable(it) }
                ?: ConnectionResult.INTERNAL_ERROR
            return JSONObject()
                .put("hasToken", hasToken)
                .put("lastCheck", lastCheck)
                .put("playServicesAvailable", playServicesCode == ConnectionResult.SUCCESS)
                .put("playServicesStatus", playServices.getErrorString(playServicesCode))
                .put("tokenError", SomsBridge.FcmToken.lastError ?: JSONObject.NULL)
                .toString()
        }

        /** System notification status for the Settings panel: `{ enabled, canRequest }`.
         *  `enabled` = the master app-level toggle (areNotificationsEnabled — covers pre-13 default-on and
         *  post-13 granted). `canRequest` = calling requestNotificationPermission right now would actually
         *  surface the system prompt: only on Android 13+, while not yet enabled, AND either never asked
         *  (notif_perm_requested == false) OR not permanently denied (rationale still showable).
         *  Permanently-denied (asked, rationale false) → canRequest false → the panel routes the user to
         *  system settings instead. Thread-safe reads (NotificationManagerCompat + SecureStore), so no hop. */
        @JavascriptInterface
        fun getNotificationStatus(): String {
            val a = activityRef.get()
            val enabled = a != null && NotificationManagerCompat.from(a).areNotificationsEnabled()
            val canRequest = a != null &&
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                !enabled &&
                (!SomsSecureStore.getNotifPermRequested(a) ||
                    a.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))
            return JSONObject().put("enabled", enabled).put("canRequest", canRequest).toString()
        }

        /** Whether the POST_NOTIFICATIONS prompt has EVER been shown (persisted across process deaths).
         *  Lets JS seed its one-shot auto-prompt guard so the prompt fires once EVER (first login), not once
         *  per cold start — set by [MainActivity.onRequestPermissionsResult], read by PushService at boot. */
        @JavascriptInterface
        fun getNotifPermRequested(): Boolean {
            val a = activityRef.get() ?: return false
            return SomsSecureStore.getNotifPermRequested(a)
        }

        /** Open the system per-app notification settings — the manual path when canRequest is false
         *  (permanently denied on 13+, or pre-13 where there's no runtime prompt at all). Works on every
         *  Android version: ACTION_APP_NOTIFICATION_SETTINGS on API 26+, ACTION_APPLICATION_DETAILS_SETTINGS
         *  (the app's full settings page) as the pre-26 fallback. startActivity must run on the UI thread. */
        @JavascriptInterface
        fun openNotificationSettings() {
            val a = activityRef.get() ?: return
            a.runOnUiThread {
                val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, a.packageName)
                } else {
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        .setData(android.net.Uri.fromParts("package", a.packageName, null))
                }
                try {
                    a.startActivity(intent)
                } catch (e: Exception) {
                    Log.w("SomsActivity", "openNotificationSettings failed: ${e.message}")
                }
            }
        }

        /** Manual "check now" from Settings: force an FCM token fetch + refresh the last-check timestamp,
         *  bypassing the daily gate. */
        @JavascriptInterface
        fun requestFcmCheck() {
            val a = activityRef.get() ?: return
            a.runOnUiThread {
                a.fetchFcmToken()
                SomsSecureStore.setFcmLastCheck(a, System.currentTimeMillis())
            }
        }

        /** Hand the server's Firebase client config (the 4 fields from the web's `/client/compat` payload)
         *  to native. Persists it in EncryptedSharedPreferences and
         *  (re)initializes FirebaseApp via [SomsFirebase.reconfigure]: a different project → deleteToken +
         *  deleteApp + re-init + a fresh token that flows back through `window.__SOMS_FCM_TOKEN__`. Pass
         *  null/empty to clear (server returned `{configured:false}`). Hops to the UI thread — Firebase's
         *  token Task listeners fire on main, and reconfigure must run there for a consistent app instance. */
        @JavascriptInterface
        fun setFirebaseConfig(config: String?) {
            val a = activityRef.get() ?: return
            SomsLog.i("Firebase") {
                "bridge setFirebaseConfig received; configured=${!config.isNullOrBlank()}"
            }
            a.runOnUiThread {
                SomsLog.i("Firebase") { "bridge reconfigure UI task start" }
                SomsFirebase.reconfigure(a, config)
                SomsLog.i("Firebase") { "bridge reconfigure UI task returned" }
            }
        }

        /** Synchronous read of the currently-persisted Firebase client config JSON string (or null). The web
         *  uses it to avoid re-pushing an identical config (which would cause needless token churn). */
        @JavascriptInterface
        fun getFirebaseConfig(): String? {
            val a = activityRef.get() ?: return null
            SomsLog.i("Firebase") { "bridge getFirebaseConfig start" }
            val config = SomsSecureStore.getFirebaseConfig(a)
            SomsLog.i("Firebase") {
                "bridge getFirebaseConfig returned; configured=${config != null}"
            }
            return config
        }
    }

    /** JS-callable surface exposed as window.SomsBack. The nav state machine calls exit() (via
     *  window.SomsBack.exit()) when hardware-back has nothing left to peel — finishing the activity = the
     *  app exit. @JavascriptInterface methods run on a background JS thread, so finish() hops to the UI thread. */
    private class SomsBackInterface(activity: MainActivity) {
        private val activityRef = java.lang.ref.WeakReference(activity)

        @JavascriptInterface
        fun exit() {
            val a = activityRef.get() ?: return
            a.runOnUiThread { a.finish() }
        }
    }

    /** JS-callable surface exposed as window.SomsShell. The web app calls getSafeInsets() in main.ts
     *  BEFORE bootstrapApplication() to set --soms-safe-top on :root (FOUC-free first paint). Android
     *  WebView is edge-to-edge but env(safe-area-inset-*) returns 0, so this is the only source of the
     *  per-device status-bar / gesture-bar inset. @JavascriptInterface runs on a background JS thread;
     *  it only reads the volatile fields, so no thread hop is needed. */
    private class SomsShellInterface(activity: MainActivity) {
        private val activityRef = java.lang.ref.WeakReference(activity)

        /** Status-bar / gesture-bar insets in CSS px, as JSON `{"top":int,"bottom":int}`. */
        @JavascriptInterface
        fun getSafeInsets(): String {
            val a = activityRef.get()
            return JSONObject()
                .put("top", a?.safeInsetTopCss ?: 0)
                .put("bottom", a?.safeInsetBottomCss ?: 0)
                .toString()
        }

        /** Update the restrained, native-localized launch label. Unknown stages are ignored. */
        @JavascriptInterface
        fun setSplashStage(stage: String) {
            val a = activityRef.get() ?: return
            a.runOnUiThread { a.updateLaunchStage(stage) }
        }

        /** Angular calls this only after its initial route has settled and stable content has painted. */
        @JavascriptInterface
        fun finishSplash() {
            val a = activityRef.get() ?: return
            a.runOnUiThread { a.dismissLaunchOverlay() }
        }

        /** Keep transparent edge-to-edge system-bar icons legible when the web theme overrides the OS. */
        @JavascriptInterface
        fun setSystemBarTheme(dark: Boolean) {
            val a = activityRef.get() ?: return
            a.runOnUiThread { a.applySystemBarTheme(dark) }
        }

        /** Keep Kotlin/native diagnostics aligned with the web and Rust runtime debug gates. */
        @JavascriptInterface
        fun setDebugLogging(enabled: Boolean) {
            SomsLog.setEnabled(enabled)
        }

        /** Atomic boot/reload snapshot; runtime changes arrive through __SOMS_IME_EVENT__. */
        @JavascriptInterface
        fun getImeSnapshot(): String {
            val a = activityRef.get()
            val current = a?.imeHeightCss ?: 0
            return JSONObject()
                .put("currentPx", current)
                .put("visible", a?.imeVisible ?: false)
                .put("requestId", a?.imeRequestId ?: JSONObject.NULL)
                .toString()
        }

        /** Atomic capability only; Angular owns focus, timing, and keyboard-mode policy. */
        @JavascriptInterface
        fun setImeVisible(visible: Boolean, requestId: Long) {
            activityRef.get()?.setImeVisible(visible, requestId)
        }

        @JavascriptInterface
        fun showComposer(contextJson: String) {
            activityRef.get()?.runOnUiThread {
                activityRef.get()?.nativeComposer?.show(contextJson)
            }
        }

        @JavascriptInterface
        fun setComposerBounds(boundsJson: String) {
            activityRef.get()?.runOnUiThread {
                activityRef.get()?.nativeComposer?.setBounds(boundsJson)
            }
        }

        @JavascriptInterface
        fun updateComposer(patchJson: String) {
            activityRef.get()?.runOnUiThread {
                activityRef.get()?.nativeComposer?.update(patchJson)
            }
        }

        @JavascriptInterface
        fun acknowledgeComposerAction(actionId: Long, accepted: Boolean) {
            activityRef.get()?.runOnUiThread {
                activityRef.get()?.nativeComposer?.acknowledge(actionId, accepted)
            }
        }

        @JavascriptInterface
        fun hideComposer(contextId: Long) {
            activityRef.get()?.runOnUiThread {
                activityRef.get()?.nativeComposer?.hide(contextId)
            }
        }

        /** Clear HTTP memory/disk cache only. Cookies, DOM storage, IndexedDB, and login state survive. */
        @JavascriptInterface
        fun clearWebViewCache() {
            val a = activityRef.get() ?: return
            a.runOnUiThread {
                SomsBridge.webView?.clearCache(true)
                SomsLog.i("Ui") { "WebView HTTP cache cleared from Settings" }
            }
        }
    }

    /** JS-callable surface exposed as window.SomsSecureStore — the WebView-independent persistence the
     *  web seeds `apiOrigin` from at boot and the native SSE (RealtimeService)
     *  reads. Backed by EncryptedSharedPreferences via [SomsSecureStore]; absent on desktop/browser,
     *  where the web substitutes a localStorage shim. @JavascriptInterface methods run on a background
     *  JS thread and only touch the thread-safe [SomsSecureStore] object, so no thread hop is needed. */
    private class SomsSecureStoreInterface(activity: MainActivity) {
        private val activityRef = java.lang.ref.WeakReference(activity)

        /** The persisted backend origin (canonical, no trailing slash), or null when not configured. */
        @JavascriptInterface
        fun getApiOrigin(): String? {
            val a = activityRef.get() ?: return null
            return SomsSecureStore.getApiOrigin(a)
        }

        /** Persist the backend origin (null/empty clears). Called from JS `setApiOrigin` on a
         *  server-config save — the single writer; the web never mirrors a boot value back here (that
         *  was the stale-global corruption path). */
        @JavascriptInterface
        fun setApiOrigin(origin: String?) {
            val a = activityRef.get() ?: return
            SomsSecureStore.setApiOrigin(a, origin)
        }

        /** The optional LAN (secondary) origin (null = no fallback). Pushed by JS `setApiOriginSecondary`
         *  on a server-config save; RealtimeService reads it to pick the reachable /events origin. */
        @JavascriptInterface
        fun getApiOriginSecondary(): String? {
            val a = activityRef.get() ?: return null
            return SomsSecureStore.getApiOriginSecondary(a)
        }

        @JavascriptInterface
        fun setApiOriginSecondary(origin: String?) {
            val a = activityRef.get() ?: return
            SomsSecureStore.setApiOriginSecondary(a, origin)
        }
    }

    /** JS-callable surface exposed as window.SomsCall — the COMMAND direction of the native call bridge.
     *  The web's CallAdapter facade (the mirror of NotificationAdapter) calls these; they delegate to the
     *  process-global [CallController] (the RTCPeerConnection + lifecycle FSM owner). The EVENT direction
     *  flows the other way: RealtimeService → CallController, and CallController.pushSnapshot evals
     *  window.__SOMS_CALL_EVENT__ back to JS. The begin-a-call methods (initiate/accept) also start the
     *  [CallService] FGS (the process anchor + audio routing). @JavascriptInterface runs on a background JS
     *  thread; CallController hops to its own serial executor, and getSnapshot reads only @Volatile fields,
     *  so no UI-thread hop is needed. */
    private class SomsCallInterface(activity: MainActivity) {
        private val activityRef = java.lang.ref.WeakReference(activity)

        /** Caller begins a call. Native SQLite presentation is resolved first; only then is the `starting`
         *  snapshot published and the call foreground service started. */
        @JavascriptInterface
        fun initiate(threadId: Int, callSid: String, callType: String, peerAccount: String, peerNamespaceId: Int) {
            val a = activityRef.get() ?: return
            val revision = CallController.captureSessionResourceRevision() ?: return
            val binding = NotificationSessionBinding.capture(a) ?: return
            a.runOnUiThread {
                if (!binding.isCurrent(a)) return@runOnUiThread
                a.ensureCallPermissions(callType) {
                    if (!binding.isCurrent(a)) return@ensureCallPermissions
                    // Native SQLite is the presentation authority. Resolve it off the UI thread and only
                    // publish the starting snapshot after the name/avatar are ready.
                    Thread {
                        val peer = ClientStateDb.getCallPeer(a.applicationContext, peerAccount, peerNamespaceId, threadId)
                        a.runOnUiThread seed@{
                            if (!binding.isCurrent(a)) return@seed
                            if (CallController.initiate(
                                    threadId,
                                    callSid,
                                    callType,
                                    peerAccount,
                                    peerNamespaceId,
                                    peer?.name ?: "",
                                    peer?.avatarDataUrl() ?: "",
                                    revision,
                                )) {
                                a.startCallService()
                            }
                            // A false return means this device already owns a different call. Do not emit
                            // a rejection for that attempt: the existing call must keep its UI and media.
                        }
                    }.start()
                }
            }
        }

        /** Callee accepts the incoming ring: start the call FGS, then POST /calls/accept + create the PC
         *  (the remote offer was applied when the CALL_SIGNAL{offer} arrived — CallController.accept). Gates
         *  on RECORD_AUDIO (+ CAMERA if the incoming call is VIDEO) — reads CallController.callType set by the
         *  incoming event. */
        @JavascriptInterface
        fun accept(callSid: String) {
            val a = activityRef.get() ?: return
            val binding = NotificationSessionBinding.capture(a) ?: return
            a.runOnUiThread {
                a.ensureCallPermissions(CallController.callType) {
                    if (!binding.isCurrent(a) || CallController.callSid != callSid) return@ensureCallPermissions
                    a.startCallService()
                    CallController.accept(callSid)
                }
            }
        }

        @JavascriptInterface
        fun decline(callSid: String) {
            CallController.decline(callSid)
        }

        @JavascriptInterface
        fun cancel(callSid: String) {
            CallController.cancel(callSid)
        }

        @JavascriptInterface
        fun end(callSid: String, reason: String?) {
            CallController.end(callSid, reason)
        }

        /** Relay one WebRTC frame the web layer generated (the renegotiate / media-state path — offers /
         *  answers / ICE are posted natively by CallController's observers on Android). */
        @JavascriptInterface
        fun signal(callSid: String, kind: String, payload: String) {
            CallController.signal(callSid, kind, payload)
        }

        /** Mute/unmute the local mic (CallController toggles the audio track's enabled state). */
        @JavascriptInterface
        fun setMuted(muted: Boolean) {
            CallController.setMuted(muted)
        }

        @JavascriptInterface
        fun setSpeakerEnabled(enabled: Boolean) {
            CallController.setSpeakerEnabled(enabled)
        }

        /** One-way AUDIO→VIDEO upgrade. Camera permission is requested just in time; denying it leaves the
         *  established audio call untouched and only marks the upgrade attempt failed. */
        @JavascriptInterface
        fun upgradeToVideo() {
            val a = activityRef.get() ?: return
            a.runOnUiThread {
                a.ensureVideoPermission(
                    andThen = { CallController.upgradeToVideo() },
                    onDenied = { CallController.videoUpgradePermissionDenied() },
                )
            }
        }

        /** Flip front↔back camera (video only — WhatsApp/FaceTime "flip"). */
        @JavascriptInterface
        fun switchCamera() {
            CallController.switchCamera()
        }

        /** Camera on/off (mute video, keep audio). */
        @JavascriptInterface
        fun setCameraEnabled(enabled: Boolean) {
            val a = activityRef.get() ?: return
            if (!enabled || CallController.hasLocalVideoTrack()) {
                CallController.setCameraEnabled(enabled)
                return
            }
            a.runOnUiThread {
                a.ensureVideoPermission(
                    andThen = { CallController.setCameraEnabled(true) },
                    onDenied = { CallController.videoUpgradePermissionDenied() },
                )
            }
        }

        /** Report the remote + self video "hole" rects (JSON `{x,y,w,h}` in CSS px) so native mounts/positions
         *  its SurfaceViewRenderer overlays; both null detaches them (called on unmount / audio call). */
        @JavascriptInterface
        fun setVideoRect(remote: String?, self: String?) {
            CallController.setVideoRect(remote, self)
        }

        /** High-frequency self-view drag path. Unlike setVideoRect this only applies a native compositor
         *  translation, so a drag frame never causes SurfaceView layout or WebRTC sink churn. */
        @JavascriptInterface
        fun setSelfVideoPosition(x: Double, y: Double) {
            CallController.setSelfVideoPosition(x, y)
        }

        /** Swap which video is full-bleed vs PiP (a tap on the self PiP) — the local camera ↔ the peer's swap
         *  surfaces (mirrors follow). No-op on an AUDIO call. */
        @JavascriptInterface
        fun swapVideo() {
            CallController.swapVideo()
        }

        /** Synchronous JSON snapshot of the live call (or `{phase:"idle"}`) — the web call UI re-derives its
         *  state from this on boot / WebView re-attach with no SSE wait. Mirrors SomsFcm.getConnState. */
        @JavascriptInterface
        fun getSnapshot(): String = CallController.snapshotJson()
    }

    companion object {
        private const val REQ_POST_NOTIF = 1001
        /** Runtime-permission request for a call's mic (+ camera for VIDEO) — see ensureCallPermissions.
         *  Distinct from REQ_POST_NOTIF so onRequestPermissionsResult routes the result to the deferred call. */
        private const val REQ_CALL_PERMS = 1002
        private const val REQ_VOICE_PERM = 1003
        private const val PIP_REQ_MUTE = 7101
        private const val PIP_REQ_END = 7102
        private const val PIP_ENTER_CONFIRM_MS = 750L
        private const val LAUNCH_FADE_MS = 180L
        private const val LAUNCH_TIMEOUT_MS = 8_000L
        private const val NOTIF_SYNC_WORK = "soms-notif-sync"
        /** FCM availability auto-check cadence (the user's "once/day" requirement). */
        private const val FCM_CHECK_INTERVAL_MS = 24L * 60 * 60 * 1000
    }
}
