package com.soms.client

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Native call notification and picture-in-picture controls. */
class SomsActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        intent.getStringExtra(EXTRA_CALL_DECLINE)?.let { sid ->
            CallController.decline(sid)
            return
        }
        intent.getStringExtra(EXTRA_CALL_END)?.let { sid ->
            if (sid.isNotEmpty()) CallController.end(sid, "completed")
            return
        }
        if (intent.getBooleanExtra(EXTRA_CALL_TOGGLE_MUTE, false)) {
            CallController.setMuted(!CallController.muted)
        }
    }

    companion object {
        const val EXTRA_CALL_DECLINE = "soms_call_decline"
        const val EXTRA_CALL_END = "soms_call_end"
        const val EXTRA_CALL_TOGGLE_MUTE = "soms_call_toggle_mute"
    }
}
