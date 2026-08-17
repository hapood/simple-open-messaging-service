package com.soms.client

import android.graphics.Color
import android.graphics.Rect
import android.graphics.Bitmap
import android.graphics.BitmapFactory
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
import androidx.core.view.ViewCompat
import android.widget.BaseAdapter
import android.widget.Chronometer
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.GridView
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.ImageView
import android.util.Base64
import android.util.LruCache
import androidx.appcompat.widget.ListPopupWindow
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicLong

/** MIME families accepted from clipboard/IME content commits. Android 12 rejects a leading wildcard. */
internal val COMPOSER_RECEIVE_MIME_TYPES = arrayOf(
    "application/*",
    "audio/*",
    "image/*",
    "text/*",
    "video/*",
)

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
        // Match the web .ci-input-bar outer padding: 8px vertical, 12px horizontal.
        setPadding(dp(12), dp(8), dp(12), dp(8))
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
    private val input = MentionEditText(activity).apply {
        hint = "Message"
        textSize = 16f
        maxLines = COMPOSER_MAX_LINES
        minLines = 1
        minHeight = dp(48)
        gravity = Gravity.CENTER_VERTICAL
        includeFontPadding = false
        setTextColor(onSurface)
        setHintTextColor(hintColor)
        setPadding(dp(14), dp(11), dp(48), dp(11))
        background = null
        inputType = InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or
            InputType.TYPE_TEXT_FLAG_MULTI_LINE
        imeOptions = EditorInfo.IME_FLAG_NO_ENTER_ACTION
        isVerticalScrollBarEnabled = false
        overScrollMode = View.OVER_SCROLL_NEVER
        setHorizontallyScrolling(false)
        setSingleLine(false)
    }

    init {
        // Android clipboard and modern IMEs expose pasted files as content:// URI grants, not filesystem
        // paths. Consume only URI items here; any text portion is returned to EditText's normal paste path.
        ViewCompat.setOnReceiveContentListener(input, COMPOSER_RECEIVE_MIME_TYPES) { _, payload ->
            val split = payload.partition { item -> item.uri != null }
            val uriContent = split.first
            val remaining = split.second
            val uris = uriContent?.clip?.let { clip ->
                (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
            }.orEmpty()
            if (uris.isNotEmpty()) acceptPastedFiles(uris)
            remaining
        }
    }
    private val quoteText = TextView(activity).apply {
        textSize = 12f
        setTextColor(secondary)
        includeFontPadding = false
        maxLines = 1
        ellipsize = android.text.TextUtils.TruncateAt.END
        gravity = Gravity.CENTER_VERTICAL
    }
    private val quoteClose = TextView(activity).apply {
        text = "×"
        textSize = 22f
        setTextColor(secondary)
        includeFontPadding = false
        gravity = Gravity.CENTER
        contentDescription = activity.getString(R.string.composer_cancel_quote)
        isClickable = true
        isFocusable = true
        background = transparentRipple(16)
    }
    private val quoteBar = LinearLayout(activity).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        visibility = View.GONE
        setPadding(dp(8), dp(2), dp(2), dp(2))
        addView(
            View(activity).apply { setBackgroundColor(PRIMARY) },
            LinearLayout.LayoutParams(dp(3), ViewGroup.LayoutParams.MATCH_PARENT).apply {
                rightMargin = dp(8)
            },
        )
        addView(
            quoteText,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f),
        )
        addView(quoteClose, LinearLayout.LayoutParams(dp(32), dp(30)))
    }
    private val inputSurface = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        minimumHeight = dp(48)
        clipToOutline = true
        background = outlinedSurface(12)
        applySoftShadow(12, 2.5f)
    }
    private data class MentionCandidate(
        val kind: String,
        val id: String,
        val label: String,
        val avatarUrl: String,
        val fallbackText: String,
        val colorSeed: String,
    )
    private val mentionCandidates = mutableListOf<MentionCandidate>()
    private var mentionQueryStart = -1
    private var mentionRequestId = 0L
    private var latestMentionRequestId = 0L
    private var mentionsEnabled = false
    private val requestedMedia = mutableSetOf<String>()
    private val mediaRequestUrls = mutableMapOf<Long, String>()
    private val avatarCache = object : LruCache<String, Bitmap>(2 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }
    private val mentionAdapter = object : BaseAdapter() {
        override fun getCount() = mentionCandidates.size
        override fun getItem(position: Int) = mentionCandidates[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
            val candidate = getItem(position)
            val item = (convertView as? LinearLayout) ?: LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(12), dp(7), dp(12), dp(7))
                addView(
                    ImageView(activity).apply {
                        scaleType = ImageView.ScaleType.CENTER_CROP
                        clipToOutline = true
                        outlineProvider = object : ViewOutlineProvider() {
                            override fun getOutline(view: View, outline: Outline) {
                                outline.setOval(0, 0, view.width, view.height)
                            }
                        }
                    },
                    LinearLayout.LayoutParams(dp(32), dp(32)).apply {
                        rightMargin = dp(10)
                    },
                )
                addView(
                    TextView(activity).apply { textSize = 15f },
                    LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
                )
            }
            val avatar = item.getChildAt(0) as ImageView
            val label = item.getChildAt(1) as TextView
            label.text = if (candidate.kind == "all") "@${candidate.label}" else candidate.label
            label.setTextColor(onSurface)
            if (candidate.kind == "all") {
                avatar.setImageResource(R.drawable.ic_mention_everyone)
                avatar.setColorFilter(
                    if (darkTheme) Color.rgb(255, 172, 174) else Color.rgb(190, 71, 73),
                )
                avatar.setPadding(dp(6), dp(6), dp(6), dp(6))
                avatar.background = rounded(
                    if (darkTheme) Color.rgb(76, 46, 49) else Color.rgb(255, 235, 236),
                    16,
                )
                return item
            }
            avatar.clearColorFilter()
            avatar.setPadding(0, 0, 0, 0)
            val bitmap = avatarCache.get(candidate.avatarUrl)
            if (bitmap != null) {
                avatar.setImageBitmap(bitmap)
            } else {
                avatar.setImageDrawable(
                    InitialsAvatarDrawable(
                        candidate.fallbackText,
                        candidate.colorSeed,
                        darkTheme,
                    ),
                )
                requestMentionAvatar(candidate.avatarUrl)
            }
            return item
        }
    }
    private val mentionPopup = ListPopupWindow(activity).apply {
        anchorView = input
        setAdapter(mentionAdapter)
        isModal = true
        setOnItemClickListener { _, _, position, _ ->
            insertMentionCandidate(mentionCandidates[position])
        }
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
    private val recordingDot = TextView(activity).apply {
        text = "●"
        textSize = 14f
        setTextColor(RECORDING)
        includeFontPadding = false
    }
    private val recordingClock = Chronometer(activity).apply {
        textSize = 14f
        setTextColor(onSurface)
        includeFontPadding = false
    }
    private val recordingHint = TextView(activity).apply {
        text = activity.getString(R.string.composer_record_release_cancel)
        textSize = 13f
        setTextColor(hintColor)
        includeFontPadding = false
        setSingleLine(true)
        ellipsize = android.text.TextUtils.TruncateAt.END
        visibility = View.GONE
    }
    private val recordingStatus = LinearLayout(activity).apply {
        orientation = LinearLayout.HORIZONTAL
        visibility = View.GONE
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(10), 0, dp(10), 0)
        background = rounded(surface, 10)
        elevation = dp(6).toFloat()
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        addView(recordingDot, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ))
        addView(recordingClock, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply { leftMargin = dp(8) })
        addView(recordingHint, LinearLayout.LayoutParams(
            0,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            1f,
        ).apply { leftMargin = dp(8) })
    }
    private val recordCancelIcon = ImageView(activity).apply {
        setImageResource(R.drawable.ic_composer_delete)
        setColorFilter(RECORDING)
    }
    private val recordCancelLabel = TextView(activity).apply {
        text = activity.getString(R.string.composer_record_cancel)
        textSize = 12f
        setTextColor(RECORDING)
        includeFontPadding = false
        gravity = Gravity.CENTER
        setSingleLine(true)
    }
    private val recordCancelTarget = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        visibility = View.GONE
        setPadding(dp(2), dp(5), dp(2), dp(5))
        background = rounded(surface, 18)
        elevation = dp(6).toFloat()
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        addView(recordCancelIcon, LinearLayout.LayoutParams(dp(26), dp(26)))
        addView(recordCancelLabel, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(16),
        ))
    }
    private val attachmentIcons = mutableListOf<ImageView>()
    private val attachmentLabels = mutableListOf<TextView>()
    private val attachmentItems = LinearLayout(activity).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(4), dp(2), dp(4), dp(2))
    }
    private val attachmentHorizontalScroll = HorizontalScrollView(activity).apply {
        isHorizontalScrollBarEnabled = true
        isFillViewport = true
        overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
    }
    private val attachmentVerticalScroll = ScrollView(activity).apply {
        isVerticalScrollBarEnabled = true
        isFillViewport = true
        overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
        visibility = View.GONE
    }
    private val attachmentDrawer = FrameLayout(activity).apply {
        visibility = View.GONE
        clipToOutline = true
        outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(view: View, outline: Outline) {
                outline.setRoundRect(0, 0, view.width, view.height, dp(12).toFloat())
            }
        }
    }
    private var attachmentDrawerOpen = false
    private var attachmentDrawerVertical = false
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
                input.text?.insert(at, EMOJI[position])
            }
            input.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
        }
    }

    private var attached = false
    private var contextId = 0L
    private var threadId = 0L
    private var sequence = 0L
    private var visible = false
    private val emitLinkMarkers = Runnable {
        if (!visible) return@Runnable
        val links = JSONArray()
        input.urlMarkers().forEach { marker ->
            links.put(JSONObject().apply {
                put("href", marker.href)
                put("start", marker.start)
                put("end", marker.end)
            })
        }
        emit(JSONObject().apply {
            put("kind", "linkMarkers")
            put("text", input.text?.toString().orEmpty())
            put("links", links)
        })
    }
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
    private var voiceCancelArmed = false

    init {
        input.onUrlMarkersChanged = {
            input.removeCallbacks(emitLinkMarkers)
            input.postDelayed(emitLinkMarkers, LINK_MARKER_DEBOUNCE_MS)
        }
        applyTheme(darkTheme)
        attachmentHorizontalScroll.addView(
            attachmentItems,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        attachmentDrawer.addView(
            attachmentHorizontalScroll,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        attachmentDrawer.addView(
            attachmentVerticalScroll,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        attachmentItems.addView(
            attachmentOption(
                R.drawable.ic_composer_gallery,
                activity.getString(R.string.composer_gallery),
            ) { selectAttachment("gallery") },
            LinearLayout.LayoutParams(dp(72), ViewGroup.LayoutParams.MATCH_PARENT),
        )
        attachmentItems.addView(
            attachmentOption(
                R.drawable.ic_composer_file,
                activity.getString(R.string.composer_file),
            ) { selectAttachment("file") },
            LinearLayout.LayoutParams(dp(72), ViewGroup.LayoutParams.MATCH_PARENT),
        )
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
                gravity = Gravity.END or Gravity.BOTTOM
                rightMargin = dp(6)
                bottomMargin = dp(4)
            },
        )
        input.setPadding(dp(14), dp(11), dp(48), dp(11))
        inputSurface.addView(
            quoteBar,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(34),
            ),
        )
        inputSurface.addView(
            inputWrap,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
        row.addView(
            inputSurface,
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
        val rowHost = FrameLayout(activity).apply {
            clipChildren = false
            addView(
                row,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.BOTTOM,
                ),
            )
            addView(
                attachmentDrawer,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ).apply { leftMargin = dp(48) },
            )
            addView(
                recordCancelTarget,
                FrameLayout.LayoutParams(dp(48), dp(62), Gravity.END or Gravity.BOTTOM).apply {
                    bottomMargin = dp(60)
                },
            )
        }
        root.addView(
            rowHost,
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
        input.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                queryMentionsAtCursor()
            }
        })
        input.setOnClickListener {
            closeAttachmentDrawer()
            if (keyboardSurface == KeyboardSurface.EMOJI) switchToSystemKeyboard()
            emit(JSONObject().apply { put("kind", "interaction") })
        }
        keyboard.setOnClickListener {
            closeAttachmentDrawer()
            if (
                keyboardSurface == KeyboardSurface.EMOJI ||
                keyboardSurface == KeyboardSurface.TO_SYSTEM
            ) {
                switchToSystemKeyboard()
            } else {
                showEmojiKeyboard()
            }
        }
        attachSlot.setOnClickListener { toggleAttachmentDrawer() }
        quoteClose.setOnClickListener {
            setQuote(null)
            emit(JSONObject().apply { put("kind", "cancelQuote") })
        }
        action.setOnClickListener {
            closeAttachmentDrawer()
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
                voiceCancelArmed = false
                false
            } else if (
                event.actionMasked == android.view.MotionEvent.ACTION_MOVE &&
                activity.nativeVoiceRecording()
            ) {
                val next = isInsideVoiceCancelTarget(event)
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
            updateAttachmentDrawerAxis()
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
        closeAttachmentDrawer(immediate = true)
        mentionsEnabled = context.optBoolean("mentionsEnabled", false)
        mentionQueryStart = -1
        mentionPopup.dismiss()
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
        input.setSelection(input.length())
        setQuote(context.optJSONObject("quote"))
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
        if (patch.has("quote")) setQuote(patch.optJSONObject("quote"))
        if (patch.has("theme")) {
            applyTheme(
                when (patch.optString("theme", "system")) {
                    "dark" -> true
                    "light" -> false
                    else -> isDark
                },
            )
        }
        patch.optJSONObject("mentionResults")?.let(::applyMentionResults)
        patch.optJSONObject("mediaResolved")?.let(::applyResolvedMedia)
    }

    fun acknowledge(actionId: Long, accepted: Boolean) {
        if (pendingSend == actionId) {
            if (accepted) input.text?.clear()
            pendingSend = null
            setSending(false)
        }
    }

    fun onVoiceRecordingStarted() {
        recordingClock.base = android.os.SystemClock.elapsedRealtime()
        updateVoiceCancelState(false)
        recordingStatus.visibility = View.VISIBLE
        recordCancelTarget.visibility = View.VISIBLE
        recordingClock.start()
        keyboard.visibility = View.INVISIBLE
        action.background = rounded(RECORDING, 24)
        action.setImageResource(R.drawable.ic_composer_mic)
        action.contentDescription = activity.getString(R.string.composer_recording)
    }

    fun onVoiceRecordingFinished() {
        recordingClock.stop()
        recordingStatus.visibility = View.GONE
        recordCancelTarget.visibility = View.GONE
        keyboard.visibility = View.VISIBLE
        action.background = rounded(PRIMARY, 24)
        action.alpha = 1f
        refreshAction()
    }

    /** The recorder reached its byte/time cap, but the press gesture remains active until ACTION_UP. */
    fun onVoiceRecordingCapped() {
        recordingClock.stop()
    }

    /** Keep the fixed cancel target locale-independent; the flexible status area owns the longer instruction. */
    private fun updateVoiceCancelState(cancel: Boolean) {
        recordingClock.setTextColor(onSurface)
        recordingHint.visibility = if (cancel) View.VISIBLE else View.GONE
        recordingHint.setTextColor(RECORDING)
        recordCancelTarget.background = rounded(if (cancel) RECORDING else surface, 18)
        recordCancelIcon.setColorFilter(if (cancel) Color.WHITE else RECORDING)
        recordCancelLabel.setTextColor(if (cancel) Color.WHITE else RECORDING)
        action.background = rounded(if (cancel) secondary else RECORDING, 24)
        recordingStatus.contentDescription = activity.getString(
            if (cancel) R.string.composer_recording_cancel else R.string.composer_recording,
        )
    }

    /** The visible target matches the send key; a small invisible tolerance preserves comfortable thumb input. */
    private fun isInsideVoiceCancelTarget(event: MotionEvent): Boolean {
        if (recordCancelTarget.visibility != View.VISIBLE) return false
        val location = IntArray(2)
        recordCancelTarget.getLocationOnScreen(location)
        val tolerance = dp(14)
        return event.rawX >= location[0] - tolerance &&
            event.rawX <= location[0] + recordCancelTarget.width + tolerance &&
            event.rawY >= location[1] - tolerance &&
            event.rawY <= location[1] + recordCancelTarget.height + tolerance
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
        updateKeyboardButtonState()
    }

    fun hide(requestContextId: Long) {
        if (requestContextId != contextId) return
        input.removeCallbacks(emitLinkMarkers)
        mentionPopup.dismiss()
        closeAttachmentDrawer(immediate = true)
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
                    input.text?.clear()
                    hasBounds = false
                }
            })
            .start()
        emitGeometry()
    }

    /** Final lifecycle notification. Unlike [hide], this is called only when the Activity-owned composer
     * is genuinely being destroyed, so transient overlays never publish a draft to the thread list. */
    fun destroy() {
        if (!visible) return
        emit(JSONObject().apply {
            put("kind", "destroy")
            put("text", input.text?.toString().orEmpty())
        })
        mentionPopup.dismiss()
        closeAttachmentDrawer(immediate = true)
        root.animate().cancel()
        visible = false
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
        if (visible && attachmentDrawerOpen) {
            closeAttachmentDrawer()
            return true
        }
        if (!visible || !keyboardIsOpen()) return false
        dismissKeyboard()
        return true
    }

    fun handleOutsideTouch(event: MotionEvent) {
        if (!visible || event.actionMasked != MotionEvent.ACTION_DOWN) return
        if (attachmentDrawerOpen) {
            val attachBounds = Rect()
            val drawerBounds = Rect()
            attachSlot.getGlobalVisibleRect(attachBounds)
            attachmentDrawer.getGlobalVisibleRect(drawerBounds)
            if (
                !attachBounds.contains(event.rawX.toInt(), event.rawY.toInt()) &&
                !drawerBounds.contains(event.rawX.toInt(), event.rawY.toInt())
            ) {
                closeAttachmentDrawer()
            }
        }
        if (!keyboardIsOpen()) return
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
        updateKeyboardButtonState()
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
        updateKeyboardButtonState()
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
        updateKeyboardButtonState()
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
        updateKeyboardButtonState()
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
        if (input.deleteMentionBeforeCursor()) return
        val end = input.selectionStart
        if (end <= 0) return
        val text = input.text ?: return
        val start = Character.offsetByCodePoints(text, end, -1)
        text.delete(start, end)
    }

    private fun emitSend() {
        val rawText = input.text?.toString().orEmpty()
        val text = rawText.trim()
        if (text.isEmpty() || pendingSend != null) return
        val leadingTrim = rawText.length - rawText.trimStart().length
        val mentions = JSONArray()
        NativeMentionLogic.validRanges(rawText, input.mentionRanges()).forEach { range ->
            mentions.put(JSONObject().apply {
                put("start", range.start - leadingTrim)
                put("end", range.end - leadingTrim)
                put("kind", range.kind)
                put("id", range.id)
                put("label", range.label)
            })
        }
        val actionId = actionIds.incrementAndGet()
        pendingSend = actionId
        emit(JSONObject().apply {
            put("kind", "sendText")
            put("actionId", actionId)
            put("text", text)
            put("mentions", mentions)
        })
    }

    private fun queryMentionsAtCursor() {
        if (!mentionsEnabled || !visible || input.selectionStart != input.selectionEnd) {
            mentionQueryStart = -1
            mentionPopup.dismiss()
            return
        }
        val editable = input.text ?: return
        val query = NativeMentionLogic.query(editable, input.selectionStart)
        if (query == null) {
            mentionQueryStart = -1
            mentionPopup.dismiss()
            return
        }
        mentionQueryStart = query.start
        val requestId = ++mentionRequestId
        latestMentionRequestId = requestId
        emit(JSONObject().apply {
            put("kind", "queryMentions")
            put("requestId", requestId)
            put("query", query.query)
        })
    }

    private fun applyMentionResults(result: JSONObject) {
        if (
            result.optLong("requestId") != latestMentionRequestId ||
            mentionQueryStart < 0 ||
            !visible
        ) return
        val items = result.optJSONArray("items") ?: JSONArray()
        mentionCandidates.clear()
        for (index in 0 until items.length()) {
            val item = items.optJSONObject(index) ?: continue
            val kind = item.optString("kind")
            val id = item.optString("id")
            val label = item.optString("label")
            if ((kind != "user" && kind != "all") || id.isBlank() || label.isBlank()) continue
            val avatar = item.optJSONObject("avatar")
            mentionCandidates += MentionCandidate(
                kind,
                id,
                label,
                if (avatar?.optString("kind") == "user") avatar.optString("url") else "",
                if (avatar?.optString("kind") == "user") {
                    avatar.optString("fallbackText", label.take(1))
                } else {
                    ""
                },
                if (avatar?.optString("kind") == "user") avatar.optString("colorSeed", id) else id,
            )
        }
        mentionAdapter.notifyDataSetChanged()
        if (mentionCandidates.isEmpty()) {
            mentionPopup.dismiss()
        } else {
            mentionPopup.width = input.width.coerceAtLeast(dp(220))
            mentionPopup.height = ViewGroup.LayoutParams.WRAP_CONTENT
            mentionPopup.show()
        }
    }

    private fun insertMentionCandidate(candidate: MentionCandidate) {
        val start = mentionQueryStart
        if (start < 0) return
        mentionPopup.dismiss()
        mentionQueryStart = -1
        val mentionForeground =
            if (candidate.kind == "all") Color.rgb(190, 71, 73)
            else if (darkTheme) Color.rgb(129, 184, 255) else Color.rgb(28, 100, 190)
        val mentionBackground =
            if (candidate.kind == "all") Color.argb(35, 220, 70, 80)
            else Color.argb(28, 50, 130, 230)
        input.insertMention(
            start,
            candidate.kind,
            candidate.id,
            candidate.label,
            mentionForeground,
            mentionBackground,
            dp(3),
            dp(4).toFloat(),
        )
    }

    private fun requestMentionAvatar(url: String) {
        if (url.isBlank() || avatarCache.get(url) != null || !requestedMedia.add(url)) return
        val requestId = ++mentionRequestId
        mediaRequestUrls[requestId] = url
        emit(JSONObject().apply {
            put("kind", "resolveMedia")
            put("requestId", requestId)
            put("url", url)
        })
    }

    private fun applyResolvedMedia(result: JSONObject) {
        val requestId = result.optLong("requestId")
        val url = mediaRequestUrls.remove(requestId) ?: return
        val encoded = result.optString("base64")
        if (encoded.isBlank()) return
        val bytes = runCatching { Base64.decode(encoded, Base64.DEFAULT) }.getOrNull() ?: return
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return
        avatarCache.put(url, bitmap)
        mentionAdapter.notifyDataSetChanged()
    }

    private fun toggleAttachmentDrawer() {
        if (attachmentDrawerOpen) closeAttachmentDrawer() else openAttachmentDrawer()
    }

    private fun openAttachmentDrawer() {
        if (!visible || attachmentDrawerOpen) return
        attachmentDrawerOpen = true
        mentionPopup.dismiss()
        if (keyboardSurface == KeyboardSurface.EMOJI) dismissKeyboard()
        updateAttachmentButtonState()
        updateKeyboardButtonState()
        updateAttachmentDrawerAxis()
        attachmentDrawer.animate().cancel()
        attachmentDrawer.visibility = View.VISIBLE
        attachmentDrawer.alpha = 0f
        attachmentDrawer.translationX = -dp(8).toFloat()
        attachmentDrawer.animate()
            .alpha(1f)
            .translationX(0f)
            .setDuration(ATTACHMENT_DRAWER_DURATION_MS)
            .setInterpolator(enterInterpolator)
            .setListener(null)
            .start()
    }

    private fun closeAttachmentDrawer(immediate: Boolean = false) {
        if (!attachmentDrawerOpen && attachmentDrawer.visibility == View.GONE) return
        attachmentDrawerOpen = false
        updateAttachmentButtonState()
        attachmentDrawer.animate().cancel()
        if (immediate) {
            attachmentDrawer.alpha = 0f
            attachmentDrawer.translationX = -dp(8).toFloat()
            attachmentDrawer.visibility = View.GONE
            return
        }
        attachmentDrawer.animate()
            .alpha(0f)
            .translationX(-dp(8).toFloat())
            .setDuration(ATTACHMENT_DRAWER_DURATION_MS)
            .setInterpolator(enterInterpolator)
            .setListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    attachmentDrawer.animate().setListener(null)
                    if (!attachmentDrawerOpen) attachmentDrawer.visibility = View.GONE
                }
            })
            .start()
    }

    private fun updateAttachmentDrawerAxis() {
        if (row.height == 0) return
        val vertical = row.height >= dp(73)
        if (vertical == attachmentDrawerVertical) return
        attachmentDrawerVertical = vertical
        (attachmentItems.parent as? ViewGroup)?.removeView(attachmentItems)
        if (vertical) {
            attachmentItems.orientation = LinearLayout.VERTICAL
            attachmentItems.layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
            for (index in 0 until attachmentItems.childCount) {
                attachmentItems.getChildAt(index).layoutParams =
                    LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(64))
            }
            attachmentVerticalScroll.addView(attachmentItems)
            attachmentHorizontalScroll.visibility = View.GONE
            attachmentVerticalScroll.visibility = View.VISIBLE
        } else {
            attachmentItems.orientation = LinearLayout.HORIZONTAL
            attachmentItems.layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            for (index in 0 until attachmentItems.childCount) {
                attachmentItems.getChildAt(index).layoutParams =
                    LinearLayout.LayoutParams(dp(72), ViewGroup.LayoutParams.MATCH_PARENT)
            }
            attachmentHorizontalScroll.addView(attachmentItems)
            attachmentVerticalScroll.visibility = View.GONE
            attachmentHorizontalScroll.visibility = View.VISIBLE
        }
    }

    private fun selectAttachment(source: String) {
        closeAttachmentDrawer()
        emitAttachment(source)
    }

    private fun emitAttachment(source: String) {
        externalPickerSurface = keyboardSurface
        emit(JSONObject().apply {
            put("kind", "pickAttachment")
            put("actionId", actionIds.incrementAndGet())
            put("source", source)
        })
    }

    private fun acceptPastedFiles(uris: List<android.net.Uri>) {
        val pastedContextId = contextId
        NativeUploadManager.acceptForComposer(activity.applicationContext, uris, "auto") { items ->
            activity.runOnUiThread {
                if (pastedContextId != contextId || !visible) {
                    for (index in 0 until items.length()) {
                        NativeUploadManager.discard(items.getJSONObject(index).getString("uploadId"))
                    }
                    return@runOnUiThread
                }
                emit(JSONObject().apply {
                    put("kind", "pasteFiles")
                    put("files", items)
                })
            }
        }
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
        val rowHost = row.parent as? View ?: return
        val params = rowHost.layoutParams as LinearLayout.LayoutParams
        if (params.width == target) return
        params.width = target
        params.gravity = Gravity.CENTER_HORIZONTAL
        rowHost.layoutParams = params
    }

    private fun applyTheme(dark: Boolean) {
        darkTheme = dark
        surface = if (dark) Color.rgb(37, 40, 43) else Color.WHITE
        outline = if (dark) Color.rgb(73, 78, 82) else Color.rgb(221, 225, 227)
        onSurface = if (dark) Color.rgb(239, 242, 244) else Color.rgb(38, 44, 47)
        secondary = if (dark) Color.rgb(181, 188, 192) else Color.rgb(84, 94, 99)
        hintColor = if (dark) Color.rgb(151, 158, 163) else Color.rgb(121, 130, 135)
        // Match the web --app-link role. Native URL spans are paint-only, so every URL uses the same
        // accessible color regardless of browser visit history.
        input.enableUrlColor(if (dark) LINK_DARK else LINK_LIGHT)
        input.setTextColor(onSurface)
        input.setHintTextColor(hintColor)
        inputSurface.background = outlinedSurface(12)
        attachmentDrawer.background = rounded(
            if (dark) Color.rgb(31, 34, 37) else Color.rgb(247, 248, 249),
            12,
        )
        updateAttachmentButtonState()
        updateKeyboardButtonState()
        attachmentIcons.forEach { it.setColorFilter(PRIMARY) }
        attachmentLabels.forEach { it.setTextColor(onSurface) }
        keyboard.setColorFilter(secondary)
        emojiGrid.background = rounded(surface, 14)
        recordingStatus.background = rounded(surface, 10)
        recordingClock.setTextColor(onSurface)
        quoteText.setTextColor(secondary)
        quoteClose.setTextColor(secondary)
        quoteBar.background = rounded(
            if (dark) Color.rgb(49, 53, 56) else Color.rgb(244, 246, 247),
            4,
        )
        if (!voiceCancelArmed) recordingHint.setTextColor(hintColor)
    }

    /** Quote context is deliberately outside MentionEditText: text deletion can never cancel it. */
    private fun setQuote(quote: JSONObject?) {
        val preview = quote?.optString("preview").orEmpty()
        quoteText.text = preview
        quoteBar.visibility = if (quote == null) View.GONE else View.VISIBLE
        root.requestLayout()
        root.post(::emitGeometry)
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

    private fun attachmentOption(icon: Int, label: String, action: () -> Unit) =
        LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(6), dp(3), dp(6), dp(3))
            isClickable = true
            isFocusable = true
            background = transparentRipple(10)
            contentDescription = label
            val image = ImageView(activity).apply {
                setImageResource(icon)
                setColorFilter(PRIMARY)
                setPadding(dp(5), dp(3), dp(5), dp(3))
                background = rounded(Color.TRANSPARENT, 16)
            }
            val text = TextView(activity).apply {
                this.text = label
                textSize = 11f
                gravity = Gravity.CENTER
                includeFontPadding = false
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
                setTextColor(onSurface)
            }
            attachmentIcons += image
            attachmentLabels += text
            addView(image, LinearLayout.LayoutParams(dp(32), dp(28)))
            addView(text, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(14),
            ))
            setOnClickListener { action() }
        }

    private fun updateAttachmentButtonState() {
        if (attachmentDrawerOpen) {
            val tonal = if (darkTheme) Color.rgb(42, 62, 88) else Color.rgb(222, 234, 251)
            attach.background = RippleDrawable(
                ColorStateList.valueOf(if (darkTheme) 0x33FFFFFF else 0x16000000),
                rounded(tonal, 18),
                rounded(Color.WHITE, 18),
            )
            attach.setColorFilter(PRIMARY)
            attach.elevation = dp(1).toFloat()
        } else {
            attach.background = surfaceRipple(18)
            attach.setColorFilter(secondary)
            attach.applySoftShadow(18, 2.5f)
        }
    }

    private fun updateKeyboardButtonState() {
        val active = keyboardSurface == KeyboardSurface.EMOJI ||
            keyboardSurface == KeyboardSurface.TO_SYSTEM
        if (active) {
            val tonal = if (darkTheme) Color.rgb(42, 62, 88) else Color.rgb(222, 234, 251)
            keyboard.background = RippleDrawable(
                ColorStateList.valueOf(if (darkTheme) 0x33FFFFFF else 0x16000000),
                rounded(tonal, 22),
                rounded(Color.WHITE, 22),
            )
            keyboard.setColorFilter(PRIMARY)
            keyboard.elevation = 0f
        } else {
            keyboard.background = transparentRipple(22)
            keyboard.setColorFilter(secondary)
            keyboard.elevation = dp(5).toFloat()
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
        private const val COMPOSER_MAX_LINES = 5
        private const val DEFAULT_EMOJI_HEIGHT_DP = 280
        private const val EMOJI_GAP_DP = 8
        private const val IME_HANDOFF_FALLBACK_MS = 420L
        private const val PRE_R_INSETS_COMMIT_DELAY_MS = 80L
        private const val SHOW_DURATION_MS = 140L
        private const val HIDE_DURATION_MS = 90L
        private const val LINK_MARKER_DEBOUNCE_MS = 500L
        private const val ATTACHMENT_DRAWER_DURATION_MS = 140L
        private val PRIMARY = Color.rgb(49, 119, 213)
        private val LINK_LIGHT = Color.rgb(21, 101, 192)
        private val LINK_DARK = Color.rgb(100, 181, 246)
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
