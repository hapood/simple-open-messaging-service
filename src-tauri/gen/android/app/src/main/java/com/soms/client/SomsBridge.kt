package com.soms.client

import android.os.Handler
import android.os.Looper
import android.webkit.WebView

/**
 * Process-global bridge between the Firebase Messaging service and the Tauri webview, plus holders for
 * the two pieces of state that cross them. Everything here is process-scoped: all components
 * (MainActivity, SomsMessagingService) run in the same app process, so these singletons are shared
 * without IPC. They reset to their defaults on process death (app killed), which is fine — Firebase
 * re-issues the token and MainActivity re-fetches it on the next launch.
 */
object SomsBridge {
    /** Live webview reference, set by MainActivity.onWebViewCreate and cleared in onDestroy. Null when
     *  the app process is alive but no activity is attached (e.g. the service woke the process but the
     *  UI isn't up). eval() is a no-op then — emissions are re-delivered on the next onWebViewCreate. */
    @Volatile
    var webView: WebView? = null

    private val mainHandler = Handler(Looper.getMainLooper())

    /** Run a JS string on the webview, hop to the UI thread first (FCM callbacks run on a background
     *  thread; evaluateJavascript must be called from the UI thread). Safe to call from any thread;
     *  a no-op if no webview is attached. */
    fun eval(js: String) {
        mainHandler.post { webView?.evaluateJavascript(js, null) }
    }

    /** JSON-encode a string for safe embedding in evaluateJavascript arguments (escapes quotes and
     *  control chars). Used to pass the FCM token and threadId into the web app's global hooks. */
    fun jsonStr(s: String): String =
        buildString {
            append('"')
            for (c in s) when (c) {
                '\\' -> append("\\\\")
                '"' -> append("\\\"")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (c.code < 0x20) append("\\u%04x".format(c.code)) else append(c)
            }
            append('"')
        }

    /** The most recently issued FCM registration token, or null until the first token task resolves.
     *  Written by MainActivity's token fetch and by SomsMessagingService.onNewToken; read by the
     *  SomsFcm @JavascriptInterface when the web app asks for it. */
    object FcmToken {
        @Volatile
        var current: String? = null

        @Volatile
        var lastError: String? = null
    }

    /** A thread id captured from a notification tap before the webview exists (cold start), consumed by
     *  MainActivity.onWebViewCreate once the webview is ready. Warm-start taps go straight to
     *  UiBridge.eval(window.__SOMS_DEEP_LINK__) and never touch this. */
    object DeepLink {
        @Volatile
        var pendingThreadId: String? = null
    }

    data class SharedText(val id: String, val text: String)

    /** Latest Android ACTION_SEND text. It remains native-owned until the web flow explicitly acknowledges
     *  its id, so Angular boot and WebView recreation cannot lose the external share. */
    object Share {
        @Volatile
        var pending: SharedText? = null
    }
}
