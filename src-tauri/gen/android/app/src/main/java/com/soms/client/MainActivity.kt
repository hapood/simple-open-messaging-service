package com.soms.client

import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import org.json.JSONObject
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
 *    the IME inset is measured via WindowInsets (Type.ime) and pushed to JS as window.__SOMS_IME_HEIGHT__
 *    (per-frame via WindowInsetsAnimation on API 30+; readable at boot via SomsShell.getImeHeight()) so the
 *    web's KbdOffsetDirective can lift the chat input bar above the keyboard (see ime-insets.service.ts).
 *
 * The webview reference comes from WryActivity.onWebViewCreate — the idiomatic Tauri v2 hook — rather
 * than fishing it out of the view tree, so this stays stable across Tauri versions.
 */
class MainActivity : TauriActivity() {

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
    // as window.__SOMS_IME_HEIGHT__(px) and readable at boot via getImeHeight(). Android WebView's
    // visualViewport doesn't reflect the IME (edge-to-edge, window undivided), so this is the only source of
    // the keyboard height for the web layer.
    @Volatile private var imeHeightCss = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // Hardware-back → the web nav state machine (window.__SOMS_BACK__), which peels one layer (pane →
        // aside → chat → home) and calls SomsBack.exit() when nothing's left. TauriActivity sets
        // handleBackNavigation=false (WryActivity's webview-history default is off), so we own back here.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                SomsBridge.eval("window.__SOMS_BACK__ && window.__SOMS_BACK__();")
            }
        })
        // Capture the cold-start deep link (notification tap that launched the process) before the
        // webview exists; onWebViewCreate will deliver it to JS.
        intent?.getStringExtra(SomsMessagingService.EXTRA_THREAD_ID)?.let {
            SomsBridge.DeepLink.pendingThreadId = it
        }
        // Kick off the FCM token fetch, throttled to once/day (a mainland-China device without GMS shouldn't hammer
        // Google on every launch). First run (no cached token) always fetches so FCM works from session one.
        maybeFetchFcmToken()
        // Schedule the mainland-China fallback poller (~6h periodic). Idempotent across process launches via KEEP:
        // re-enqueuing the same unique work name leaves the existing schedule intact. The worker self-skips
        // when no notification token (logged out) or when the app is foregrounded.
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            NOTIF_SYNC_WORK,
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<NotificationSyncWorker>(6, TimeUnit.HOURS).build(),
        )
        // Measure system-bar insets (status bar / gesture bar) so the web layer can pad content below
        // them. Fires on the first layout pass (~1 frame after attach) and on every inset change.
        installInsetsListener()
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
            navBottomDevicePx = maxOf(nav.bottom, gestures.bottom)
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
                pushImeHeight()
            }
            applySafeInsetsToWebView()
            insets
        }
        // On API 30+ the IME animates open/close (~250ms). Follow it frame-by-frame so the chat input bar
        // slides up in sync with the keyboard (DISPATCH_MODE_STOP: we own the lift — the WebView must NOT
        // auto-resize/scroll for the IME during the animation; after the animation onApplyWindowInsets above
        // fires once with the settled inset). Below API 30 the IME shows/hides instantly, so the
        // onApplyWindowInsets push already carries the final height (the Compat layer never calls onProgress
        // pre-R, so this callback is inert there).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ViewCompat.setWindowInsetsAnimationCallback(content,
                object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_STOP) {
                    override fun onProgress(
                        insets: WindowInsetsCompat,
                        runningAnims: MutableList<WindowInsetsAnimationCompat>,
                    ): WindowInsetsCompat {
                        val d = resources.displayMetrics.density
                        imeHeightCss = Math.max(0, Math.round(insets.getInsets(WindowInsetsCompat.Type.ime()).bottom / d))
                        pushImeHeight()
                        return insets
                    }
                })
        }
        // Pre-API-30 IME source: a global-layout listener that recomputes the keyboard height from the content
        // view's visible display frame. Opening/closing the keyboard resizes the visible frame, which triggers a
        // layout pass → this fires. (onApplyWindowInsets also delivers Type.ime() pre-30, but its Compat backport
        // is unreliable on OEM ROMs — see imeHeightCss.) Guarded on change so a layout pass that doesn't move the
        // keyboard is a no-op. Gated to pre-R: on API 30+ Type.ime() plus the WindowInsetsAnimation callback above
        // are authoritative, so this listener is dormant there.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            content.viewTreeObserver.addOnGlobalLayoutListener {
                val d = resources.displayMetrics.density
                val derived = computeImeFromVisibleFrame(content, navBottomDevicePx)
                val derivedCss = Math.max(0, Math.round(derived / d))
                if (derivedCss != imeHeightCss) {
                    imeHeightCss = derivedCss
                    pushImeHeight()
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

    /** Push the current IME (keyboard) height to the webview via window.__SOMS_IME_HEIGHT__ (installed before
     *  bootstrap by the web's ime-insets.service.ts → ImeInsetsService). KbdOffsetDirective reads it as
     *  offset() on Android and lifts the chat input bar above the keyboard (the browser/PWA build keeps the
     *  visualViewport path; Android WebView's visualViewport doesn't reflect the IME). Called per inset change
     *  and per animation frame on API 30+. A no-op before the page has loaded (the eval lands on about:blank,
     *  harmless) — same as applySafeInsetsToWebView. */
    private fun pushImeHeight() {
        val v = SomsBridge.webView ?: return
        v.evaluateJavascript("window.__SOMS_IME_HEIGHT__&&window.__SOMS_IME_HEIGHT__($imeHeightCss);", null)
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        // Enable Chrome DevTools remote inspection (edge://inspect · chrome://inspect over adb) for DEBUG
        // builds ONLY — the JS context is fully exposed (DOM read, arbitrary JS eval), so shipping it in a
        // release APK would be a security hole. Wry/Tauri v2 does NOT auto-enable this even for debuggable
        // builds; it must be turned on explicitly. Static on WebView → applies process-wide to every WebView.
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
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
        // window.SomsNotify.show(text,replace)/clear() — exposes the Android native notification method's params
        // to JS; the web's AndroidNotificationAdapter wraps it (maps the unified `merge` → `replace`).
        webView.addJavascriptInterface(SomsNotifyInterface(this), "SomsNotify")
        // Deliver anything that arrived before the webview was ready.
        SomsBridge.FcmToken.current?.let { emitToken(it) }
        SomsBridge.DeepLink.pendingThreadId?.let {
            SomsBridge.DeepLink.pendingThreadId = null
            openThread(it)
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
        // Warm start: app already running, user tapped a notification. Route straight to the live
        // webview. (setIntent is unnecessary — singleTask + CLEAR_TOP keeps the back stack sane.)
        intent.getStringExtra(SomsMessagingService.EXTRA_THREAD_ID)?.let { openThread(it) }
    }

    override fun onResume() {
        super.onResume()
        // Belt-and-suspenders WebView capture for the async-creation race (see captureWebView). Usually
        // a no-op because onWebViewCreate has already set SomsBridge.webView.
        captureWebView()
        SomsMessagingService.appInForeground = true
        // App visible: ensure the realtime service is running (the WebView's only event source on Android
        // is this /events stream) and drop the persistent FGS notification + away-notification so the
        // in-app UI owns message display again. The start is guarded for two reasons:
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
                startService(Intent(this, RealtimeService::class.java).setAction(RealtimeService.ACTION_FOREGROUND))
            } catch (e: RuntimeException) {
                Log.w("SomsActivity", "realtime start skipped: ${e.javaClass.simpleName}: ${e.message}")
            }
        }
        ContextCompat.getSystemService(this, NotificationManager::class.java)
            ?.cancel(SomsMessagingService.AWAY_NOTIF_ID)
    }

    override fun onStop() {
        super.onStop()
        SomsMessagingService.appInForeground = false
        // Backgrounded: keep the realtime connection alive only if the toggle is on AND the user is logged
        // in (session token present) — promote the already-running service to a foreground service so the
        // system doesn't kill it. Toggle off → stop it (background delivery falls back to FCM/WorkManager).
        if (SomsSecureStore.getForegroundServiceEnabled(this) &&
            SomsSecureStore.getSessionToken(this) != null
        ) {
            startForegroundService(
                Intent(this, RealtimeService::class.java).setAction(RealtimeService.ACTION_BACKGROUND),
            )
        } else {
            stopService(Intent(this, RealtimeService::class.java))
        }
    }

    override fun onDestroy() {
        // Drop the webview reference so a destroyed activity can be GC'd; the FCM service may keep
        // running in the process but its eval() becomes a no-op until the next activity attaches.
        SomsBridge.webView = null
        super.onDestroy()
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
        }
    }

    /** Push the token to the web app's rotation hook. Safe to call whether or not the webview is
     *  attached — SomsBridge.eval no-ops when it isn't, and onWebViewCreate re-emits the current token. */
    private fun emitToken(token: String) {
        SomsBridge.eval("window.__SOMS_FCM_TOKEN__ && window.__SOMS_FCM_TOKEN__(${SomsBridge.jsonStr(token)});")
    }

    /** Navigate the web app to a thread. Calls window.__SOMS_DEEP_LINK__ if registered; the web app
     *  installs that handler at boot (PushService.init), so warm-start routing lands immediately. */
    private fun openThread(threadId: String) {
        SomsBridge.eval("window.__SOMS_DEEP_LINK__ && window.__SOMS_DEEP_LINK__(${SomsBridge.jsonStr(threadId)});")
    }

    /** Fetch the current FCM registration token asynchronously and stash it for the JS bridge. Delegates to
     *  [SomsFirebase] — under the dynamic-config model FirebaseApp is initialized from the server-fetched
     *  config (persisted in SomsSecureStore at process start by [SomsApplication]), not a bundled
     *  google-services.json. [SomsFirebase.ensureInitialized] is a no-op when already initialized this
     *  process; it returns null only when no config is persisted yet (first run / cleared), in which case
     *  FCM is unavailable and we skip silently — the app runs on foreground SSE + the WorkManager poller. */
    private fun fetchFcmToken() {
        if (SomsFirebase.ensureInitialized(this) == null) return
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

    /** Apply the foreground-service toggle: enabling just writes the pref (the FGS starts on the next
     *  background — it's a background-only path); disabling stops a running service immediately. If
     *  toggled on while already backgrounded, start it now. */
    private fun applyForegroundServiceEnabled(enabled: Boolean) {
        if (!enabled) {
            stopService(Intent(this, RealtimeService::class.java))
            return
        }
        if (!SomsMessagingService.appInForeground) {
            startForegroundService(Intent(this, RealtimeService::class.java))
        }
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

        /** Push the session token (POST /auth/login, app client) into encrypted storage so the Kotlin-owned
         *  /events stream (RealtimeService) and the background `/notifications/missed` fetchers
         *  (FCM / WorkManager) can authenticate while the WebView is suspended. Called from JS on login;
         *  pass null/empty on logout to clear. */
        @JavascriptInterface
        fun setSessionToken(token: String?) {
            val a = activityRef.get() ?: return
            SomsSecureStore.setSessionToken(a, token)
            // The realtime service lifecycle follows the session: a freshly-persisted token (login) opens
            // the /events stream the WebView consumes; clearing it (logout) tears the stream down.
            // ACTION_FOREGROUND because login happens while the app is visible. startService/stopService
            // are thread-safe (this @JavascriptInterface runs on a background JS thread).
            if (token.isNullOrEmpty()) {
                a.stopService(Intent(a, RealtimeService::class.java))
            } else {
                a.startService(
                    Intent(a, RealtimeService::class.java).setAction(RealtimeService.ACTION_FOREGROUND),
                )
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
        fun getConnState(): String = RealtimeService.connState

        /** User tapped the disconnected chip: tell RealtimeService to cancel its pending backoff and
         *  reconnect immediately (parity with the worker's retry-now and Rust's sse_net(online:true)).
         *  Delivered as an Intent action the same way ACTION_FOREGROUND/BACKGROUND are; a no-op if the
         *  stream is already open. */
        @JavascriptInterface
        fun retryNow() {
            val a = activityRef.get() ?: return
            a.startService(Intent(a, RealtimeService::class.java).setAction(RealtimeService.ACTION_RETRY))
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
            val hasToken = SomsBridge.FcmToken.current != null
            val lastCheck = activityRef.get()?.let { SomsSecureStore.getFcmLastCheck(it) } ?: 0L
            return JSONObject().put("hasToken", hasToken).put("lastCheck", lastCheck).toString()
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

        /** Hand the server's Firebase client config (the 4 fields the web fetched from
         *  `GET /push/firebase-config`) to native. Persists it in EncryptedSharedPreferences and
         *  (re)initializes FirebaseApp via [SomsFirebase.reconfigure]: a different project → deleteToken +
         *  deleteApp + re-init + a fresh token that flows back through `window.__SOMS_FCM_TOKEN__`. Pass
         *  null/empty to clear (server returned `{configured:false}`). Hops to the UI thread — Firebase's
         *  token Task listeners fire on main, and reconfigure must run there for a consistent app instance. */
        @JavascriptInterface
        fun setFirebaseConfig(config: String?) {
            val a = activityRef.get() ?: return
            a.runOnUiThread { SomsFirebase.reconfigure(a, config) }
        }

        /** Synchronous read of the currently-persisted Firebase client config JSON string (or null). The web
         *  uses it to avoid re-pushing an identical config (which would cause needless token churn). */
        @JavascriptInterface
        fun getFirebaseConfig(): String? {
            val a = activityRef.get() ?: return null
            return SomsSecureStore.getFirebaseConfig(a)
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

        /** Current soft-keyboard (IME) height in CSS px (0 when closed). Lets the web layer seed the value at
         *  bootstrap in case the keyboard is somehow already open (e.g. a page reload while the IME is up); the
         *  live source is the window.__SOMS_IME_HEIGHT__ push. */
        @JavascriptInterface
        fun getImeHeight(): Int = activityRef.get()?.imeHeightCss ?: 0
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
    }

    /** JS-callable surface exposed as window.SomsNotify — exposes the Android NATIVE notification method's
     *  parameters to JS. `show(text, replace)` posts/replaces the message notification on CHANNEL_MESSAGES
     *  (stable AWAY_NOTIF_ID when replace; a fresh id otherwise); `clear` cancels it. The web's
     *  AndroidNotificationAdapter wraps this, mapping the unified `merge` param onto `replace`. The native
     *  background triggers (FCM/WorkManager/RealtimeService → notifyAwaySummary) are untouched.
     *  @JavascriptInterface runs on a background JS thread; NotificationManager is thread-safe, so no hop. */
    private class SomsNotifyInterface(activity: MainActivity) {
        private val activityRef = java.lang.ref.WeakReference(activity)

        @JavascriptInterface
        fun show(text: String, replace: Boolean) {
            val a = activityRef.get() ?: return
            SomsMessagingService.showText(a, text, replace)
        }

        @JavascriptInterface
        fun clear() {
            val a = activityRef.get() ?: return
            ContextCompat.getSystemService(a, NotificationManager::class.java)
                ?.cancel(SomsMessagingService.AWAY_NOTIF_ID)
        }
    }

    companion object {
        private const val REQ_POST_NOTIF = 1001
        private const val NOTIF_SYNC_WORK = "soms-notif-sync"
        /** FCM availability auto-check cadence (the user's "once/day" requirement). */
        private const val FCM_CHECK_INTERVAL_MS = 24L * 60 * 60 * 1000
    }
}
