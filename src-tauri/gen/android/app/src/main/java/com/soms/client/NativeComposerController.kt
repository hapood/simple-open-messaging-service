package com.soms.client

import android.graphics.Color
import android.graphics.Rect
import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.content.Context
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Outline
import android.os.Build
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.view.TouchDelegate
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.animation.PathInterpolator
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import android.widget.BaseAdapter
import android.widget.Chronometer
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridView
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.TextView
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicLong

/**
 * Activity-owned Material floating composer. It is a sibling overlay above the WebView; Angular renders
 * no Android input surface. The native EditText remains the single draft/selection authority.
 */
class NativeComposerController(
    private val activity: MainActivity,
) {
    private val density = activity.resources.displayMetrics.density
    private fun dp(value: Int) = Math.round(value * density)
    private val enterInterpolator = PathInterpolator(0.2f, 0f, 0f, 1f)
    private val isExpandedWindow =
        activity.resources.configuration.smallestScreenWidthDp >= TABLET_MIN_WIDTH_DP
    private val isDark =
        activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
            Configuration.UI_MODE_NIGHT_YES
    private var darkTheme = isDark
    private var surface = Color.WHITE
    private var outline = Color.rgb(221, 225, 227)
    private var onSurface = Color.rgb(38, 44, 47)
    private var secondary = Color.rgb(84, 94, 99)
    private var hintColor = Color.rgb(121, 130, 135)

    private val root = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        visibility = View.GONE
        clipChildren = false
        setPadding(dp(8), 0, dp(8), dp(8))
    }
    private val row = LinearLayout(activity).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.BOTTOM
        clipChildren = false
    }
    private val attachSlot = FrameLayout(activity).apply {
        contentDescription = activity.getString(R.string.composer_attach)
        isClickable = true
        isFocusable = false
        isFocusableInTouchMode = false
        clipChildren = false
        clipToPadding = false
    }
    private val attach = iconButton(
        R.drawable.ic_composer_attach,
        activity.getString(R.string.composer_attach),
    ).apply {
        background = surfaceRipple(18)
        clipToOutline = true
        applySoftShadow(18, 2.5f)
        isClickable = false
        isFocusable = false
        setPadding(dp(8), dp(8), dp(8), dp(8))
    }
    private val input = EditText(activity).apply {
        hint = "Message"
        textSize = 16f
        maxLines = if (isExpandedWindow) TABLET_MAX_LINES else PHONE_MAX_LINES
        minLines = 1
        minHeight = dp(48)
        gravity = Gravity.CENTER_VERTICAL
        includeFontPadding = false
        setTextColor(onSurface)
        setHintTextColor(hintColor)
        setPadding(dp(14), dp(11), dp(48), dp(11))
        background = outlinedSurface(12)
        clipToOutline = true
        applySoftShadow(12, 2.5f)
        inputType = InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or
            InputType.TYPE_TEXT_FLAG_MULTI_LINE
        imeOptions = EditorInfo.IME_FLAG_NO_ENTER_ACTION
        isVerticalScrollBarEnabled = false
        overScrollMode = View.OVER_SCROLL_NEVER
        setHorizontallyScrolling(false)
        setSingleLine(false)
    }
    private val keyboard = iconButton(
        R.drawable.ic_composer_emoji,
        activity.getString(R.string.composer_emoji),
    ).apply {
        background = transparentRipple(22)
        elevation = dp(5).toFloat()
        translationZ = dp(2).toFloat()
        setPadding(dp(11), dp(11), dp(11), dp(11))
    }
    private val action = iconButton(
        R.drawable.ic_composer_mic,
        activity.getString(R.string.composer_record),
    ).apply {
        isFocusable = false
        isFocusableInTouchMode = false
        background = rounded(PRIMARY, 24)
        foreground = transparentRipple(24)
        clipToOutline = true
        applySoftShadow(24, 3.5f)
        setColorFilter(Color.WHITE)
    }
    private val recordingStatus = Chronometer(activity).apply {
        visibility = View.GONE
        gravity = Gravity.CENTER_VERTICAL
        textSize = 14f
        setTextColor(if (isDark) Color.rgb(255, 166, 166) else Color.rgb(177, 38, 38))
        setPadding(dp(10), 0, dp(10), 0)
        background = rounded(surface, 10)
        elevation = dp(6).toFloat()
        format = activity.getString(R.string.composer_recording_format)
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
    }
    private val emojiGrid = GridView(activity).apply {
        numColumns = GridView.AUTO_FIT
        columnWidth = dp(44)
        stretchMode = GridView.STRETCH_COLUMN_WIDTH
        verticalSpacing = dp(4)
        horizontalSpacing = dp(2)
        gravity = Gravity.CENTER
        visibility = View.GONE
        setPadding(dp(4), dp(10), dp(4), dp(8))
        background = rounded(surface, 14)
        adapter = object : BaseAdapter() {
            override fun getCount() = EMOJI.size + 1
            override fun getItem(position: Int) =
                if (position == EMOJI.size) "⌫" else EMOJI[position]
            override fun getItemId(position: Int) = position.toLong()
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
                return (convertView as? TextView ?: TextView(activity).apply {
                    gravity = Gravity.CENTER
                    textSize = 25f
                    minHeight = dp(44)
                    background = transparentRipple(12)
                }).apply {
                    text = getItem(position)
                    contentDescription =
                        if (position == EMOJI.size) {
                            activity.getString(R.string.composer_backspace)
                        } else {
                            text
                        }
                }
            }
        }
        onItemClickListener = android.widget.AdapterView.OnItemClickListener { _, _, position, _ ->
            if (position == EMOJI.size) {
                deleteBeforeCursor()
            } else {
                val at = input.selectionStart.coerceAtLeast(0)
                input.text.insert(at, EMOJI[position])
            }
            input.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
        }
    }

    private var attached = false
    private var contextId = 0L
    private var threadId = 0L
    private var sequence = 0L
    private var visible = false
    private var keyboardSurface = KeyboardSurface.CLOSED
    private var imeBottomPx = 0
    /** Authoritative endpoint from onApplyWindowInsets. Animation progress updates imeBottomPx instead,
     *  so Web layout can consume this final value before the native overlay starts moving. */
    private var committedImeBottomPx = 0
    private var safeBottomPx = 0
    private var replacementHeightPx = 0
    private var lastSystemKeyboardHeightPx = 0
    private var boundsLeftPx = 0
    private var boundsWidthPx = 0
    private var boundsBottomPx = 0
    private var hasBounds = false
    private var externalPickerSurface: KeyboardSurface? = null
    private var lastEmittedComposerHeightCss: Int? = null
    private var lastEmittedKeyboardHeightCss: Int? = null
    private var imeAnimationRunning = false
    private var deferredInsetsCommit: Runnable? = null
    private val actionIds = AtomicLong(System.currentTimeMillis() * 1000)
    private var pendingSend: Long? = null
    private var voiceDownY = 0f
    private var voiceCancelArmed = false

    init {
        applyTheme(darkTheme)
        attachSlot.addView(
            attach,
            FrameLayout.LayoutParams(dp(36), dp(36)).apply {
                gravity = Gravity.START or Gravity.BOTTOM
            },
        )
        row.addView(attachSlot, LinearLayout.LayoutParams(dp(40), dp(48)))
        val inputWrap = FrameLayout(activity).apply {
            clipChildren = false
            clipToPadding = false
        }
        inputWrap.minimumHeight = dp(48)
        inputWrap.addView(
            input,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { gravity = Gravity.BOTTOM },
        )
        inputWrap.addView(
            keyboard,
            FrameLayout.LayoutParams(dp(44), dp(44)).apply {
                gravity = Gravity.END or Gravity.BOTTOM
            },
        )
        inputWrap.addView(
            recordingStatus,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                dp(40),
            ).apply {
                gravity = Gravity.START or Gravity.BOTTOM
                leftMargin = dp(6)
                bottomMargin = dp(4)
            },
        )
        input.setPadding(dp(14), dp(11), dp(48), dp(11))
        row.addView(
            inputWrap,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                gravity = Gravity.BOTTOM
            },
        )
        row.addView(
            action,
            LinearLayout.LayoutParams(dp(48), dp(48)).apply {
                leftMargin = dp(8)
            },
        )
        root.addView(
            row,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { gravity = Gravity.CENTER_HORIZONTAL },
        )
        root.addView(
            emojiGrid,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(280),
            ).apply { topMargin = dp(8) },
        )

        input.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                refreshAction()
                emit(JSONObject().apply {
                    put("kind", "draft")
                    put("text", s?.toString().orEmpty())
                    put("selectionStart", input.selectionStart)
                    put("selectionEnd", input.selectionEnd)
                })
                root.post(::emitGeometry)
            }
            override fun afterTextChanged(s: Editable?) = Unit
        })
        input.setOnClickListener {
            if (keyboardSurface == KeyboardSurface.EMOJI) switchToSystemKeyboard()
        }
        keyboard.setOnClickListener {
            if (
                keyboardSurface == KeyboardSurface.EMOJI ||
                keyboardSurface == KeyboardSurface.TO_SYSTEM
            ) {
                switchToSystemKeyboard()
            } else {
                showEmojiKeyboard()
            }
        }
        attachSlot.setOnClickListener { showAttachmentMenu() }
        action.setOnClickListener {
            if (input.text.toString().trim().isNotEmpty()) emitSend()
        }
        action.setOnLongClickListener {
            action.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
            activity.beginNativeVoiceRecording(
                contextId,
                threadId,
                actionIds.incrementAndGet(),
            )
            true
        }
        action.setOnTouchListener { _, event ->
            if (event.actionMasked == android.view.MotionEvent.ACTION_DOWN) {
                voiceDownY = event.rawY
                voiceCancelArmed = false
                false
            } else if (
                event.actionMasked == android.view.MotionEvent.ACTION_MOVE &&
                activity.nativeVoiceRecording()
            ) {
                val next = voiceDownY - event.rawY >= dp(48)
                if (next && !voiceCancelArmed) {
                    action.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
                }
                voiceCancelArmed = next
                updateVoiceCancelState(next)
                action.alpha = if (next) 0.45f else 1f
                true
            } else if (event.actionMasked == android.view.MotionEvent.ACTION_UP && activity.nativeVoiceRecording()) {
                action.alpha = 1f
                activity.finishNativeVoiceRecording(cancel = voiceCancelArmed)
                true
            } else if (event.actionMasked == android.view.MotionEvent.ACTION_UP) {
                activity.cancelPendingNativeVoiceStart()
                false
            } else if (event.actionMasked == android.view.MotionEvent.ACTION_CANCEL && activity.nativeVoiceRecording()) {
                action.alpha = 1f
                activity.finishNativeVoiceRecording(cancel = true)
                true
            } else if (event.actionMasked == android.view.MotionEvent.ACTION_CANCEL) {
                activity.cancelPendingNativeVoiceStart()
                false
            } else false
        }
        row.post {
            val hitRect = Rect()
            attachSlot.getHitRect(hitRect)
            hitRect.inset(-dp(4), 0)
            row.touchDelegate = TouchDelegate(hitRect, attachSlot)
        }
        root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
            constrainComposerWidth()
            emitGeometry()
        }
    }

    fun show(json: String) {
        val context = runCatching { JSONObject(json) }.getOrNull() ?: return
        if (context.optInt("version") != 1) return
        contextId = context.optLong("contextId")
        threadId = context.optString("threadId").toLongOrNull() ?: 0L
        sequence = 0
        // A new JS context must receive its own first geometry even if it happens to match the previous
        // chat's cached height.
        lastEmittedComposerHeightCss = null
        lastEmittedKeyboardHeightCss = null
        pendingSend = null
        hasBounds = false
        setSending(false)
        applyTheme(
            when (context.optString("theme", "system")) {
                "dark" -> true
                "light" -> false
                else -> isDark
            },
        )
        input.hint = context.optString("placeholder", "Message")
        input.setText(context.optString("initialDraft", ""))
        input.setSelection(input.text.length)
        ensureAttached()
        visible = true
        root.animate().cancel()
        root.alpha = 0.82f
        root.translationY = dp(12).toFloat()
        // Keep the view in layout so its geometry can be measured, but do not draw it before Angular
        // publishes the chat-pane bounds. Drawing here briefly exposes the decor-wide/default-bottom
        // position before setBounds() moves it, which looks like a jump to the endpoint followed by the
        // actual enter animation.
        root.visibility = View.INVISIBLE
        updateBottom()
        root.post(::emitGeometry)
    }

    fun setBounds(json: String) {
        val bounds = runCatching { JSONObject(json) }.getOrNull() ?: return
        if (
            bounds.optInt("version") != 1 ||
            bounds.optLong("contextId") != contextId ||
            !visible
        ) return
        boundsLeftPx = Math.round(bounds.optDouble("left") * density).toInt().coerceAtLeast(0)
        boundsWidthPx = Math.round(bounds.optDouble("width") * density).toInt().coerceAtLeast(dp(1))
        boundsBottomPx = Math.round(
            (bounds.optDouble("top") + bounds.optDouble("height")) * density,
        ).toInt()
        hasBounds = true
        applyBounds()
        root.post {
            if (!visible || bounds.optLong("contextId") != contextId) return@post
            root.animate().cancel()
            root.visibility = View.VISIBLE
            root.animate()
                .alpha(1f)
                .translationY(0f)
                .setDuration(SHOW_DURATION_MS)
                .setInterpolator(enterInterpolator)
                .start()
        }
    }

    fun update(json: String) {
        val patch = runCatching { JSONObject(json) }.getOrNull() ?: return
        if (patch.optLong("contextId") != contextId) return
        if (patch.has("placeholder")) input.hint = patch.optString("placeholder")
        if (patch.has("sending")) setSending(patch.optBoolean("sending"))
        if (patch.has("theme")) {
            applyTheme(
                when (patch.optString("theme", "system")) {
                    "dark" -> true
                    "light" -> false
                    else -> isDark
                },
            )
        }
    }

    fun acknowledge(actionId: Long, accepted: Boolean) {
        if (pendingSend == actionId) {
            if (accepted) input.text.clear()
            pendingSend = null
            setSending(false)
        }
    }

    fun onVoiceRecordingStarted() {
        recordingStatus.base = android.os.SystemClock.elapsedRealtime()
        updateVoiceCancelState(false)
        recordingStatus.visibility = View.VISIBLE
        recordingStatus.start()
        keyboard.visibility = View.INVISIBLE
        action.background = rounded(RECORDING, 24)
        action.setImageResource(R.drawable.ic_composer_mic)
        action.contentDescription = activity.getString(R.string.composer_recording)
    }

    fun onVoiceRecordingFinished() {
        recordingStatus.stop()
        recordingStatus.visibility = View.GONE
        keyboard.visibility = View.VISIBLE
        action.background = rounded(PRIMARY, 24)
        action.alpha = 1f
        refreshAction()
    }

    /** Keep the native recording chip in parity with Web: neutral "slide up" guidance while recording,
     *  then an explicit red "release to cancel" confirmation once the gesture crosses the threshold. */
    private fun updateVoiceCancelState(cancel: Boolean) {
        recordingStatus.format = activity.getString(
            if (cancel) {
                R.string.composer_recording_cancel_format
            } else {
                R.string.composer_recording_format
            },
        )
        recordingStatus.setTextColor(
            if (cancel) RECORDING else if (darkTheme) Color.rgb(255, 166, 166) else Color.rgb(177, 38, 38),
        )
        recordingStatus.contentDescription = activity.getString(
            if (cancel) R.string.composer_recording_cancel else R.string.composer_recording,
        )
    }

    fun restoreAfterExternalPicker() {
        val previous = externalPickerSurface ?: return
        externalPickerSurface = null
        when (previous) {
            KeyboardSurface.SYSTEM -> {
                keyboardSurface = KeyboardSurface.SYSTEM
                input.requestFocus()
                requestNativeIme(true)
            }
            KeyboardSurface.EMOJI, KeyboardSurface.TO_SYSTEM -> {
                keyboardSurface = KeyboardSurface.EMOJI
                emojiGrid.visibility = View.VISIBLE
                keyboard.setImageResource(R.drawable.ic_composer_keyboard)
                updateBottom()
                root.post(::emitGeometry)
            }
            KeyboardSurface.CLOSED -> Unit
        }
    }

    fun hide(requestContextId: Long) {
        if (requestContextId != contextId) return
        dismissKeyboard()
        visible = false
        val hidingContext = contextId
        root.animate().cancel()
        root.animate()
            .alpha(0f)
            .translationY(dp(14).toFloat())
            .setDuration(HIDE_DURATION_MS)
            .setListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    root.animate().setListener(null)
                    if (visible || contextId != hidingContext) return
                    root.visibility = View.GONE
                    input.text.clear()
                    hasBounds = false
                }
            })
            .start()
        emitGeometry()
    }

    fun updateInsets(imeBottomDevicePx: Int, safeBottomDevicePx: Int) {
        deferredInsetsCommit?.let(root::removeCallbacks)
        deferredInsetsCommit = null
        committedImeBottomPx = imeBottomDevicePx.coerceAtLeast(0)
        // On Android R+ onApplyWindowInsets is dispatched with the destination inset after onPrepare but
        // before onProgress restarts at the source. Retain that state, but let onProgress own the visual
        // position; applying it here produces destination -> source -> animated destination.
        updateInsetsState(
            imeBottomDevicePx,
            safeBottomDevicePx,
            updateVisualPosition = !imeAnimationRunning,
        )
        root.post(::emitGeometry)
    }

    /** Animation progress is native-visual state only. Composer geometry is a final-value protocol and
     *  must never expose these intermediate IME frames to JS. */
    fun updateImeAnimationProgress(imeBottomDevicePx: Int, safeBottomDevicePx: Int) {
        updateInsetsState(
            imeBottomDevicePx,
            safeBottomDevicePx,
            updateVisualPosition = true,
        )
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            // Pre-R has no trustworthy predicted endpoint. Some OEMs report the new visible-frame height
            // from onApplyWindowInsets before the global-layout observer sees it, so scheduling only when
            // globalLayout detects a delta can miss the commit entirely. Debounce every observed visual
            // frame here; the last one becomes the single committed geometry value.
            deferredInsetsCommit?.let(root::removeCallbacks)
            deferredInsetsCommit = Runnable {
                deferredInsetsCommit = null
                updateInsets(imeBottomDevicePx, safeBottomDevicePx)
            }.also { root.postDelayed(it, PRE_R_INSETS_COMMIT_DELAY_MS) }
        }
    }

    private fun updateInsetsState(
        imeBottomDevicePx: Int,
        safeBottomDevicePx: Int,
        updateVisualPosition: Boolean,
    ) {
        imeBottomPx = imeBottomDevicePx.coerceAtLeast(0)
        safeBottomPx = safeBottomDevicePx.coerceAtLeast(0)
        val systemKeyboardHeightPx = (imeBottomPx - safeBottomPx).coerceAtLeast(0)
        if (
            (keyboardSurface == KeyboardSurface.SYSTEM ||
                keyboardSurface == KeyboardSurface.TO_SYSTEM) &&
            systemKeyboardHeightPx > dp(80)
        ) {
            lastSystemKeyboardHeightPx = systemKeyboardHeightPx
        }
        when {
            // API 29 and below have no reliable IME animation-end callback. Their global-layout
            // observer arrives here once the system keyboard really occupies the window, so finish
            // the emoji → IME handoff immediately instead of relying on the one-shot timeout. API 30+
            // must stay TO_SYSTEM until onImeAnimationEnd: onApplyWindowInsets exposes the destination
            // before onProgress restarts at zero, so completing here would collapse the composer for one
            // frame when that first progress inset arrives.
            keyboardSurface == KeyboardSurface.TO_SYSTEM &&
                Build.VERSION.SDK_INT < Build.VERSION_CODES.R &&
                imeBottomPx > safeBottomPx + dp(80) -> completeSystemHandoff()
            keyboardSurface != KeyboardSurface.EMOJI &&
                keyboardSurface != KeyboardSurface.TO_SYSTEM &&
                input.hasFocus() &&
                imeBottomPx > safeBottomPx + dp(24) -> keyboardSurface = KeyboardSurface.SYSTEM
        }
        if (updateVisualPosition) updateBottom()
    }

    fun onImeAnimationEnd() {
        imeAnimationRunning = false
        if (
            keyboardSurface == KeyboardSurface.TO_SYSTEM &&
            imeBottomPx > safeBottomPx + dp(80)
        ) {
            completeSystemHandoff()
        }
        updateBottom()
        // Usually deduplicates against the committed endpoint published before animation. It also covers
        // cancelled animations and OEMs that omit the last progress frame.
        root.post(::emitGeometry)
    }

    fun onImeAnimationPrepare() {
        imeAnimationRunning = true
    }

    fun handleBack(): Boolean {
        if (!visible || !keyboardIsOpen()) return false
        dismissKeyboard()
        return true
    }

    fun handleOutsideTouch(event: MotionEvent) {
        if (!visible || event.actionMasked != MotionEvent.ACTION_DOWN || !keyboardIsOpen()) return
        val bounds = Rect()
        root.getGlobalVisibleRect(bounds)
        if (!bounds.contains(event.rawX.toInt(), event.rawY.toInt())) dismissKeyboard()
    }

    private fun ensureAttached() {
        if (attached) return
        val decor = activity.window.decorView as ViewGroup
        decor.addView(
            root,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM,
            ),
        )
        attached = true
    }

    private fun showEmojiKeyboard() {
        if (!visible || keyboardSurface == KeyboardSurface.EMOJI) return
        val knownSystemHeightPx = maxOf(
            lastSystemKeyboardHeightPx,
            (imeBottomPx - safeBottomPx).coerceAtLeast(0),
        )
        replacementHeightPx =
            if (knownSystemHeightPx > dp(80)) {
                (knownSystemHeightPx - dp(EMOJI_GAP_DP)).coerceAtLeast(0)
            } else {
                dp(DEFAULT_EMOJI_HEIGHT_DP)
            }
        // From this point the emoji panel owns the keyboard region. Do not retain the previous system
        // keyboard inset: TO_SYSTEM would otherwise mistake that stale height for the newly opening IME
        // and remove the emoji panel before the replacement animation has even started.
        imeBottomPx = safeBottomPx
        val params = emojiGrid.layoutParams as LinearLayout.LayoutParams
        params.height = replacementHeightPx
        emojiGrid.layoutParams = params
        keyboardSurface = KeyboardSurface.EMOJI
        emojiGrid.visibility = View.VISIBLE
        keyboard.setImageResource(R.drawable.ic_composer_keyboard)
        keyboard.contentDescription = activity.getString(R.string.composer_system_keyboard)
        updateBottom()
        root.post(::emitGeometry)
        root.post { requestNativeIme(false) }
    }

    private fun switchToSystemKeyboard() {
        if (!visible) return
        if (keyboardSurface != KeyboardSurface.EMOJI) {
            input.requestFocus()
            requestNativeIme(true)
            return
        }
        keyboardSurface = KeyboardSurface.TO_SYSTEM
        input.requestFocus()
        requestNativeIme(true)
        input.postDelayed({
            if (NativeComposerGeometry.shouldCompleteHandoffFallback(
                    isToSystem = keyboardSurface == KeyboardSurface.TO_SYSTEM,
                    imeAnimationRunning = imeAnimationRunning,
                    keyboardHeightPx = (imeBottomPx - safeBottomPx).coerceAtLeast(0),
                    minimumKeyboardHeightPx = dp(80),
                )
            ) {
                completeSystemHandoff()
            }
        }, IME_HANDOFF_FALLBACK_MS)
    }

    private fun dismissKeyboard() {
        keyboardSurface = KeyboardSurface.CLOSED
        emojiGrid.visibility = View.GONE
        keyboard.setImageResource(R.drawable.ic_composer_emoji)
        keyboard.contentDescription = activity.getString(R.string.composer_emoji)
        input.clearFocus()
        requestNativeIme(false)
        updateBottom()
        root.post(::emitGeometry)
    }

    private fun completeSystemHandoff() {
        keyboardSurface = KeyboardSurface.SYSTEM
        emojiGrid.visibility = View.GONE
        keyboard.setImageResource(R.drawable.ic_composer_emoji)
        keyboard.contentDescription = activity.getString(R.string.composer_emoji)
        updateBottom()
        root.post(::emitGeometry)
    }

    private fun requestNativeIme(show: Boolean) {
        val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        val controller = WindowInsetsControllerCompat(activity.window, input)
        if (show) {
            input.requestFocus()
            input.post {
                controller.show(WindowInsetsCompat.Type.ime())
                imm.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT)
            }
        } else {
            controller.hide(WindowInsetsCompat.Type.ime())
            imm.hideSoftInputFromWindow(input.windowToken, 0)
        }
    }

    private fun updateBottom() {
        if (!attached) return
        applyBounds()
    }

    private fun applyBounds() {
        if (!attached) return
        val params = root.layoutParams as FrameLayout.LayoutParams
        val keyboardBottom =
            if (
                keyboardSurface == KeyboardSurface.EMOJI ||
                keyboardSurface == KeyboardSurface.TO_SYSTEM
            ) {
                safeBottomPx
            } else {
                maxOf(imeBottomPx, safeBottomPx)
            }
        val decor = activity.window.decorView
        val boundsGap =
            if (hasBounds) {
                (decor.height - boundsBottomPx).coerceAtLeast(0)
            } else {
                0
        }
        params.bottomMargin = keyboardBottom + boundsGap
        if (hasBounds) {
            params.leftMargin = boundsLeftPx
            params.width = boundsWidthPx
        }
        root.layoutParams = params
    }

    private fun refreshAction() {
        val hasText = input.text.toString().trim().isNotEmpty()
        action.setImageResource(
            if (hasText) R.drawable.ic_composer_send
            else R.drawable.ic_composer_mic,
        )
        action.contentDescription = activity.getString(
            if (hasText) R.string.composer_send_record else R.string.composer_record,
        )
    }

    private fun setSending(sending: Boolean) {
        action.isEnabled = !sending
        action.alpha = if (sending) 0.58f else 1f
    }

    private fun deleteBeforeCursor() {
        val end = input.selectionStart
        if (end <= 0) return
        val text = input.text
        val start = Character.offsetByCodePoints(text, end, -1)
        text.delete(start, end)
    }

    private fun emitSend() {
        val text = input.text.toString().trim()
        if (text.isEmpty() || pendingSend != null) return
        val actionId = actionIds.incrementAndGet()
        pendingSend = actionId
        emit(JSONObject().apply {
            put("kind", "sendText")
            put("actionId", actionId)
            put("text", text)
        })
    }

    private fun showAttachmentMenu() {
        PopupMenu(activity, attachSlot).apply {
            menu.add(activity.getString(R.string.composer_gallery)).setOnMenuItemClickListener {
                emitAttachment("gallery")
                true
            }
            menu.add(activity.getString(R.string.composer_file)).setOnMenuItemClickListener {
                emitAttachment("file")
                true
            }
            show()
        }
    }

    private fun emitAttachment(source: String) {
        externalPickerSurface = keyboardSurface
        emit(JSONObject().apply {
            put("kind", "pickAttachment")
            put("actionId", actionIds.incrementAndGet())
            put("source", source)
        })
    }

    private fun emitGeometry() {
        // One geometry contract for every native keyboard surface: total bottom occupation in CSS px.
        // Derive every surface from the same composer base instead of root.height: root can still carry
        // the previous surface's measured height on the first handoff frame, and row.height alone omits
        // root's bottom padding. Both used to make emoji and system differ despite sharing a bottom edge.
        val composerBasePx = row.height + root.paddingTop + root.paddingBottom
        // Before the first layout row.height is zero. Waiting for the layout callback avoids publishing a
        // padding-only intermediate value; the explicit formulas below need no later transition frames.
        if (visible && row.height == 0) return
        val keyboardHeightPx =
            when (keyboardSurface) {
                KeyboardSurface.EMOJI,
                KeyboardSurface.TO_SYSTEM ->
                    replacementHeightPx +
                        (emojiGrid.layoutParams as LinearLayout.LayoutParams).topMargin
                // Tail-cap layout consumes the committed destination before animation. applyBounds()
                // separately uses imeBottomPx so the native overlay follows onProgress frame-by-frame.
                KeyboardSurface.SYSTEM ->
                    (committedImeBottomPx - safeBottomPx).coerceAtLeast(0)
                KeyboardSurface.CLOSED -> 0
            }
        val visibleComposerHeightPx =
            if (visible) composerBasePx.coerceAtLeast(0) else 0
        val visibleKeyboardHeightPx =
            if (visible) keyboardHeightPx.coerceAtLeast(0) else 0
        val composerHeightCss =
            NativeComposerGeometry.toCssPx(visibleComposerHeightPx, density)
        val keyboardHeightCss =
            NativeComposerGeometry.toCssPx(visibleKeyboardHeightPx, density)
        val occupiedDevicePx = NativeComposerGeometry.occupiedDevicePx(
            visible = visible,
            composerBasePx = composerBasePx,
            keyboardHeightPx = keyboardHeightPx,
        )
        val occupiedHeightCss = NativeComposerGeometry.toCssPx(occupiedDevicePx, density)
        // Composer height follows completed Android layout; keyboard height retains the existing final-value
        // surface policy. Emit when either independent endpoint changes, even when their sum stays constant
        // during an emoji/system handoff.
        if (
            !NativeComposerGeometry.shouldEmit(lastEmittedComposerHeightCss, composerHeightCss) &&
            !NativeComposerGeometry.shouldEmit(lastEmittedKeyboardHeightCss, keyboardHeightCss)
        ) return
        lastEmittedComposerHeightCss = composerHeightCss
        lastEmittedKeyboardHeightCss = keyboardHeightCss
        emit(JSONObject().apply {
            put("kind", "geometry")
            put("composerHeightPx", composerHeightCss)
            put("keyboardHeightPx", keyboardHeightCss)
            // Backward compatibility for an older cached Web bundle. New clients consume the split fields.
            put("occupiedHeightPx", occupiedHeightCss)
        })
    }

    private fun constrainComposerWidth() {
        if (root.width == 0) return
        val available = (root.width - root.paddingLeft - root.paddingRight).coerceAtLeast(0)
        val target = minOf(available, dp(MAX_COMPOSER_WIDTH_DP))
        val params = row.layoutParams as LinearLayout.LayoutParams
        if (params.width == target) return
        params.width = target
        params.gravity = Gravity.CENTER_HORIZONTAL
        row.layoutParams = params
    }

    private fun applyTheme(dark: Boolean) {
        darkTheme = dark
        surface = if (dark) Color.rgb(37, 40, 43) else Color.WHITE
        outline = if (dark) Color.rgb(73, 78, 82) else Color.rgb(221, 225, 227)
        onSurface = if (dark) Color.rgb(239, 242, 244) else Color.rgb(38, 44, 47)
        secondary = if (dark) Color.rgb(181, 188, 192) else Color.rgb(84, 94, 99)
        hintColor = if (dark) Color.rgb(151, 158, 163) else Color.rgb(121, 130, 135)
        input.setTextColor(onSurface)
        input.setHintTextColor(hintColor)
        input.background = outlinedSurface(12)
        attach.background = surfaceRipple(18)
        attach.setColorFilter(secondary)
        keyboard.setColorFilter(secondary)
        emojiGrid.background = rounded(surface, 14)
        recordingStatus.background = rounded(surface, 10)
    }

    private fun emit(payload: JSONObject) {
        payload.put("version", 1)
            .put("contextId", contextId)
            .put("sequence", ++sequence)
        val raw = payload.toString()
        SomsBridge.eval("window.__SOMS_COMPOSER_EVENT__&&window.__SOMS_COMPOSER_EVENT__($raw);")
    }

    private fun iconButton(icon: Int, description: String) = ImageButton(activity).apply {
        val button = this
        setImageResource(icon)
        contentDescription = description
        background = rounded(Color.TRANSPARENT, 24)
        setColorFilter(secondary)
        setPadding(dp(12), dp(12), dp(12), dp(12))
        stateListAnimator = android.animation.StateListAnimator().apply {
            addState(
                intArrayOf(android.R.attr.state_pressed),
                android.animation.ObjectAnimator.ofFloat(
                    button,
                    View.TRANSLATION_Z,
                    dp(6).toFloat(),
                ).setDuration(80),
            )
            addState(
                intArrayOf(),
                android.animation.ObjectAnimator.ofFloat(
                    button,
                    View.TRANSLATION_Z,
                    0f,
                ).setDuration(120),
            )
        }
    }

    private fun View.applySoftShadow(radiusDp: Int, elevationDp: Float) {
        outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(view: View, outline: Outline) {
                outline.setRoundRect(0, 0, view.width, view.height, dp(radiusDp).toFloat())
            }
        }
        elevation = elevationDp * density
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            outlineAmbientShadowColor =
                if (darkTheme) Color.argb(36, 0, 0, 0) else Color.argb(24, 24, 32, 38)
            outlineSpotShadowColor =
                if (darkTheme) Color.argb(74, 0, 0, 0) else Color.argb(46, 24, 32, 38)
        }
    }

    private fun rounded(color: Int, radiusDp: Int) = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = dp(radiusDp).toFloat()
        setColor(color)
    }

    private fun outlinedSurface(radiusDp: Int) = rounded(surface, radiusDp).apply {
        setStroke(dp(1), outline)
    }

    private fun surfaceRipple(radiusDp: Int) = RippleDrawable(
        ColorStateList.valueOf(if (darkTheme) 0x33FFFFFF else 0x16000000),
        outlinedSurface(radiusDp),
        rounded(Color.WHITE, radiusDp),
    )

    private fun transparentRipple(radiusDp: Int) = RippleDrawable(
        ColorStateList.valueOf(if (darkTheme) 0x33FFFFFF else 0x16000000),
        null,
        rounded(Color.WHITE, radiusDp),
    )

    private fun keyboardIsOpen() =
        keyboardSurface != KeyboardSurface.CLOSED || imeBottomPx > safeBottomPx + dp(24)

    private enum class KeyboardSurface {
        CLOSED,
        SYSTEM,
        EMOJI,
        TO_SYSTEM,
    }

    companion object {
        private const val MAX_COMPOSER_WIDTH_DP = 720
        private const val TABLET_MIN_WIDTH_DP = 600
        private const val PHONE_MAX_LINES = 5
        private const val TABLET_MAX_LINES = 8
        private const val DEFAULT_EMOJI_HEIGHT_DP = 280
        private const val EMOJI_GAP_DP = 8
        private const val IME_HANDOFF_FALLBACK_MS = 420L
        private const val PRE_R_INSETS_COMMIT_DELAY_MS = 80L
        private const val SHOW_DURATION_MS = 140L
        private const val HIDE_DURATION_MS = 90L
        private val PRIMARY = Color.rgb(49, 119, 213)
        private val RECORDING = Color.rgb(198, 52, 52)
        private val EMOJI = listOf(
            "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🙂",
            "🙃", "😉", "😊", "🥰", "😍", "😘", "😋", "😎",
            "🤗", "🤔", "🫡", "😐", "😑", "😶", "🙄", "😏",
            "😣", "😥", "😮", "🤐", "😯", "😪", "😫", "🥱",
            "😴", "😌", "🤓", "😕", "🫤", "😲", "☹️", "🙁",
            "😖", "😞", "😟", "😤", "😢", "😭", "😦", "😧",
            "🤯", "😬", "😰", "😱", "🥵", "🥶", "😳", "🤪",
            "😵", "🥴", "🤢", "🤮", "🤧", "😷", "🤒", "🤕",
            "👍", "👎", "👏", "🙌", "🤝", "🙏", "💪", "❤️",
        )
    }
}

/** Pure native-composer geometry policy, kept Android-free so handoff invariants can be unit tested. */
internal object NativeComposerGeometry {
    fun occupiedDevicePx(
        visible: Boolean,
        composerBasePx: Int,
        keyboardHeightPx: Int,
    ): Int =
        if (visible) {
            composerBasePx.coerceAtLeast(0) + keyboardHeightPx.coerceAtLeast(0)
        } else {
            0
        }

    fun toCssPx(devicePx: Int, density: Float): Int {
        if (!density.isFinite() || density <= 0f) return 0
        return Math.round(devicePx.coerceAtLeast(0) / density)
    }

    fun shouldEmit(previousCssPx: Int?, nextCssPx: Int): Boolean =
        previousCssPx != nextCssPx

    fun shouldCompleteHandoffFallback(
        isToSystem: Boolean,
        imeAnimationRunning: Boolean,
        keyboardHeightPx: Int,
        minimumKeyboardHeightPx: Int,
    ): Boolean =
        isToSystem &&
            !imeAnimationRunning &&
            keyboardHeightPx > minimumKeyboardHeightPx
}
