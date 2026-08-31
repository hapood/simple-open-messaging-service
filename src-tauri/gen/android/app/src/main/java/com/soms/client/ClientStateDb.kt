package com.soms.client

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.util.Base64
import java.io.File

/** WebView-independent notification state in the same local SQLite file used by the Tauri data layer. */
object ClientStateDb {
    private const val ACTIVE_ACCOUNT = 0

    private fun open(ctx: Context): SQLiteDatabase {
        val dbFile = File(ctx.filesDir, "soms-local.sqlite3")
        // Configure WAL through SQLiteDatabase so Android applies it consistently to every connection in
        // its pool. PRAGMA journal_mode returns a row and therefore must not be sent through execSQL().
        val db = SQLiteDatabase.openDatabase(
            dbFile.absolutePath,
            null,
            SQLiteDatabase.OPEN_READWRITE or
                SQLiteDatabase.CREATE_IF_NECESSARY or
                SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING,
        )
        db.execSQL(
            """CREATE TABLE IF NOT EXISTS notification_feed_state (
                account_id INTEGER PRIMARY KEY,
                feed_id INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )""".trimIndent(),
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
        db.execSQL(
            """CREATE TABLE IF NOT EXISTS notification_thread_state (
                account_id INTEGER NOT NULL,
                thread_id INTEGER NOT NULL,
                dismissed_seq INTEGER,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (account_id, thread_id)
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

    /** Resolve a direct-call UserProfile by its canonical account+domain within the current device-cache
     * owner. FederatedMemberProfile's source-peer triple is intentionally not used: it is a group-published
     * member snapshot, whereas 1:1 calls address a User profile. */
    fun getCallPeer(ctx: Context, account: String, domain: String): CallPeer? {
        val ownerUserId = SomsSecureStore.getCurrentUserId(ctx) ?: return null
        return try {
            open(ctx).use { db ->
                db.rawQuery(
                    """SELECT COALESCE(json_extract(p.payload_json, '$.name'), ''),
                              a.mime, a.data
                         FROM profiles p
                    LEFT JOIN avatars a ON a.user_id = p.user_id AND a.identity = p.identity
                        WHERE p.user_id = ?1
                          AND json_extract(p.payload_json, '$.account') = ?2
                          AND COALESCE(json_extract(p.payload_json, '$.domain'), '') = ?3
                     ORDER BY p.profile_rev DESC LIMIT 1""".trimIndent(),
                    arrayOf(ownerUserId.toString(), account, domain),
                ).use { cursor ->
                    if (!cursor.moveToFirst()) null else CallPeer(
                        name = cursor.getString(0) ?: "",
                        avatarMime = if (cursor.isNull(1)) null else cursor.getString(1),
                        avatarBytes = if (cursor.isNull(2)) null else cursor.getBlob(2),
                    )
                }
            }
        } catch (e: Exception) {
            SomsLog.w("SomsCall") { "local call peer lookup failed: ${e.javaClass.simpleName}: ${e.message}" }
            null
        }
    }

    fun getStateFeedCursor(ctx: Context): Int = open(ctx).use { db ->
        db.rawQuery(
            "SELECT feed_id FROM notification_feed_state WHERE account_id = ?",
            arrayOf(ACTIVE_ACCOUNT.toString()),
        ).use { cursor -> if (cursor.moveToFirst()) cursor.getInt(0) else 0 }
    }

    fun setStateFeedCursor(ctx: Context, feedId: Int) = open(ctx).use { db ->
        require(feedId >= 0)
        db.execSQL(
            """INSERT INTO notification_feed_state(account_id, feed_id, updated_at) VALUES(?, ?, ?)
               ON CONFLICT(account_id) DO UPDATE SET feed_id=excluded.feed_id, updated_at=excluded.updated_at""",
            arrayOf(ACTIVE_ACCOUNT, feedId, System.currentTimeMillis()),
        )
    }

    fun dismissedThreadSeqs(ctx: Context): Map<Int, Int> = open(ctx).use { db ->
        val result = HashMap<Int, Int>()
        db.rawQuery(
            "SELECT thread_id, dismissed_seq FROM notification_thread_state WHERE account_id = ? AND dismissed_seq IS NOT NULL",
            arrayOf(ACTIVE_ACCOUNT.toString()),
        ).use { cursor ->
            while (cursor.moveToNext()) result[cursor.getInt(0)] = cursor.getInt(1)
        }
        result
    }

    fun setDismissedThreadSeq(ctx: Context, threadId: Int, seq: Int) = open(ctx).use { db ->
        db.execSQL(
            """INSERT INTO notification_thread_state(account_id, thread_id, dismissed_seq, updated_at)
               VALUES(?, ?, ?, ?)
               ON CONFLICT(account_id, thread_id) DO UPDATE SET
                 dismissed_seq=excluded.dismissed_seq, updated_at=excluded.updated_at""",
            arrayOf(ACTIVE_ACCOUNT, threadId, seq, System.currentTimeMillis()),
        )
    }

    fun clearNotificationState(ctx: Context) = open(ctx).use { db ->
        db.beginTransaction()
        try {
            db.delete("notification_feed_state", "account_id = ?", arrayOf(ACTIVE_ACCOUNT.toString()))
            db.delete("notification_thread_state", "account_id = ?", arrayOf(ACTIVE_ACCOUNT.toString()))
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun clearDismissedThreads(ctx: Context) = open(ctx).use { db ->
        db.delete("notification_thread_state", "account_id = ?", arrayOf(ACTIVE_ACCOUNT.toString()))
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
