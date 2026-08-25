package com.soms.client

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class ClientStateDbTest {
    private lateinit var context: Context
    private lateinit var dbFile: File

    @Before
    fun setUp() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
        dbFile = File(context.filesDir, "soms-local.sqlite3")
        SQLiteDatabase.deleteDatabase(dbFile)
        SomsSecureStore.setCurrentUserId(context, 41)
        openDb().use { db ->
            db.execSQL(
                """CREATE TABLE profiles (
                    user_id INTEGER NOT NULL,
                    identity TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    profile_rev INTEGER NOT NULL,
                    PRIMARY KEY (user_id, identity)
                )""".trimIndent(),
            )
            db.execSQL(
                """CREATE TABLE avatars (
                    user_id INTEGER NOT NULL,
                    identity TEXT NOT NULL,
                    source_path TEXT NOT NULL,
                    mime TEXT NOT NULL,
                    data BLOB NOT NULL,
                    last_render INTEGER NOT NULL,
                    PRIMARY KEY (user_id, identity)
                )""".trimIndent(),
            )
        }
    }

    @After
    fun tearDown() {
        SQLiteDatabase.deleteDatabase(dbFile)
    }

    @Test
    fun resolvesLocalUserProfileByAccountAndEmptyDomain() {
        insertProfile(41, "u7", "alice", "", "Alice", 4, byteArrayOf(1, 2, 3))

        val peer = ClientStateDb.getCallPeer(context, "alice", "")!!

        assertEquals("Alice", peer.name)
        assertEquals("image/webp", peer.avatarMime)
        assertArrayEquals(byteArrayOf(1, 2, 3), peer.avatarBytes)
    }

    @Test
    fun resolvesFederatedUserProfileByAccountAndDomain() {
        insertProfile(41, "u8", "bob", "chat.example", "Bob", 2, byteArrayOf(9))

        val peer = ClientStateDb.getCallPeer(context, "bob", "chat.example")!!

        assertEquals("Bob", peer.name)
        assertArrayEquals(byteArrayOf(9), peer.avatarBytes)
    }

    @Test
    fun doesNotFallBackToAnotherDomainOrCacheOwner() {
        insertProfile(41, "u9", "sam", "one.example", "Wrong domain", 3, null)
        insertProfile(99, "u9", "sam", "two.example", "Wrong owner", 3, null)

        assertNull(ClientStateDb.getCallPeer(context, "sam", "two.example"))
    }

    private fun insertProfile(
        ownerUserId: Int,
        identity: String,
        account: String,
        domain: String,
        name: String,
        profileRev: Int,
        avatar: ByteArray?,
    ) {
        openDb().use { db ->
            db.execSQL(
                "INSERT INTO profiles(user_id, identity, payload_json, profile_rev) VALUES(?, ?, ?, ?)",
                arrayOf(
                    ownerUserId,
                    identity,
                    """{"account":"$account","domain":"$domain","name":"$name"}""",
                    profileRev,
                ),
            )
            if (avatar != null) {
                db.execSQL(
                    "INSERT INTO avatars(user_id, identity, source_path, mime, data, last_render) VALUES(?, ?, ?, ?, ?, ?)",
                    arrayOf(ownerUserId, identity, "/avatar.webp", "image/webp", avatar, 0),
                )
            }
        }
    }

    private fun openDb(): SQLiteDatabase = SQLiteDatabase.openOrCreateDatabase(dbFile, null)
}
