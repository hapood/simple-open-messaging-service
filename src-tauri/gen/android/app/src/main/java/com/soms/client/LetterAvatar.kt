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
 * a name-hashed palette background + a white bold initial. The fallback when a user/group has NO avatar image:
 * used by the call notification ([CallService.loadAvatar]) + the per-thread message notification
 * ([SomsMessagingService.renderDescriptor]), so the icon shows the peer's letter avatar instead of the app logo.
 *
 * Mirrors the in-app `UserAvatarComponent` letter tile EXACTLY — the same 12-color Material palette, indexed
 * by the same name hash — so a notification's fallback tile is the same color the in-app avatar would render
 * for that name. `String.hashCode()` is bit-identical to the web's `Math.imul(h,31)+char | 0` recurrence, so
 * `abs(name.hashCode().toLong()) % 12` matches `Math.abs(hashName(name)) % 12` (the .toLong() mirrors JS
 * `Math.abs` holding 2^31, which Kotlin Int can't). See [paletteColor].
 */
object LetterAvatar {
    /** px — large enough for the notification's Person icon / large icon (downscaled crisply). */
    private const val SIZE = 192

    /** The in-app `UserAvatarComponent` PALETTE — copied verbatim (user-avatar.component.ts). A letter tile
     *  MUST land on the SAME color the in-app avatar would for a given name, so the notification fallback is
     *  indistinguishable from the in-app avatar. Material dark shades (WCAG AA against the white initial). */
    private val PALETTE = intArrayOf(
        0xFFE53935.toInt(), 0xFFD81B60.toInt(), 0xFF8E24AA.toInt(), 0xFF5E35B1.toInt(),
        0xFF3949AB.toInt(), 0xFF1E88E5.toInt(), 0xFF039BE5.toInt(), 0xFF00ACC1.toInt(),
        0xFF00897B.toInt(), 0xFF43A043.toInt(), 0xFF6D4C41.toInt(), 0xFF546E7A.toInt(),
    )

    /** Render a SIZE×SIZE rounded-square: a solid palette background (hash of [name]) + a centered white bold
     *  initial from [name]. `ctx` reserved for future font/density work (unused now). */
    fun render(@Suppress("UNUSED_PARAMETER") ctx: Context, name: String): Bitmap {
        // Mirror UserAvatarComponent.hashName: trim, then '?' on empty — so the color + the initial both key
        // off the same trimmed name the in-app avatar uses.
        val key = name.trim().ifEmpty { "?" }
        val bmp = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        val radius = SIZE * 0.20f
        val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = paletteColor(key) }
        canvas.drawRoundRect(RectF(0f, 0f, SIZE.toFloat(), SIZE.toFloat()), radius, radius, bg)
        val initial = key.firstOrNull()?.uppercaseChar()?.toString() ?: "?"
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

    /** The palette slot for [key] — mirrors `UserAvatarComponent.bg`: `PALETTE[hashName(key) % 12]`, where the
     *  web's hashName is `(Math.imul(h,31) + charCode) | 0` then `Math.abs`. Kotlin `String.hashCode()` is the
     *  SAME recurrence (`h = 31*h + char`, 32-bit signed wrap), so this matches the web index exactly. */
    private fun paletteColor(key: String): Int {
        val idx = (kotlin.math.abs(key.hashCode().toLong()) % PALETTE.size.toLong()).toInt()
        return PALETTE[idx]
    }
}
