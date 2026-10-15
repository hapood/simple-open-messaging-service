package com.soms.client

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Native call notification and picture-in-picture controls. */
class SomsActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val binding = NotificationSessionBinding.fromIntent(intent) ?: return
        if (!binding.isCurrent(context)) return
        intent.getStringExtra(EXTRA_CALL_DECLINE)?.let { sid ->
            if (sid != CallController.callSid) return
            CallController.decline(sid)
            return
        }
        intent.getStringExtra(EXTRA_CALL_END)?.let { sid ->
            if (sid.isNotEmpty() && sid == CallController.callSid) CallController.end(sid, "completed")
            return
        }
        if (intent.getBooleanExtra(EXTRA_CALL_TOGGLE_MUTE, false) &&
            intent.getStringExtra(CallService.EXTRA_SID) == CallController.callSid) {
            CallController.setMuted(!CallController.muted)
        }
    }

    companion object {
        const val EXTRA_CALL_DECLINE = "soms_call_decline"
        const val EXTRA_CALL_END = "soms_call_end"
        const val EXTRA_CALL_TOGGLE_MUTE = "soms_call_toggle_mute"
    }
}
