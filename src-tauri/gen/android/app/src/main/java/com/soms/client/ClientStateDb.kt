package com.soms.client

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.util.Base64

/** WebView-independent notification state in the same local SQLite file used by the Tauri data layer. */
object ClientStateDb {

    private fun open(ctx: Context): SQLiteDatabase {
        val dbPath = RustRuntimeBridge.getDatabasePath()
        // Configure WAL through SQLiteDatabase so Android applies it consistently to every connection in
        // its pool. PRAGMA journal_mode returns a row and therefore must not be sent through execSQL().
        val db = SQLiteDatabase.openDatabase(
            dbPath,
            null,
            SQLiteDatabase.OPEN_READWRITE or
                SQLiteDatabase.CREATE_IF_NECESSARY or
                SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING,
        )
        db.execSQL(
            """CREATE TABLE IF NOT EXISTS client_preferences (
                scope TEXT NOT NULL,
                key TEXT NOT NULL,
                value_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (scope, key)
            )""".trimIndent(),
        )
        return db
    }

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
        if (value == null || !value.startsWith("data:")) return null
        val marker = value.indexOf(";base64,")
        if (marker < 5) return null
        return try { value.substring(5, marker) to Base64.decode(value.substring(marker + 8), Base64.DEFAULT) }
        catch (_: IllegalArgumentException) { null }
    }

    /** Resolve the exact profile selected by this P2P thread, without a synthetic user row. */
    fun getCallPeer(ctx: Context, account: String, domain: String, threadId: Int): CallPeer? {
        val ownerUserId = SomsSecureStore.getCurrentUserId(ctx) ?: return null
        return try {
            open(ctx).use { db ->
                db.rawQuery(
                    """SELECT COALESCE(json_extract(p.payload_json, '$.name'), json_extract(t.payload_json, '$.peerUser.name'), ?3),
                              a.mime, a.data, COALESCE(json_extract(p.payload_json, '$.avatar'), json_extract(t.payload_json, '$.peerUser.avatar'), '')
                         FROM threads t
                    LEFT JOIN profiles p ON p.user_id = t.user_id
                          AND p.account = json_extract(t.payload_json, '$.peerUser.account')
                          AND p.domain = json_extract(t.payload_json, '$.peerUser.domain')
                          AND p.namespace_id = json_extract(t.payload_json, '$.peerUser.namespaceId')
                          AND p.profile_rev = json_extract(t.payload_json, '$.peerUser.profileRev')
                    LEFT JOIN avatars a ON a.user_id = t.user_id
                          AND a.source_path = json_extract(p.payload_json, '$.avatar')
                        WHERE t.user_id = ?1 AND t.thread_id = ?2
                          AND json_extract(t.payload_json, '$.type') = 'P2P'
                          AND json_extract(t.payload_json, '$.peerUser.account') = ?3
                          AND json_extract(t.payload_json, '$.peerUser.domain') = ?4
                        LIMIT 1""".trimIndent(),
                    arrayOf(ownerUserId.toString(), threadId.toString(), account, domain),
                ).use { cursor ->
                    if (!cursor.moveToFirst()) null else {
                        val inline = inlineAvatar(cursor.getString(3))
                        CallPeer(
                        name = cursor.getString(0) ?: "",
                        avatarMime = inline?.first ?: if (cursor.isNull(1)) null else cursor.getString(1),
                        avatarBytes = inline?.second ?: if (cursor.isNull(2)) null else cursor.getBlob(2),
                        )
                    }
                }
            }
        } catch (e: Exception) {
            SomsLog.w("SomsCall") { "local call peer lookup failed: ${e.javaClass.simpleName}: ${e.message}" }
            null
        }
    }

    fun getNotificationPreviewMode(ctx: Context): String = open(ctx).use { db ->
        db.rawQuery(
            "SELECT value_json FROM client_preferences WHERE scope = 'device' AND key = 'notificationPreviewMode'",
            null,
        ).use { cursor ->
            if (!cursor.moveToFirst()) "message"
            else cursor.getString(0).trim('"').takeIf { it == "message" || it == "private" } ?: "message"
        }
    }

    fun setNotificationPreviewMode(ctx: Context, mode: String) = open(ctx).use { db ->
        val value = if (mode == "private") "private" else "message"
        db.execSQL(
            """INSERT INTO client_preferences(scope, key, value_json, updated_at)
               VALUES('device', 'notificationPreviewMode', ?, ?)
               ON CONFLICT(scope, key) DO UPDATE SET
                 value_json=excluded.value_json, updated_at=excluded.updated_at""",
            arrayOf("\"$value\"", System.currentTimeMillis()),
        )
    }

    fun getNotificationAlertPolicy(ctx: Context): String = open(ctx).use { db ->
        db.rawQuery(
            "SELECT value_json FROM client_preferences WHERE scope = 'device' AND key = 'notificationAlertPolicy'",
            null,
        ).use { cursor ->
            if (!cursor.moveToFirst()) "cooldown_5s"
            else cursor.getString(0).trim('"').takeIf {
                it == "cooldown_2s" || it == "cooldown_5s" || it == "once_per_thread"
            } ?: "cooldown_5s"
        }
    }

    fun setNotificationAlertPolicy(ctx: Context, policy: String) = open(ctx).use { db ->
        val value = policy.takeIf {
            it == "cooldown_2s" || it == "cooldown_5s" || it == "once_per_thread"
        } ?: "cooldown_5s"
        db.execSQL(
            """INSERT INTO client_preferences(scope, key, value_json, updated_at)
               VALUES('device', 'notificationAlertPolicy', ?, ?)
               ON CONFLICT(scope, key) DO UPDATE SET
                 value_json=excluded.value_json, updated_at=excluded.updated_at""",
            arrayOf("\"$value\"", System.currentTimeMillis()),
        )
    }
}
