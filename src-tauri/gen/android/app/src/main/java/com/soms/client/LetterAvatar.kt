package com.soms.client

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface

/**
 * Renders an initial-letter avatar bitmap — a rounded-square (rx 20%, matching the in-app avatar shape) with
 * a name-hashed hue background + a white bold initial. The fallback when a user/group has NO avatar image:
 * used by the call notification ([CallService.loadAvatar]) + the per-thread message notification, so the icon
 * shows the peer's letter avatar instead of the app logo.
 *
 * Mirrors the palette idea of the in-app `UserAvatarComponent` + the server's `AvatarStackService` letter
 * tile (hsl hue from a hash of the id, 65%/55%) — a deterministic color per identity, easy to distinguish.
 */
object LetterAvatar {
    /** px — large enough for the notification's Person icon / large icon (downscaled crisply). */
    private const val SIZE = 192

    /** Render a SIZE×SIZE rounded-square: a solid hue background (hash of [userId]) + a centered white bold
     *  initial from [name]. `ctx` reserved for future font/density work (unused now). */
    fun render(@Suppress("UNUSED_PARAMETER") ctx: Context, name: String, userId: Int): Bitmap {
        val bmp = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        val radius = SIZE * 0.20f
        val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = hueColor(userId) }
        canvas.drawRoundRect(RectF(0f, 0f, SIZE.toFloat(), SIZE.toFloat()), radius, radius, bg)
        val initial = name.firstOrNull()?.uppercaseChar()?.toString() ?: "?"
        val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textSize = SIZE * 0.5f
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
            textAlign = Paint.Align.CENTER
        }
        // Vertically center the glyph (the ascent/descent midpoint).
        val baseline = SIZE / 2f - (text.descent() + text.ascent()) / 2f
        canvas.drawText(initial, SIZE / 2f, baseline, text)
        return bmp
    }

    /** A deterministic color from [userId] (a stable hue per identity; mirrors AvatarStackService.hashHue). */
    private fun hueColor(userId: Int): Int {
        var h = 0
        val s = userId.toString()
        for (i in s.indices) h = h * 31 + s[i].code
        val hue = Math.floorMod(h, 360).toFloat()
        return Color.HSVToColor(floatArrayOf(hue, 0.65f, 0.85f))
    }
}
