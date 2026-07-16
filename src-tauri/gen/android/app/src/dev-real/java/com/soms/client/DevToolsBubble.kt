package com.soms.client

import android.annotation.SuppressLint
import android.content.Context
import android.util.TypedValue
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.ImageView

/**
 * A small draggable floating button that opens the native dev-tools dialog ([DevToolsDialog]). It lives
 * in its OWN window (added via [WindowManager.addView] with `TYPE_APPLICATION_PANEL` in
 * [MainActivity.attachDevToolsBubble]) — NOT in `android.R.id.content` — for two reasons:
 *
 *  1. Tauri swaps the webview's content container when the webview navigates. A bubble attached to the
 *     old `android.R.id.content` was discarded with it, so it vanished a few seconds after launch (once
 *     the page rendered). A separate window is independent of the content view and survives the swap.
 *  2. An application sub-window draws above the activity's content (the webview) regardless of view
 *     z-order, so the bubble stays on top even while the page is rendering.
 *
 * Dev-server-build-only (the caller gates on `BuildConfig.ENABLE_DEV_TOOLS`, true solely in the
 * Makefile's `apk-dev` target), so plain debug and all release APKs never show it. No
 * `SYSTEM_ALERT_WINDOW` permission: `TYPE_APPLICATION_PANEL` is a sub-window of our own activity,
 * drawn over our own content — not over other apps.
 *
 * Touch model: a drag repositions the window (`params.x/y` + `updateViewLayout`); a tap (movement
 * below the touch-slop threshold) fires [onClick]. Standard "drag-or-tap" floating-button UX.
 *
 * Kept native (not web) on purpose: it stays reachable even when the webview is parked on a dead
 * dev-server error page, so the user can always fix the URL or bail to the bundle. The web app has
 * zero awareness of it.
 */
class DevToolsBubble(
    context: Context,
    private val onClick: () -> Unit,
    private val windowManager: WindowManager,
    private val params: WindowManager.LayoutParams,
) : ImageView(context) {

    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
    private var downRawX = 0f
    private var downRawY = 0f
    private var startX = 0
    private var startY = 0
    private var dragged = false
    private val displayW = resources.displayMetrics.widthPixels
    private val displayH = resources.displayMetrics.heightPixels

    init {
        setBackgroundResource(R.drawable.dev_bubble_bg)
        setImageResource(R.drawable.ic_dev_tools)
        val pad = dp(12)
        setPadding(pad, pad, pad, pad)
        layoutParams = ViewGroup.LayoutParams(dp(48), dp(48))
        elevation = dp(6).toFloat()
        setContentDescription("SOMS dev tools")
        setupTouch()
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun setupTouch() {
        setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawX = e.rawX
                    downRawY = e.rawY
                    startX = params.x
                    startY = params.y
                    dragged = false
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downRawX
                    val dy = e.rawY - downRawY
                    if (!dragged && (Math.abs(dx) > touchSlop || Math.abs(dy) > touchSlop)) {
                        dragged = true
                    }
                    if (dragged) {
                        // Clamp to the screen so the bubble can't be dragged off-display.
                        val maxX = (displayW - v.width).coerceAtLeast(0)
                        val maxY = (displayH - v.height).coerceAtLeast(0)
                        params.x = (startX + dx).toInt().coerceIn(0, maxX)
                        params.y = (startY + dy).toInt().coerceIn(0, maxY)
                        windowManager.updateViewLayout(v, params)
                    }
                }
                MotionEvent.ACTION_UP -> {
                    if (!dragged) {
                        onClick()
                        v.performClick()
                    }
                }
            }
            true
        }
    }

    private fun dp(value: Int): Int =
        TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value.toFloat(),
            resources.displayMetrics,
        ).toInt()
}
