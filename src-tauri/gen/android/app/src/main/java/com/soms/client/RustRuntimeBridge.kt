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

    fun getDatabasePath(): String = checkNotNull(databasePath) { "Rust runtime is not initialized" }

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
    fun setSessionToken(token: String?) {
        val normalized = token?.takeIf { it.isNotEmpty() }
        updateSessionToken(normalized)
    }

    @Synchronized
    fun withCurrentSession(expected: Long, action: () -> Unit) {
        if (isAccountEpochCurrent(expected)) action()
    }

    private external fun isAccountEpochCurrent(epoch: Long): Boolean

    private external fun updateSessionToken(token: String?)

    fun synchronizeNotifications(userId: Int, threadFeedEndId: Int): NativeNotificationBatch {
        check(Looper.myLooper() != Looper.getMainLooper()) { "Notification synchronization must run off the main thread" }
        checkNotNull(databasePath) { "Rust runtime is not initialized" }
        return queryNotifications(userId, threadFeedEndId)
    }

    private external fun queryNotifications(userId: Int, threadFeedEndId: Int): NativeNotificationBatch
    private external fun setOrigins(originsJson: String)
    private external fun initializeRuntime(dataDirectory: String, originsJson: String, token: String?): String
}
