package com.soms.client

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.toBitmap

/** Decode each sender once. Missing cache bytes use the app icon, never a network request. */
object NotificationAvatars {
    fun resolve(ctx: Context, messages: List<NotifMessage>): Map<String, Bitmap> {
        val fallback by lazy { ContextCompat.getDrawable(ctx, R.mipmap.ic_launcher)!!.toBitmap(64, 64) }
        return messages.distinctBy { it.senderKey }.associate { message ->
            message.senderKey to (message.avatar?.let { BitmapFactory.decodeByteArray(it, 0, it.size) } ?: fallback)
        }
    }

}
