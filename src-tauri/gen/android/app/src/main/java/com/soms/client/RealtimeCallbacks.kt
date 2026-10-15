package com.soms.client

import androidx.annotation.Keep

/** Commands from Rust to OS facilities. Every queued command carries its Rust worker generation.
 * The service's owner handle stays stable when Rust replaces an account/cache worker. */
@Keep
interface RealtimeCallbacks {
    fun onEvent(generation: Long, type: String, dataJson: String)
    fun onState(generation: Long, state: String)
    fun onReconnectIn(generation: Long, ms: Long)
    fun onForceLogout(generation: Long, reason: String?)
    fun onOriginActive(generation: Long, origin: String, mode: String)
    fun onIdentity(generation: Long, userId: Int, sessionId: Long)
    fun onNotifications(generation: Long, batch: NativeNotificationBatch)
    fun onIncomingCall(generation: Long, dataJson: String)
}
