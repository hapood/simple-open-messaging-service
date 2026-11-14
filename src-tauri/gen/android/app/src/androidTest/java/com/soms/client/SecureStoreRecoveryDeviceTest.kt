package com.soms.client

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyStore
import java.util.UUID

/** Uses isolated filenames and aliases, never the application's actual credential store. */
@RunWith(AndroidJUnit4::class)
class SecureStoreRecoveryDeviceTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    private fun withStore(test: (String, String) -> Unit) {
        val name = "secure-recovery-test-${UUID.randomUUID()}"
        val alias = "$name-key"
        try {
            test(name, alias)
        } finally {
            context.deleteSharedPreferences(name)
            KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry(alias) }
        }
    }

    @Test
    fun reopeningAValidStorePreservesTheCredential() = withStore { name, alias ->
        val prefs = SecureStoreRecovery.openPreferencesAtStartup(context, name, alias)
        assertTrue(prefs.edit().putString("session_token", "test-token").commit())
        val reopened = SecureStoreRecovery.openPreferencesAtStartup(context, name, alias)
        assertEquals("test-token", reopened.getString("session_token", null))
    }

    @Test
    fun transferredCiphertextWithoutItsKeyBecomesAnEmptyEncryptedStore() = withStore { name, alias ->
        val prefs = SecureStoreRecovery.openPreferencesAtStartup(context, name, alias)
        assertTrue(prefs.edit().putString("session_token", "old-device-token").commit())
        KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry(alias) }
        val recovered = SecureStoreRecovery.openPreferencesAtStartup(context, name, alias)
        assertNull(recovered.getString("session_token", null))
        assertTrue(recovered.edit().putString("session_token", "new-device-token").commit())
        val reopened = SecureStoreRecovery.openPreferencesAtStartup(context, name, alias)
        assertEquals("new-device-token", reopened.getString("session_token", null))
        // Recovery must still use encryption; the raw preferences contain no plaintext credential.
        val raw = context.getSharedPreferences(name, Context.MODE_PRIVATE).all
        assertFalse(raw.containsKey("session_token"))
        assertFalse(raw.values.contains("new-device-token"))
    }

    @Test
    fun corruptValueIsDetectedEvenWhenTheKeysetsOpenSuccessfully() = withStore { name, alias ->
        val prefs = SecureStoreRecovery.openPreferencesAtStartup(context, name, alias)
        assertTrue(prefs.edit().putString("session_token", "test-token").commit())
        val raw = context.getSharedPreferences(name, Context.MODE_PRIVATE)
        val entry = raw.all.entries.single { !it.key.startsWith("__androidx_security_crypto_") }
        val bytes = android.util.Base64.decode(entry.value as String, android.util.Base64.DEFAULT)
        bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte()
        assertTrue(raw.edit().putString(entry.key, android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)).commit())
        val recovered = SecureStoreRecovery.openPreferencesAtStartup(context, name, alias)
        assertNull(recovered.getString("session_token", null))
    }
}
