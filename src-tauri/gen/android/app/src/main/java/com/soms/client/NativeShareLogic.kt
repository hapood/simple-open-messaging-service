package com.soms.client

import android.content.Intent

internal object NativeShareLogic {
    fun normalizedText(action: String?, mimeType: String?, text: String?): String? {
        if (action != Intent.ACTION_SEND || mimeType != "text/plain") return null
        return text?.trim()?.takeIf(String::isNotEmpty)
    }
}
