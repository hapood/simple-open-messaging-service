package com.soms.client

import android.content.Context
import android.content.Intent
import android.net.Uri

/** Immutable OS-notification destination. Reuses the message tap's session/origin contract. */
data class NotificationSessionBinding private constructor(val sessionId: Int, val origin: String) {
    fun isCurrent(currentSessionId: Int?, currentOrigin: String?): Boolean =
        sessionId == currentSessionId && origin == currentOrigin

    fun isCurrent(context: Context): Boolean = isCurrent(
        SomsSecureStore.getSessionId(context), SomsSecureStore.getApiOrigin(context),
    )

    fun attach(intent: Intent, operation: String, callSid: String) {
        intent.putExtra(SomsMessagingService.EXTRA_SESSION_ID, sessionId)
        intent.putExtra(SomsMessagingService.EXTRA_API_ORIGIN, origin)
        // Extras do not distinguish PendingIntent identity. Keep old-session buttons separate.
        intent.data = Uri.parse("soms-call://session/$sessionId/$operation/${Uri.encode(callSid)}?origin=${Uri.encode(origin)}")
    }

    companion object {
        fun fromValues(sessionId: Int?, origin: String?): NotificationSessionBinding? =
            if (sessionId == null || sessionId <= 0 || origin.isNullOrEmpty()) null
            else NotificationSessionBinding(sessionId, origin)

        fun capture(context: Context): NotificationSessionBinding? = fromValues(
            SomsSecureStore.getSessionId(context), SomsSecureStore.getApiOrigin(context),
        )

        fun fromIntent(intent: Intent?): NotificationSessionBinding? = if (intent == null) null else fromValues(
            intent.getIntExtra(SomsMessagingService.EXTRA_SESSION_ID, -1),
            intent.getStringExtra(SomsMessagingService.EXTRA_API_ORIGIN),
        )
    }
}
