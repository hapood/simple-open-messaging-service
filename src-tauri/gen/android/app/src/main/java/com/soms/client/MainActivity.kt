package com.soms.client

import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.PixelFormat
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.google.firebase.messaging.FirebaseMessaging
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
    /** The dev-tools bubble's window view (null when not attached). It lives in its own WindowManager
     *  window, not in android.R.id.content, so it survives the webview's content container being
     *  swapped mid-session (which used to drop the bubble a few seconds after launch). */
    private var bubbleView: View? = null

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
            val d = resources.displayMetrics.density
            safeInsetTopCss = Math.round(status.top / d)
            safeInsetBottomCss = Math.round(maxOf(nav.bottom, gestures.bottom) / d)
            applySafeInsetsToWebView()
            insets
        }
        ViewCompat.requestApplyInsets(content)
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

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
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
        // Deliver anything that arrived before the webview was ready.
        SomsBridge.FcmToken.current?.let { emitToken(it) }
        SomsBridge.DeepLink.pendingThreadId?.let {
            SomsBridge.DeepLink.pendingThreadId = null
            openThread(it)
        }
        // Debug-only draggable dev-tools bubble (frontend dev server / refresh / revert). Added here so
        // it is inserted AFTER the webview and draws on top. See DevToolsBubble / FCM_ANDROID_PATCH.md.
        if (BuildConfig.DEBUG) attachDevToolsBubble()
    }

    /** Attach the draggable dev-tools bubble (debug builds only) in its OWN window via WindowManager,
     *  NOT in android.R.id.content. A content-attached bubble was lost when Tauri swapped the webview's
     *  content container on navigation (it vanished a few seconds after launch, once the page rendered).
     *  A TYPE_APPLICATION_PANEL sub-window is independent of the content view (survives the swap) and
     *  draws above the activity's content (the webview) regardless of z-order. No SYSTEM_ALERT_WINDOW
     *  permission — it's a sub-window of this activity, not a system overlay. Idempotent; removed in
     *  onDestroy. */
    private fun attachDevToolsBubble() {
        if (bubbleView?.isAttachedToWindow == true) return
        // TYPE_APPLICATION_PANEL needs the parent window's token; the decorView token is set once the
        // window is attached. If it isn't yet (very early), bail — onResume/onWebViewCreate retry.
        val token = window.decorView.windowToken ?: return
        val density = resources.displayMetrics.density
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_PANEL,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            this.token = token
            gravity = Gravity.TOP or Gravity.START
            x = (16f * density).toInt()
            y = (80f * density).toInt() // below the status bar / notch
        }
        val bubble = DevToolsBubble(
            this,
            { captureWebView(); DevToolsDialog(this).show() },
            getWindowManager(),
            params,
        )
        runCatching { getWindowManager().addView(bubble, params) }
            .onFailure { android.util.Log.w("SomsDev", "attachDevToolsBubble failed", it) }
        bubbleView = bubble
    }

    /** Defensive fallback: locate the Tauri WebView in the window's view tree and hand it to SomsBridge.
     *  Idempotent. onWebViewCreate is the primary registration site — it always fires, because wry
     *  calls WryActivity.setWebView -> onWebViewCreate once the WebView is built — but that call is
     *  asynchronous w.r.t. the activity lifecycle and can land after the first onResume, so this
     *  view-tree scan is a belt-and-suspenders catch for that race window. Also called from the dev
     *  bubble's tap, by which point the WebView is guaranteed mounted. */
    private fun captureWebView() {
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
        // Attach the dev bubble here too: by onResume the content view is in the tree, so addView
        // lands the bubble ON TOP. (onWebViewCreate also attaches it; both are tag-guarded/idempotent.)
        if (BuildConfig.DEBUG) attachDevToolsBubble()
        // Belt-and-suspenders WebView capture for the async-creation race (see captureWebView). Usually
        // a no-op because onWebViewCreate has already set SomsBridge.webView.
        captureWebView()
        SomsMessagingService.appInForeground = true
        // User returned: stop the FGS (the live WebView SSE takes over) and clear the away-notification
        // so the in-app UI owns message display again.
        stopService(Intent(this, MessageSyncService::class.java))
        ContextCompat.getSystemService(this, NotificationManager::class.java)
            ?.cancel(SomsMessagingService.AWAY_NOTIF_ID)
    }

    override fun onStop() {
        super.onStop()
        SomsMessagingService.appInForeground = false
        // Start the FGS when backgrounded if its toggle is on AND the user is logged in (token present).
        if (SomsSecureStore.getForegroundServiceEnabled(this) &&
            SomsSecureStore.getNotificationToken(this) != null
        ) {
            startForegroundService(Intent(this, MessageSyncService::class.java))
        }
    }

    override fun onDestroy() {
        // The dev bubble lives in its own WindowManager sub-window (NOT in the content view), so it is
        // NOT auto-removed when the content is destroyed — drop it explicitly to avoid leaking a window.
        bubbleView?.let { v -> runCatching { getWindowManager().removeView(v) } }
        bubbleView = null
        // Drop the webview reference so a destroyed activity can be GC'd; the FCM service may keep
        // running in the process but its eval() becomes a no-op until the next activity attaches.
        SomsBridge.webView = null
        super.onDestroy()
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

    /** Fetch the current FCM registration token asynchronously and stash it for the JS bridge. */
    private fun fetchFcmToken() {
        // Push-optional guard: when the google-services plugin is OFF (no google-services.json — the
        // "TEMPORARILY OFF" build), the default FirebaseApp is never auto-initialized, so
        // FirebaseMessaging.getInstance() throws "Default FirebaseApp is not initialized" and crashes the
        // app on launch. Skip silently in that state — the app runs without push; FCM_ANDROID_PATCH.md
        // re-enables it. When the plugin is later applied, getApps() is non-empty and this is a no-op guard.
        if (com.google.firebase.FirebaseApp.getApps(this).isEmpty()) return
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (task.isSuccessful) {
                val token = task.result
                SomsBridge.FcmToken.current = token
                emitToken(token)
            }
        }
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
            stopService(Intent(this, MessageSyncService::class.java))
            return
        }
        if (!SomsMessagingService.appInForeground) {
            startForegroundService(Intent(this, MessageSyncService::class.java))
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

        /** Push the scoped notification token (POST /auth/notification-token) into encrypted storage so
         *  the WorkManager poller can authenticate /notifications/missed while the WebView is suspended.
         *  Called from JS on login; pass null/empty on logout to clear. */
        @JavascriptInterface
        fun setNotificationToken(token: String?) {
            val a = activityRef.get() ?: return
            SomsSecureStore.setNotificationToken(a, token)
        }

        /** Push the resolved backend origin into storage — the poller can't read window.__SOMS_API_ORIGIN__
         *  (no WebView alive when it fires). Called from JS at boot and whenever the user changes server. */
        @JavascriptInterface
        fun setApiOrigin(origin: String?) {
            val a = activityRef.get() ?: return
            SomsSecureStore.setApiOrigin(a, origin)
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

        /** Whether the dataSync foreground service (MessageSyncService) is enabled (default false). */
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
    }

    companion object {
        private const val REQ_POST_NOTIF = 1001
        private const val NOTIF_SYNC_WORK = "soms-notif-sync"
        /** FCM availability auto-check cadence (the user's "once/day" requirement). */
        private const val FCM_CHECK_INTERVAL_MS = 24L * 60 * 60 * 1000
    }
}
