package com.soms.client

import android.content.Intent
import org.json.JSONObject

/** Decode OS extras without admitting notification navigation; Rust validates the resulting payload. */
internal fun Intent.notificationOpeningPayload(): String? {
    val thread = getStringExtra(SomsMessagingService.EXTRA_TARGET) ?: return null
    val target = runCatching { JSONObject(thread) }.getOrNull() ?: return null
    val opening = JSONObject().put("target", target)
    // Preserve absence. The sender stores an Int; a present null or wrong-typed value must not
    // become zero (a valid ceiling). Forward -1 in that case so Rust rejects the opening.
    extras
        ?.takeIf { it.containsKey(SomsMessagingService.EXTRA_LATEST_SEQ) }
        ?.let { opening.put("latestSeq", it.getInt(SomsMessagingService.EXTRA_LATEST_SEQ, -1)) }
    return opening.toString()
}
