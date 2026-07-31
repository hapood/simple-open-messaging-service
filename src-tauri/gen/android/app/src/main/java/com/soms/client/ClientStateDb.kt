package com.soms.client

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.io.File

/** WebView-independent notification state in the same local SQLite file used by the Tauri data layer. */
object ClientStateDb {
    private const val ACTIVE_ACCOUNT = 0

    private fun open(ctx: Context): SQLiteDatabase {
        val db = SQLiteDatabase.openOrCreateDatabase(File(ctx.filesDir, "soms-local.sqlite3"), null)
        db.execSQL("PRAGMA journal_mode=WAL")
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
            """CREATE TABLE IF NOT EXISTS notification_global_state (
                account_id INTEGER PRIMARY KEY,
                cursor_thread_id INTEGER,
                cursor_seq INTEGER,
                updated_at INTEGER NOT NULL
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

    fun getNotificationCursor(ctx: Context): Pair<Int, Int>? = open(ctx).use { db ->
        db.rawQuery(
            "SELECT cursor_thread_id, cursor_seq FROM notification_global_state WHERE account_id = ?",
            arrayOf(ACTIVE_ACCOUNT.toString()),
        ).use { cursor ->
            if (!cursor.moveToFirst() || cursor.isNull(0) || cursor.isNull(1)) null
            else Pair(cursor.getInt(0), cursor.getInt(1))
        }
    }

    fun setNotificationCursor(ctx: Context, threadId: Int?, seq: Int?) = open(ctx).use { db ->
        if (threadId == null || seq == null) {
            db.delete("notification_global_state", "account_id = ?", arrayOf(ACTIVE_ACCOUNT.toString()))
        } else {
            db.execSQL(
                """INSERT INTO notification_global_state(account_id, cursor_thread_id, cursor_seq, updated_at)
                   VALUES(?, ?, ?, ?)
                   ON CONFLICT(account_id) DO UPDATE SET cursor_thread_id=excluded.cursor_thread_id,
                     cursor_seq=excluded.cursor_seq, updated_at=excluded.updated_at""",
                arrayOf(ACTIVE_ACCOUNT, threadId, seq, System.currentTimeMillis()),
            )
        }
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
            db.delete("notification_global_state", "account_id = ?", arrayOf(ACTIVE_ACCOUNT.toString()))
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
