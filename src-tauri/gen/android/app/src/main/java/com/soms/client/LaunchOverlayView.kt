package com.soms.client

import android.content.Context
import android.content.res.Configuration
import android.graphics.Rect
import android.graphics.Typeface
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.animation.DecelerateInterpolator
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.graphics.Insets
import androidx.core.view.WindowInsetsCompat
import kotlin.math.roundToInt

/** Presentation only: the host decides readiness; this view owns splash geometry and animation. */
internal class LaunchOverlayView(context: Context, dark: Boolean) : ViewGroup(context) {
    internal val logo = ImageView(context).apply {
        scaleType = ImageView.ScaleType.FIT_CENTER
        contentDescription = null
    }
    internal val title = TextView(context).apply {
        setText(R.string.app_name)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 28f)
        setTypeface(typeface, Typeface.BOLD)
        letterSpacing = 0.06f
        gravity = Gravity.CENTER
        textAlignment = TEXT_ALIGNMENT_CENTER
    }
    internal val tagline = TextView(context).apply {
        setText(R.string.splash_tagline)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        gravity = Gravity.CENTER
        textAlignment = TEXT_ALIGNMENT_CENTER
        // Keep font padding: fallback CJK glyphs and enlarged fonts need their full ink bounds.
        includeFontPadding = true
    }
    internal val brand = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        alpha = 0f
        addView(title, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        addView(tagline, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT)
            .apply { topMargin = dp(10) })
    }
    internal val status = TextView(context).apply {
        setText(R.string.splash_preparing)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        letterSpacing = 0.04f
        maxLines = 1
    }
    private var handoffBounds: Rect? = null
    private var revealStarted = false
    /** Bottom system-UI inset (navigation bar / gesture area) so the status line never sinks
     *  under the edge-to-edge system bars. Zero until insets are dispatched. */
    private var bottomInset = 0

    init {
        isClickable = true
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        elevation = dp(16).toFloat()
        addView(logo)
        addView(brand)
        addView(status)
        applyPalette(dark)
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).roundToInt()

    fun applyPalette(dark: Boolean) {
        val palette = context.createConfigurationContext(Configuration(resources.configuration).apply {
            uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
                if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
        })
        fun color(id: Int) = ContextCompat.getColor(palette, id)
        setBackgroundColor(color(R.color.splash_background))
        logo.setImageDrawable(ContextCompat.getDrawable(palette, R.drawable.splash_logo))
        title.setTextColor(color(R.color.splash_text))
        tagline.setTextColor(color(R.color.splash_text_secondary))
        status.setTextColor(color(R.color.splash_text_status))
    }

    /** Bounds are in this overlay's coordinates, not the content area's inset coordinates. */
    fun alignSystemIcon(bounds: Rect) {
        if (bounds.width() <= 0 || bounds.height() <= 0) return
        handoffBounds = Rect(bounds)
        requestLayout()
    }

    fun prepareSystemHandoff() {
        logo.animate().cancel()
        brand.animate().cancel()
        logo.translationY = 0f
        brand.alpha = 0f
        revealStarted = false
    }

    fun revealBrand() {
        if (revealStarted) return
        revealStarted = true
        logo.animate().translationY(-dp(24).toFloat()).setDuration(320L)
            .setInterpolator(DecelerateInterpolator()).start()
        brand.animate().alpha(1f).setStartDelay(100L).setDuration(220L).start()
    }

    fun cancelAnimations() {
        animate().cancel()
        logo.animate().cancel()
        brand.animate().cancel()
    }

    override fun onDetachedFromWindow() {
        cancelAnimations()
        super.onDetachedFromWindow()
    }

    override fun onApplyWindowInsets(insets: WindowInsets): WindowInsets {
        val bars: Insets = WindowInsetsCompat.toWindowInsetsCompat(insets, this)
            .getInsets(WindowInsetsCompat.Type.navigationBars() or WindowInsetsCompat.Type.tappableElement())
        bottomInset = bars.bottom
        return super.onApplyWindowInsets(insets)
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        // The decor always measures this overlay EXACTLY; resolveSize keeps any other mode sound
        // instead of silently trusting getSize on an UNSPECIFIED measure.
        val width = resolveSize(dp(320), widthMeasureSpec)
        val height = resolveSize(dp(320), heightMeasureSpec)
        setMeasuredDimension(width, height)
        logo.measure(
            MeasureSpec.makeMeasureSpec(handoffBounds?.width() ?: dp(288), MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(handoffBounds?.height() ?: dp(288), MeasureSpec.EXACTLY),
        )
        val textWidth = MeasureSpec.makeMeasureSpec((width - dp(48)).coerceAtLeast(0), MeasureSpec.AT_MOST)
        // Text is not a child of the fixed-size icon canvas. Measure every line at its natural height,
        // including localized wrapping and font padding, rather than clipping it to the canvas remainder.
        val textHeight = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
        brand.measure(textWidth, textHeight)
        status.measure(textWidth, textHeight)
    }

    private fun centerTaglineInk() {
        tagline.translationX = 0f
        val textLayout = tagline.layout ?: return
        if (textLayout.lineCount != 1) return
        // A trailing CJK full stop reserves a full character cell but paints only its left edge.
        // Center the visible single-line lettering rather than that asymmetric empty cell space.
        // Wrapped paragraphs retain normal per-line typographic centering.
        val text = tagline.text.toString()
        val ink = Rect()
        tagline.paint.getTextBounds(text, 0, text.length, ink)
        if (ink.isEmpty) return
        val inkCenter = tagline.compoundPaddingLeft + textLayout.getLineLeft(0) + ink.exactCenterX()
        tagline.translationX = tagline.width / 2f - inkCenter
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val x = handoffBounds?.left ?: ((width - logo.measuredWidth) / 2)
        val y = handoffBounds?.top ?: ((height - logo.measuredHeight) / 2)
        logo.layout(x, y, x + logo.measuredWidth, y + logo.measuredHeight)
        val brandLeft = x + (logo.measuredWidth - brand.measuredWidth) / 2
        val brandTop = y + (logo.measuredHeight * 234f / 288f).roundToInt() - dp(24)
        brand.layout(brandLeft, brandTop, brandLeft + brand.measuredWidth, brandTop + brand.measuredHeight)
        centerTaglineInk()
        val statusLeft = if (layoutDirection == LAYOUT_DIRECTION_RTL) width - dp(24) - status.measuredWidth else dp(24)
        val statusBottom = height - dp(28) - bottomInset
        status.layout(statusLeft, statusBottom - status.measuredHeight, statusLeft + status.measuredWidth, statusBottom)
    }
}
