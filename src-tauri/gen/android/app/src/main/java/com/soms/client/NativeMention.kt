package com.soms.client

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.text.Editable
import android.text.Spanned
import android.text.TextWatcher
import android.text.style.ForegroundColorSpan
import android.text.style.ReplacementSpan
import android.util.AttributeSet
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import androidx.appcompat.widget.AppCompatEditText

internal data class MentionQuery(val start: Int, val query: String)

internal data class MentionRange(
    val start: Int,
    val end: Int,
    val kind: String,
    val id: String,
    val label: String,
)

/** Paint-only URL marker. It deliberately carries neither a URL payload nor click behavior. */
internal class NativeUrlSpan(color: Int) : ForegroundColorSpan(color)

internal data class NativeUrlMarker(val href: String, val start: Int, val end: Int)

internal object NativeUrlLogic {
    private val scheme = Regex("https?://", RegexOption.IGNORE_CASE)

    fun firstScheme(text: CharSequence, from: Int, to: Int): Int? {
        if (from >= to) return null
        return scheme.find(text.subSequence(from, to))?.range?.first?.plus(from)
    }
}

/** Deterministic local fallback: the same account gets the same palette entry on every render. */
internal class InitialsAvatarDrawable(
    private val initials: String,
    seed: String,
    dark: Boolean,
) : Drawable() {
    private val palette = if (dark) {
        intArrayOf(
            Color.rgb(55, 99, 138),
            Color.rgb(92, 72, 138),
            Color.rgb(54, 116, 101),
            Color.rgb(139, 79, 91),
            Color.rgb(126, 91, 47),
        )
    } else {
        intArrayOf(
            Color.rgb(214, 235, 252),
            Color.rgb(232, 221, 252),
            Color.rgb(211, 239, 230),
            Color.rgb(251, 222, 227),
            Color.rgb(246, 231, 204),
        )
    }
    private val background = palette[(seed.hashCode() and Int.MAX_VALUE) % palette.size]
    private val foreground = if (dark) Color.WHITE else Color.rgb(42, 55, 63)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    override fun draw(canvas: Canvas) {
        val radius = minOf(bounds.width(), bounds.height()) / 2f
        paint.color = background
        canvas.drawCircle(bounds.exactCenterX(), bounds.exactCenterY(), radius, paint)
        paint.color = foreground
        paint.textAlign = Paint.Align.CENTER
        paint.textSize = radius * 0.9f
        paint.typeface = android.graphics.Typeface.DEFAULT_BOLD
        val baseline = bounds.exactCenterY() - (paint.ascent() + paint.descent()) / 2f
        canvas.drawText(initials.ifBlank { "?" }.take(2), bounds.exactCenterX(), baseline, paint)
    }

    override fun setAlpha(alpha: Int) {
        paint.alpha = alpha
    }

    override fun setColorFilter(colorFilter: android.graphics.ColorFilter?) {
        paint.colorFilter = colorFilter
    }

    @Deprecated("Deprecated in Java")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}

internal object NativeMentionLogic {
    fun query(text: CharSequence, cursor: Int): MentionQuery? {
        if (cursor !in 0..text.length) return null
        var at = cursor - 1
        while (at >= 0 && !text[at].isWhitespace()) {
            if (text[at] == '@') {
                if (at > 0 && !text[at - 1].isWhitespace()) return null
                return MentionQuery(at, text.subSequence(at + 1, cursor).toString())
            }
            at--
        }
        return null
    }

    fun validRanges(text: String, ranges: List<MentionRange>): List<MentionRange> =
        ranges.sortedBy { it.start }.fold(mutableListOf()) { accepted, range ->
            val cursor = accepted.lastOrNull()?.end ?: 0
            if (
                range.start >= cursor &&
                range.end in (range.start + 1)..text.length &&
                text.substring(range.start, range.end) == "@${range.label}"
            ) {
                accepted += range
            }
            accepted
        }
}

internal class MentionSpan(
    val kind: String,
    val id: String,
    val label: String,
    private val foreground: Int,
    private val background: Int,
    private val horizontalPadding: Int,
    private val cornerRadius: Float,
) : ReplacementSpan() {
    private fun display() = "@$label"

    override fun getSize(
        paint: Paint,
        text: CharSequence?,
        start: Int,
        end: Int,
        fm: Paint.FontMetricsInt?,
    ): Int = (paint.measureText(display()) + horizontalPadding * 2).toInt()

    override fun draw(
        canvas: Canvas,
        text: CharSequence?,
        start: Int,
        end: Int,
        x: Float,
        top: Int,
        y: Int,
        bottom: Int,
        paint: Paint,
    ) {
        val oldColor = paint.color
        val width = paint.measureText(display()) + horizontalPadding * 2
        paint.color = background
        canvas.drawRoundRect(
            x,
            top.toFloat(),
            x + width,
            bottom.toFloat(),
            cornerRadius,
            cornerRadius,
            paint,
        )
        paint.color = foreground
        canvas.drawText(display(), x + horizontalPadding, y.toFloat(), paint)
        paint.color = oldColor
    }
}

