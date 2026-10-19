package com.soms.client

import android.content.Context
import androidx.annotation.Keep
import org.json.JSONObject
import android.os.Looper

/** Process resources available before an Activity, Tauri AppHandle, or WebView exists. */
@Keep
object RustRuntimeBridge {
    init {
        System.loadLibrary("soms_client_lib")
    }

    @Volatile
    private var databasePath: String? = null

    @Synchronized
    fun initialize(ctx: Context) {
        check(databasePath == null) { "Rust runtime is already initialized" }
        databasePath = initializeRuntime(
            ctx.applicationContext.dataDir.absolutePath,
            origins(ctx),
            SomsSecureStore.getSessionToken(ctx),
        )
    }

    // The account cache uses Rust's bundled SQLite. Android's platform SQLite can be too old
    // to parse its schema, so background Kotlin components must never open that file directly.
    external fun getNotificationPreference(key: String): String?
    external fun setNotificationPreference(key: String, value: String)
    external fun queryCallPeer(userId: Int, threadId: Int, account: String, namespaceId: Int): String?

    private fun origins(ctx: Context): String = JSONObject().apply {
        put("primary", SomsSecureStore.getApiOrigin(ctx) ?: JSONObject.NULL)
        put("secondary", SomsSecureStore.getApiOriginSecondary(ctx) ?: JSONObject.NULL)
        put("mode", SomsSecureStore.getOriginMode(ctx))
    }.toString()

    fun updateOrigins(ctx: Context) {
        checkNotNull(databasePath) { "Rust runtime is not initialized" }
        setOrigins(origins(ctx))
    }

    @Synchronized
    fun setSessionToken(token: String?, sessionUuid: String) {
        require(sessionUuid.isNotBlank()) { "sessionUuid must not be blank" }
        val normalizedToken = token?.takeIf { it.isNotEmpty() }
        updateSessionToken(normalizedToken, sessionUuid)
    }

    @Synchronized
    fun discardResidualToken() {
        clearResidualToken()
    }

    @Synchronized
    fun withCurrentSession(expected: String, action: () -> Unit) {
        if (isLoginSessionCurrent(expected)) action()
    }

    external fun isLoginSessionCurrent(sessionUuid: String): Boolean

    // Instance leases fence commands from destroyed Android adapters. Rust owns the connection,
    // cancellation, origin selection and all synchronization/projection work.
    external fun realtimeStart(callbacks: RealtimeCallbacks): Long
    external fun realtimeIsCurrent(generation: Long): Boolean
    external fun realtimeStop(instance: Long)
    external fun realtimeNet(instance: Long, online: Boolean)
    external fun realtimeRetryNow(instance: Long): Long
    external fun realtimeForceReconnect(instance: Long): Long
    external fun realtimeGetState(): String
    external fun realtimeReplayHello(): String?
    external fun realtimePickOrigin(): String?

    private external fun updateSessionToken(token: String?, sessionUuid: String)
    private external fun clearResidualToken()

    fun synchronizeNotifications(userId: Int, threadFeedEndId: Int): NativeNotificationBatch {
        check(Looper.myLooper() != Looper.getMainLooper()) { "Notification synchronization must run off the main thread" }
        checkNotNull(databasePath) { "Rust runtime is not initialized" }
        return queryNotifications(userId, threadFeedEndId)
    }

    fun synchronizeStateFeed(userId: Int, stateFeedEndId: Long): JSONObject {
        check(Looper.myLooper() != Looper.getMainLooper()) { "State-feed synchronization must run off the main thread" }
        checkNotNull(databasePath) { "Rust runtime is not initialized" }
        return JSONObject(syncStateFeed(userId, stateFeedEndId))
    }

    private external fun syncStateFeed(userId: Int, target: Long): String
    private external fun queryNotifications(userId: Int, threadFeedEndId: Int): NativeNotificationBatch
    private external fun setOrigins(originsJson: String)
    private external fun initializeRuntime(dataDirectory: String, originsJson: String, token: String?): String
}
