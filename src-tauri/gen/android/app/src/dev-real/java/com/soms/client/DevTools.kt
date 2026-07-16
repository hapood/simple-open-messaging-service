package com.soms.client

import android.graphics.PixelFormat
import android.view.Gravity
import android.view.View
import android.view.WindowManager

/**
 * Real dev-tools surface, compiled ONLY when `SOMS_DEV_TOOLS=1` (the Makefile's `apk-dev` target). The
 * no-op twin at `src/dev-stub` is compiled in every other build, so this object + [DevToolsBubble] +
 * [DevToolsDialog] + their drawables are physically absent from apk-debug and release (build-time source
 * exclusion, not a runtime gate). MainActivity calls [attach]/[detach] unconditionally; here they do the
 * work.
 *
 * [attach] is the relocated ex-`MainActivity.attachDevToolsBubble`: the bubble lives in its OWN WindowManager
 * sub-window (`TYPE_APPLICATION_PANEL`) — NOT in `android.R.id.content` — because Tauri swaps the webview's
 * content container on navigation, which used to discard a content-attached bubble a few seconds after
 * launch. A separate sub-window is independent of the content view (survives the swap) and draws above the
 * activity's content (the webview) regardless of z-order. No `SYSTEM_ALERT_WINDOW` permission — it's a
 * sub-window of our own activity, drawn over our own content, not over other apps. Idempotent (guarded by
 * `bubbleView?.isAttachedToWindow`). [detach] removes it (the sub-window is NOT auto-removed when the
 * content is destroyed, so `MainActivity.onDestroy` calls it explicitly). Single-activity app → one
 * `bubbleView` field suffices.
 *
 * Kept native (not web) on purpose: it stays reachable even when the webview is parked on a dead dev-server
 * error page, so the user can always fix the URL or bail to the bundle.
 */
object DevTools {
    private var bubbleView: View? = null

    /** Idempotently attach the draggable dev-tools bubble in its own WindowManager sub-window. Bails if
     *  the activity's window isn't attached yet (no decorView token) — `onWebViewCreate`/`onResume` retry. */
    fun attach(activity: MainActivity) {
        if (bubbleView?.isAttachedToWindow == true) return
        // TYPE_APPLICATION_PANEL needs the parent window's token; the decorView token is set once the
        // window is attached. If it isn't yet (very early), bail — onWebViewCreate/onResume retry.
        val token = activity.window.decorView.windowToken ?: return
        val density = activity.resources.displayMetrics.density
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
            activity,
            { activity.captureWebView(); DevToolsDialog(activity).show() },
            activity.getWindowManager(),
            params,
        )
        runCatching { activity.getWindowManager().addView(bubble, params) }
            .onFailure { android.util.Log.w("SomsDev", "DevTools.attach failed", it) }
        bubbleView = bubble
    }

    /** Remove the bubble's sub-window (it is NOT auto-removed on content destroy). Safe when absent. */
    fun detach(activity: MainActivity) {
        bubbleView?.let { v -> runCatching { activity.getWindowManager().removeView(v) } }
        bubbleView = null
    }
}