/**
 * EditText with atom-like MentionSpan behavior. IME backspace and hardware backspace both delete a whole
 * mention; selection endpoints are snapped outside a mention so composing text cannot split its identity.
 */
internal class MentionEditText @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : AppCompatEditText(context, attrs) {
    var onUrlMarkersChanged: (() -> Unit)? = null
    private var correctingSelection = false
    private var urlColor: Int? = null
    private var changeStart = 0
    private var changeBefore = 0
    private var changeCount = 0
    private var pendingFrom = Int.MAX_VALUE
    private var pendingTo = -1
    private var pendingBulk = false

    init {
        addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {
                changeStart = start
                changeBefore = count
                changeCount = after
            }

            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                changeStart = start
                changeBefore = before
                changeCount = count
            }

            override fun afterTextChanged(editable: Editable?) {
                val value = editable ?: return
                val color = urlColor ?: return
                if (BaseInputConnection.getComposingSpanStart(value) >= 0) {
                    accumulatePending(value)
                } else {
                    refreshCommittedChange(value, color)
                }
            }
        })
    }

    fun enableUrlColor(color: Int) {
        urlColor = color
        text?.let {
            rebuildUrlSpans(it, 0, it.length, color)
            onUrlMarkersChanged?.invoke()
        }
    }

    /** Read the paint-only spans already maintained by the editor; no URL recognition is rerun here. */
    fun urlMarkers(): List<NativeUrlMarker> {
        val editable = text ?: return emptyList()
        return editable.getSpans(0, editable.length, NativeUrlSpan::class.java)
            .mapNotNull { span ->
                val start = editable.getSpanStart(span)
                val end = editable.getSpanEnd(span)
                if (start < 0 || end <= start) null
                else NativeUrlMarker(editable.subSequence(start, end).toString(), start, end)
            }
            .sortedBy { it.start }
    }

    private fun accumulatePending(editable: Editable) {
        val composingStart = BaseInputConnection.getComposingSpanStart(editable).coerceAtLeast(0)
        val composingEnd = BaseInputConnection.getComposingSpanEnd(editable).coerceAtLeast(composingStart)
        pendingFrom = minOf(pendingFrom, changeStart, composingStart)
        pendingTo = maxOf(pendingTo, changeStart + changeCount, composingEnd)
        pendingBulk = pendingBulk || changeCount > 1 || changeBefore > 1
    }

    private fun refreshCommittedChange(editable: Editable, color: Int) {
        val hasPending = pendingFrom != Int.MAX_VALUE
        val from = if (hasPending) minOf(pendingFrom, changeStart) else changeStart
        val to = if (hasPending) maxOf(pendingTo, changeStart + changeCount) else changeStart + changeCount
        val bulk = pendingBulk || changeCount > 1 || changeBefore > 1
        clearPending()
        refreshAffected(editable, from, to, bulk, color)
    }

    private fun clearPending() {
        pendingFrom = Int.MAX_VALUE
        pendingTo = -1
        pendingBulk = false
    }

    private fun isMentionBoundary(editable: Editable, offset: Int): Boolean =
        editable.getSpans(offset, (offset + 1).coerceAtMost(editable.length), MentionSpan::class.java)
            .any { offset in editable.getSpanStart(it) until editable.getSpanEnd(it) }

    private fun isBoundary(editable: Editable, offset: Int): Boolean =
        offset !in 0 until editable.length || editable[offset].isWhitespace() || isMentionBoundary(editable, offset)

    private fun refreshAffected(editable: Editable, rawFrom: Int, rawTo: Int, bulk: Boolean, color: Int) {
        var from = rawFrom.coerceIn(0, editable.length)
        var to = rawTo.coerceIn(from, editable.length)

        // A one-character commit can only complete an eight-character scheme within seven characters
        // on either side. Batch commits (paste, voice input, IME phrase confirmation) scan the whole batch.
        if (!bulk) {
            from = (from - 7).coerceAtLeast(0)
            to = (to + 7).coerceAtMost(editable.length)
        }

        editable.getSpans((from - 1).coerceAtLeast(0), (to + 1).coerceAtMost(editable.length), NativeUrlSpan::class.java)
            .forEach { span ->
                from = minOf(from, editable.getSpanStart(span).coerceAtLeast(0))
                to = maxOf(to, editable.getSpanEnd(span).coerceAtMost(editable.length))
            }

        while (from > 0 && !isBoundary(editable, from - 1)) from--
        while (to < editable.length && !isBoundary(editable, to)) to++
        rebuildUrlSpans(editable, from, to, color)
        onUrlMarkersChanged?.invoke()
    }

    private fun rebuildUrlSpans(editable: Editable, from: Int, to: Int, color: Int) {
        editable.getSpans(from, to, NativeUrlSpan::class.java).forEach(editable::removeSpan)
        var cursor = from
        while (cursor < to) {
            while (cursor < to && isBoundary(editable, cursor)) cursor++
            val runStart = cursor
            while (cursor < to && !isBoundary(editable, cursor)) cursor++
            val runEnd = cursor
            val schemeStart = NativeUrlLogic.firstScheme(editable, runStart, runEnd) ?: continue
            editable.setSpan(
                NativeUrlSpan(color),
                schemeStart,
                runEnd,
                Spanned.SPAN_EXCLUSIVE_INCLUSIVE,
            )
        }
    }

    fun insertMention(
        queryStart: Int,
        kind: String,
        id: String,
        label: String,
        foreground: Int,
        background: Int,
        horizontalPadding: Int,
        cornerRadius: Float,
    ) {
        val editable = text ?: return
        val cursor = selectionStart.coerceAtLeast(queryStart)
        editable.replace(queryStart, cursor, "@$label ")
        editable.setSpan(
            MentionSpan(
                kind,
                id,
                label,
                foreground,
                background,
                horizontalPadding,
                cornerRadius,
            ),
            queryStart,
            queryStart + label.length + 1,
            Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
        )
        urlColor?.let { color ->
            // setSpan itself does not trigger TextWatcher. Rebuild now so a confirmed mention immediately
            // becomes a hard URL boundary, equivalent to whitespace.
            refreshAffected(editable, queryStart, queryStart + label.length + 1, true, color)
        }
        setSelection(queryStart + label.length + 2)
    }

    fun mentionRanges(): List<MentionRange> {
        val editable = text ?: return emptyList()
        return editable.getSpans(0, editable.length, MentionSpan::class.java)
            .map {
                MentionRange(
                    editable.getSpanStart(it),
                    editable.getSpanEnd(it),
                    it.kind,
                    it.id,
                    it.label,
                )
            }
            .filter { it.start >= 0 && it.end > it.start }
            .sortedBy { it.start }
    }

    override fun onSelectionChanged(selStart: Int, selEnd: Int) {
        super.onSelectionChanged(selStart, selEnd)
        if (correctingSelection || selStart < 0 || selEnd < 0) return
        val editable = text ?: return
        val spans = editable.getSpans(
            (selStart - 1).coerceAtLeast(0),
            (selEnd + 1).coerceAtMost(editable.length),
            MentionSpan::class.java,
        )
        val containing = spans.firstOrNull {
            val start = editable.getSpanStart(it)
            val end = editable.getSpanEnd(it)
            selStart in (start + 1) until end || selEnd in (start + 1) until end
        } ?: return
        correctingSelection = true
        val start = editable.getSpanStart(containing)
        val end = editable.getSpanEnd(containing)
        val target = if (selStart - start < end - selStart) start else end
        setSelection(target)
        correctingSelection = false
    }

    override fun onCreateInputConnection(outAttrs: android.view.inputmethod.EditorInfo): InputConnection? {
        val target = super.onCreateInputConnection(outAttrs) ?: return null
        return object : InputConnectionWrapper(target, true) {
            override fun finishComposingText(): Boolean {
                val handled = super.finishComposingText()
                post {
                    val editable = text ?: return@post
                    if (BaseInputConnection.getComposingSpanStart(editable) >= 0) return@post
                    val color = urlColor ?: return@post
                    if (pendingFrom != Int.MAX_VALUE) refreshCommittedChange(editable, color)
                }
                return handled
            }

            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                if (beforeLength == 1 && afterLength == 0 && deleteMentionBeforeCursor()) return true
                return super.deleteSurroundingText(beforeLength, afterLength)
            }

            override fun deleteSurroundingTextInCodePoints(
                beforeLength: Int,
                afterLength: Int,
            ): Boolean {
                if (beforeLength == 1 && afterLength == 0 && deleteMentionBeforeCursor()) return true
                return super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
            }
        }
    }

    fun deleteMentionBeforeCursor(): Boolean {
        if (selectionStart != selectionEnd || selectionStart <= 0) return false
        val editable: Editable = text ?: return false
        val cursor = selectionStart
        val span = editable.getSpans(cursor - 1, cursor, MentionSpan::class.java)
            .firstOrNull { editable.getSpanEnd(it) == cursor } ?: return false
        editable.delete(editable.getSpanStart(span), editable.getSpanEnd(span))
        return true
    }
}
