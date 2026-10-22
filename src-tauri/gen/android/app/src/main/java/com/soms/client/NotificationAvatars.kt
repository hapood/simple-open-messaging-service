package com.soms.client

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Shader
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.toBitmap
import kotlin.math.max

/** Decode each sender once. Missing cache bytes use the transparent logo without the adaptive launcher background. */
object NotificationAvatars {
    private const val SIZE = 64
    private const val CORNER_RADIUS = 12f

    fun resolve(ctx: Context, messages: List<NotifMessage>): Map<String, Bitmap> {
        val fallback by lazy { ContextCompat.getDrawable(ctx, R.mipmap.ic_launcher_foreground)!!.toBitmap(SIZE, SIZE) }
        return messages.distinctBy { it.senderKey }.associate { message ->
            val image = message.avatar?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
            message.senderKey to (image?.let(::roundedSquare) ?: fallback)
        }
    }

    /** Keep the sender photo centered and give every OEM the same transparent rounded-square silhouette. */
    private fun roundedSquare(source: Bitmap): Bitmap {
        val result = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888)
        val scale = max(SIZE.toFloat() / source.width, SIZE.toFloat() / source.height)
        val matrix = Matrix().apply {
            setScale(scale, scale)
            postTranslate((SIZE - source.width * scale) / 2f, (SIZE - source.height * scale) / 2f)
        }
        val shader = BitmapShader(source, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).apply {
            setLocalMatrix(matrix)
        }
        Canvas(result).drawRoundRect(
            0f, 0f, SIZE.toFloat(), SIZE.toFloat(), CORNER_RADIUS, CORNER_RADIUS,
            Paint(Paint.ANTI_ALIAS_FLAG).apply { this.shader = shader },
        )
        return result
    }
}
