package com.soms.client

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.annotation.Keep
import org.json.JSONObject

/** Android lifecycle/presentation adapter for Rust's shared realtime runtime.
 * No sockets, origin probes, retries, feed work, or HELLO cache are owned here. */
@Keep
class RealtimeService : Service(), RealtimeCallbacks {
    private val handler = Handler(Looper.getMainLooper())
    private val adapter = NativeRealtimeAdapter(object : NativeRealtimeRuntime {
        override fun start() = RustRuntimeBridge.realtimeStart(this@RealtimeService)
        override fun stop(instance: Long) = RustRuntimeBridge.realtimeStop(instance)
        override fun network(instance: Long, online: Boolean) = RustRuntimeBridge.realtimeNet(instance, online)
        override fun retry(instance: Long) = RustRuntimeBridge.realtimeRetryNow(instance)
        override fun reconnect(instance: Long) = RustRuntimeBridge.realtimeForceReconnect(instance)
    })
    private var connectivityManager: ConnectivityManager? = null
    private var callbackRegistered = false
    @Volatile private var networkOnline = true

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onLost(network: Network) {
            networkOnline = false
            adapter.network(false)
        }
        override fun onAvailable(network: Network) {
            networkOnline = true
            adapter.network(true)
        }
    }

    override fun onCreate() {
        super.onCreate()
        connectivityManager = getSystemService(ConnectivityManager::class.java)
        networkOnline = connectivityManager?.activeNetwork != null
        connectivityManager?.registerDefaultNetworkCallback(networkCallback)
        callbackRegistered = connectivityManager != null
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!adapter.isAlive || SomsSecureStore.getSessionToken(this) == null) {
            stopSelfResult(startId)
            return START_NOT_STICKY
        }
        val action = intent?.action
        val enabled = SomsSecureStore.getForegroundServiceEnabled(this)
        if (action != ACTION_FOREGROUND && action != ACTION_RETRY && action != ACTION_FORCE_RECONNECT && !enabled) {
            stopSelfResult(startId)
            return START_NOT_STICKY
        }
        if (enabled) {
            if (!promoteOrStop(startId)) return START_NOT_STICKY
        } else dropForegroundNotification()
        adapter.start()
        adapter.network(networkOnline)
        when (action) {
            ACTION_RETRY -> adapter.retry()
            ACTION_FORCE_RECONNECT -> adapter.reconnect()
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun promoteOrStop(startId: Int): Boolean = try {
        val notification = SomsMessagingService.buildForegroundNotification(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(SomsMessagingService.FGS_PERSISTENT_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else startForeground(SomsMessagingService.FGS_PERSISTENT_ID, notification)
        true
    } catch (error: RuntimeException) {
        Log.w("SomsRealtimeAdapter", "dataSync foreground promotion rejected", error)
        adapter.destroy()
        stopSelfResult(startId)
        false
    }

    private fun dropForegroundNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
        else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    /** JNI may deliver on any Rust worker. Fence the queued main-thread operation too, not just ingress.
     * Capture the OS-store token under its mutation lock so Rust's token update and native persistence
     * cannot split this snapshot. The credential remains in native memory and is never logged. */
    private fun dispatch(generation: Long, action: () -> Unit) {
        if (!adapter.isAlive) return
        val token = synchronized(SomsSecureStore) { SomsSecureStore.getSessionToken(this) }
        handler.post {
            if (!adapter.isAlive || !RustRuntimeBridge.realtimeIsCurrent(generation) || token != SomsSecureStore.getSessionToken(this)) return@post
            try {
                action()
            } catch (error: Exception) {
                // JNI can only catch synchronous callback errors; a queued platform action must also
                // fail safely. Never include event bodies or credential-bearing exception text.
                Log.w("SomsRealtimeAdapter", "platform command failed: ${error.javaClass.simpleName}")
            }
        }
    }

    override fun onEvent(generation: Long, type: String, dataJson: String) = dispatch(generation) {
        // Routing to a platform media owner is adapter work; the transport frame remains opaque.
        if (type == "CALL_SIGNAL" || type == "CALL_EVENT") CallController.onFrame(type, dataJson)
        if (SomsMessagingService.appInForeground)
            SomsBridge.eval("window.__SOMS_EVENT__ && window.__SOMS_EVENT__(${SomsBridge.jsonStr(type)}, $dataJson);")
    }

    override fun onState(generation: Long, state: String) = dispatch(generation) {
        SomsBridge.eval("window.__SOMS_CONN_STATE__ && window.__SOMS_CONN_STATE__(${SomsBridge.jsonStr(state)});")
    }

    override fun onReconnectIn(generation: Long, ms: Long) = dispatch(generation) {
        SomsBridge.eval("window.__SOMS_RECONNECT_IN__ && window.__SOMS_RECONNECT_IN__($ms);")
    }

    override fun onForceLogout(generation: Long, reason: String?) = dispatch(generation) {
        SomsSecureStore.setSessionToken(this, null)
        val payload = JSONObject().put("message", reason ?: JSONObject.NULL)
        SomsBridge.eval("window.__SOMS_EVENT__ && window.__SOMS_EVENT__('FORCE_LOGOUT', $payload);")
        adapter.destroy()
        stopSelf()
    }

    override fun onOriginActive(generation: Long, origin: String, mode: String) = dispatch(generation) {
        SomsSecureStore.recordActiveOriginMode(this, mode)
    }

    override fun onIdentity(generation: Long, userId: Int, sessionId: Long) = dispatch(generation) {
        if (sessionId in 1..Int.MAX_VALUE.toLong())
            SomsSecureStore.setHelloIdentity(this, SomsSecureStore.getSessionToken(this), sessionId.toInt(), userId)
    }

    override fun onNotifications(generation: Long, batch: NativeNotificationBatch) = dispatch(generation) {
        SomsMessagingService.renderNativeBatch(this, batch) {
            adapter.isAlive && RustRuntimeBridge.realtimeIsCurrent(generation) && RustRuntimeBridge.isAccountEpochCurrent(batch.accountEpoch)
        }
    }

    /** Execute Rust's explicit recovery command; do not re-derive ringing/caller policy from HELLO. */
    override fun onIncomingCall(generation: Long, dataJson: String) = dispatch(generation) {
        val command = JSONObject(dataJson)
        val sid = command.getString("callSid")
        val peerId = command.getInt("peerUserId")
        val threadId = command.getInt("threadId")
        val account = command.getString("peerAccount")
        val namespaceId = command.optInt("peerNamespaceId", -1)
        val callType = command.optString("callType", "AUDIO")
        // The shared native resolver owns presentation (alias → cached profile → cached thread name →
        // account); the HELLO payload's name/avatar are only the fallback without a local record.
        val peer = ClientStateDb.getCallPeer(this, account, namespaceId, threadId)
        val name = peer?.name ?: command.optString("peerName", account)
        val avatar = peer?.avatarDataUrl()
            ?: if (command.isNull("peerAvatar")) "" else command.optString("peerAvatar", "")
        CallController.seedIncoming(sid, peerId, account, namespaceId, name, avatar, threadId, callType)
        CallService.startIncoming(this, sid, account, namespaceId, threadId, callType, name, avatar)
    }

    override fun onTimeout(startId: Int) {
        adapter.destroy()
        stopSelf()
    }

    override fun onDestroy() {
        // OS unregistration does not retract callbacks already queued on ConnectivityThread.
        adapter.destroy()
        if (callbackRegistered) connectivityManager?.unregisterNetworkCallback(networkCallback)
        callbackRegistered = false
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    companion object {
        const val ACTION_FOREGROUND = "com.soms.client.action.FOREGROUND"
        const val ACTION_RETRY = "com.soms.client.action.RETRY"
        const val ACTION_FORCE_RECONNECT = "com.soms.client.action.FORCE_RECONNECT"
    }
}
