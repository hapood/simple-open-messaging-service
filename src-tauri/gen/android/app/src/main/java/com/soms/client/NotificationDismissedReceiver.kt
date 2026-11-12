package com.soms.client

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** The OS has already removed the card; report the observation without issuing another removal. */
class NotificationDismissedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra("notificationId") ?: return
        val target = intent.getStringExtra(SomsMessagingService.EXTRA_TARGET) ?: return
        RustRuntimeBridge.notificationDismissed(target, id)
    }
}
