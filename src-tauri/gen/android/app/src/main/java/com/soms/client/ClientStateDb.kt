package com.soms.client

import android.content.Context
import android.util.Base64
import org.json.JSONObject

/** Synchronous background reads of the Rust-owned cache and device preferences.
 * Android's platform SQLite must not open the shared file: older system libraries cannot parse
 * the cache's generated columns and may treat the schema as corrupt and delete the entire file.
 */
object ClientStateDb {
    data class CallPeer(
        val name: String,
        val avatarMime: String?,
        val avatarBytes: ByteArray?,
    ) {
        fun avatarDataUrl(): String {
            val mime = avatarMime ?: return ""
            val bytes = avatarBytes ?: return ""
            return "data:$mime;base64,${Base64.encodeToString(bytes, Base64.NO_WRAP)}"
        }
    }

    private fun inlineAvatar(value: String?): Pair<String, ByteArray>? {
        if (value == null || !value.startsWith("data:image/")) return null
        val marker = value.indexOf(";base64,")
        if (marker < 5) return null
        return try { value.substring(5, marker) to Base64.decode(value.substring(marker + 8), Base64.DEFAULT) }
        catch (_: IllegalArgumentException) { null }
    }

    /** Resolve the exact profile selected by this P2P thread, without a synthetic user row. `namespaceId`
     *  is the peer's identity namespace (-1 = not supplied); it is a consistency check against the cached
     *  thread record, never an override. */
    fun getCallPeer(ctx: Context, account: String, namespaceId: Int, threadId: Int): CallPeer? {
        val ownerUserId = SomsSecureStore.getCurrentUserId(ctx) ?: return null
        return try {
            val json = RustRuntimeBridge.queryCallPeer(ownerUserId, threadId, account, namespaceId) ?: return null
            val peer = JSONObject(json)
            val avatar = inlineAvatar(peer.optString("avatarDataUrl"))
            CallPeer(peer.optString("name", account), avatar?.first, avatar?.second)
        } catch (e: Exception) {
            SomsLog.w("SomsCall") { "local call peer lookup failed: ${e.javaClass.simpleName}: ${e.message}" }
            null
        }
    }

    fun getNotificationPreviewMode(): String {
        val value = try { RustRuntimeBridge.getNotificationPreference("notificationPreviewMode") }
        catch (e: Exception) {
            SomsLog.w("SomsNotification") { "preview preference unavailable: ${e.javaClass.simpleName}" }
            null
        }
        return value?.takeIf { it == "message" || it == "private" } ?: "message"
    }

    fun setNotificationPreviewMode(mode: String) {
        RustRuntimeBridge.setNotificationPreference(
            "notificationPreviewMode", if (mode == "private") "private" else "message",
        )
    }

    fun getNotificationAlertPolicy(): String {
        val value = try { RustRuntimeBridge.getNotificationPreference("notificationAlertPolicy") }
        catch (e: Exception) {
            SomsLog.w("SomsNotification") { "alert preference unavailable: ${e.javaClass.simpleName}" }
            null
        }
        return value?.takeIf { it == "cooldown_2s" || it == "cooldown_5s" || it == "once_per_thread" }
            ?: "cooldown_5s"
    }

    fun setNotificationAlertPolicy(policy: String) {
        val value = policy.takeIf {
            it == "cooldown_2s" || it == "cooldown_5s" || it == "once_per_thread"
        } ?: "cooldown_5s"
        RustRuntimeBridge.setNotificationPreference("notificationAlertPolicy", value)
    }
}
