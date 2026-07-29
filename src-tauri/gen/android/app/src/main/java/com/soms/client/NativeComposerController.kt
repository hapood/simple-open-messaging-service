package com.soms.client

import android.graphics.Color
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.inputmethod.EditorInfo
import android.view.TouchDelegate
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridView
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.PopupMenu
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicLong

/**
 * Activity-owned Material floating composer. It is a sibling overlay above the WebView; Angular renders
 * no Android input surface. The native EditText remains the single draft/selection authority.
 */
class NativeComposerController(
    private val activity: MainActivity,
    private val requestIme: (Boolean) -> Unit,
) {
    private val density = activity.resources.displayMetrics.density
    private fun dp(value: Int) = Math.round(value * density)
    private val isExpandedWindow =
        activity.resources.configuration.smallestScreenWidthDp >= TABLET_MIN_WIDTH_DP

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
        contentDescription = "Attach"
        isClickable = true
        isFocusable = true
    }
    private val attach = iconButton(R.drawable.ic_composer_attach, "Attach").apply {
        background = outlinedSurface(18)
        elevation = 0f
        isClickable = false
        isFocusable = false
        setPadding(dp(8), dp(8), dp(8), dp(8))
    }
    private val input = EditText(activity).apply {
        hint = "Message"
        textSize = 16f
        maxLines = if (isExpandedWindow) TABLET_MAX_LINES else PHONE_MAX_LINES
        minLines = 1
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(14), 0, dp(8), 0)
        background = outlinedSurface(16)
        elevation = dp(2).toFloat()
        inputType = InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or
            InputType.TYPE_TEXT_FLAG_MULTI_LINE
        imeOptions = EditorInfo.IME_FLAG_NO_ENTER_ACTION
        isVerticalScrollBarEnabled = false
        overScrollMode = View.OVER_SCROLL_NEVER
        setHorizontallyScrolling(false)
        setSingleLine(false)
    }
    private val keyboard = iconButton(R.drawable.ic_composer_emoji, "Emoji").apply {
        setPadding(dp(11), dp(11), dp(11), dp(11))
    }
    private val action = iconButton(android.R.drawable.ic_btn_speak_now, "Record").apply {
        background = rounded(PRIMARY, 24)
        elevation = dp(2).toFloat()
        setColorFilter(Color.WHITE)
    }
    private val emojiGrid = GridView(activity).apply {
        numColumns = 8
        verticalSpacing = dp(4)
        horizontalSpacing = dp(2)
        gravity = Gravity.CENTER
        visibility = View.GONE
        setPadding(dp(4), dp(10), dp(4), dp(8))
        background = rounded(Color.rgb(250, 250, 248), 18)
        adapter = ArrayAdapter(
            activity,
            android.R.layout.simple_list_item_1,
            EMOJI,
        )
        onItemClickListener = android.widget.AdapterView.OnItemClickListener { _, _, position, _ ->
            val at = input.selectionStart.coerceAtLeast(0)
            input.text.insert(at, EMOJI[position])
            input.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
        }
    }

    private var attached = false
    private var contextId = 0L
    private var threadId = 0L
    private var sequence = 0L
    private var visible = false
    private var emojiVisible = false
    private var imeBottomPx = 0
    private var safeBottomPx = 0
    private val actionIds = AtomicLong(System.currentTimeMillis() * 1000)
    private var pendingSend: Long? = null
    private var voiceDownY = 0f
    private var voiceCancelArmed = false

    init {
        attachSlot.addView(
            attach,
            FrameLayout.LayoutParams(dp(36), dp(36)).apply {
                gravity = Gravity.START or Gravity.BOTTOM
            },
        )
        row.addView(attachSlot, LinearLayout.LayoutParams(dp(40), dp(48)))
        val inputWrap = FrameLayout(activity)
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
        input.setPadding(dp(14), 0, dp(48), 0)
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
        input.setOnFocusChangeListener { _, focused ->
            if (focused && emojiVisible) showEmoji(false)
        }
        keyboard.setOnClickListener { showEmoji(!emojiVisible) }
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
        input.hint = context.optString("placeholder", "Message")
        input.setText(context.optString("initialDraft", ""))
        input.setSelection(input.text.length)
        ensureAttached()
        visible = true
        root.visibility = View.VISIBLE
        updateBottom()
        root.post(::emitGeometry)
    }

    fun update(json: String) {
        val patch = runCatching { JSONObject(json) }.getOrNull() ?: return
        if (patch.optLong("contextId") != contextId) return
        if (patch.has("placeholder")) input.hint = patch.optString("placeholder")
        if (patch.has("sending")) action.isEnabled = !patch.optBoolean("sending")
    }

    fun acknowledge(actionId: Long, accepted: Boolean) {
        if (pendingSend == actionId) {
            if (accepted) input.text.clear()
            pendingSend = null
        }
    }

    fun hide(requestContextId: Long) {
        if (requestContextId != contextId) return
        showEmoji(false)
        visible = false
        root.visibility = View.GONE
        input.clearFocus()
        emitGeometry()
    }

    fun updateInsets(imeBottomDevicePx: Int, safeBottomDevicePx: Int) {
        imeBottomPx = imeBottomDevicePx.coerceAtLeast(0)
        safeBottomPx = safeBottomDevicePx.coerceAtLeast(0)
        updateBottom()
    }

    fun handleBack(): Boolean {
        if (!visible || !emojiVisible) return false
        showEmoji(false)
        input.requestFocus()
        requestIme(true)
        return true
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

    private fun showEmoji(show: Boolean) {
        if (!visible || emojiVisible == show) return
        emojiVisible = show
        emojiGrid.visibility = if (show) View.VISIBLE else View.GONE
        if (show) {
            requestIme(false)
        }
        keyboard.contentDescription = if (show) "System keyboard" else "Emoji"
        updateBottom()
        root.post(::emitGeometry)
    }

    private fun updateBottom() {
        if (!attached) return
        val params = root.layoutParams as FrameLayout.LayoutParams
        params.bottomMargin = if (emojiVisible) safeBottomPx else maxOf(imeBottomPx, safeBottomPx)
        root.layoutParams = params
    }

    private fun refreshAction() {
        val hasText = input.text.toString().trim().isNotEmpty()
        action.setImageResource(
            if (hasText) android.R.drawable.ic_menu_send
            else android.R.drawable.ic_btn_speak_now,
        )
        action.contentDescription =
            if (hasText) "Send; hold to record" else "Hold to record"
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
            menu.add("Gallery").setOnMenuItemClickListener {
                emitAttachment("gallery")
                true
            }
            menu.add("File").setOnMenuItemClickListener {
                emitAttachment("file")
                true
            }
            show()
        }
    }

    private fun emitAttachment(source: String) {
        emit(JSONObject().apply {
            put("kind", "pickAttachment")
            put("actionId", actionIds.incrementAndGet())
            put("source", source)
        })
    }

    private fun emitGeometry() {
        val cssHeight = if (visible) Math.round(root.height / density) else 0
        emit(JSONObject().apply {
            put("kind", "geometry")
            put("occupiedHeightPx", cssHeight)
            put("replacesIme", emojiVisible)
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

    private fun emit(payload: JSONObject) {
        payload.put("version", 1)
            .put("contextId", contextId)
            .put("sequence", ++sequence)
        val raw = payload.toString()
        SomsBridge.eval("window.__SOMS_COMPOSER_EVENT__&&window.__SOMS_COMPOSER_EVENT__($raw);")
    }

    private fun iconButton(icon: Int, description: String) = ImageButton(activity).apply {
        setImageResource(icon)
        contentDescription = description
        background = rounded(Color.TRANSPARENT, 24)
        setColorFilter(Color.rgb(65, 75, 76))
        setPadding(dp(12), dp(12), dp(12), dp(12))
    }

    private fun rounded(color: Int, radiusDp: Int) = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = dp(radiusDp).toFloat()
        setColor(color)
    }

    private fun outlinedSurface(radiusDp: Int) = rounded(SURFACE, radiusDp).apply {
        setStroke(dp(1), OUTLINE)
    }

    companion object {
        private const val MAX_COMPOSER_WIDTH_DP = 720
        private const val TABLET_MIN_WIDTH_DP = 600
        private const val PHONE_MAX_LINES = 5
        private const val TABLET_MAX_LINES = 8
        private val SURFACE = Color.rgb(255, 255, 255)
        private val OUTLINE = Color.rgb(224, 226, 224)
        private val PRIMARY = Color.rgb(49, 119, 213)
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
