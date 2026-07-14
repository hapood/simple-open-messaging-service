package com.soms.client

import android.annotation.SuppressLint
import android.content.Context
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView

/**
 * A small draggable floating button that opens the native dev-tools dialog ([DevToolsDialog]). Added
 * to the activity's `android.R.id.content` FrameLayout in [MainActivity.onWebViewCreate] (AFTER the
 * webview, so it draws on top) and only in debug builds (the caller gates on `BuildConfig.DEBUG`),
 * so release APKs never show it. No `SYSTEM_ALERT_WINDOW` permission is needed: it lives inside our
 * own window, drawn over our own webview — not over other apps.
 *
 * Touch model: a drag repositions the bubble (clamped to its parent); a tap (movement below the
 * touch-slop threshold) fires [onClick]. Standard "drag-or-tap" floating-button UX.
 *
 * Kept native (not web) on purpose: it stays reachable even when the webview is parked on a dead
 * dev-server error page, so the user can always fix the URL or bail to the bundle. The web app has
 * zero awareness of it. See `src-tauri/FCM_ANDROID_PATCH.md`.
 */
class DevToolsBubble(
    context: Context,
    private val onClick: () -> Unit,
) : ImageView(context) {

    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
    private var downRawX = 0f
    private var downRawY = 0f
    private var startX = 0f
    private var startY = 0f
    private var dragged = false

    init {
        setBackgroundResource(R.drawable.dev_bubble_bg)
        setImageResource(R.drawable.ic_dev_tools)
        val pad = dp(12)
        setPadding(pad, pad, pad, pad)
        val size = dp(48)
        layoutParams = FrameLayout.LayoutParams(size, size).apply {
            gravity = Gravity.TOP or Gravity.START
        }
        // Draw above the webview regardless of insertion order (the webview is elevation 0).
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
                    startX = v.x
                    startY = v.y
                    dragged = false
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downRawX
                    val dy = e.rawY - downRawY
                    if (!dragged && (Math.abs(dx) > touchSlop || Math.abs(dy) > touchSlop)) {
                        dragged = true
                    }
                    if (dragged) {
                        val parent = v.parent as? ViewGroup ?: return@setOnTouchListener true
                        val maxX = (parent.width - v.width).coerceAtLeast(0).toFloat()
                        val maxY = (parent.height - v.height).coerceAtLeast(0).toFloat()
                        v.x = (startX + dx).coerceIn(0f, maxX)
                        v.y = (startY + dy).coerceIn(0f, maxY)
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
