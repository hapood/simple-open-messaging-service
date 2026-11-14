package com.soms.client

import android.security.keystore.KeyPermanentlyInvalidatedException
import javax.crypto.AEADBadTagException

/** Storage recovery is allowed only before Rust admits a session, never from a runtime getter. */
internal object SecureStoreRecovery {
    enum class Failure { AUTHENTICATION_FAILED, KEY_INVALIDATED }

    private class InvalidEncryptedEntry(cause: SecurityException) : Exception(cause)

    /** After keysets have opened, entry decryption uses in-memory Tink primitives, not Keystore.
     * Tink may discard the AEAD cause when no key authenticates an entry. Scope this handling to
     * value validation; generic security exceptions while opening the master key remain errors. */
    internal fun validateEntries(readAll: () -> Unit) {
        try {
            readAll()
        } catch (error: SecurityException) {
            if (error.cause is java.security.GeneralSecurityException) {
                throw InvalidEncryptedEntry(error)
            }
            throw error
        }
    }

    /** Each store must exclusively own its master-key alias if invalidated keys are to be removed. */
    fun openPreferencesAtStartup(
        context: android.content.Context,
        filename: String,
        masterKeyAlias: String,
    ): android.content.SharedPreferences = openAtStartup(
        openAndValidate = {
            val key = androidx.security.crypto.MasterKey.Builder(context, masterKeyAlias)
                .setKeyScheme(androidx.security.crypto.MasterKey.KeyScheme.AES256_GCM).build()
            val prefs = androidx.security.crypto.EncryptedSharedPreferences.create(
                context, filename, key,
                androidx.security.crypto.EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                androidx.security.crypto.EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            validateEntries { prefs.all }
            prefs
        },
        reset = { failure ->
            check(context.deleteSharedPreferences(filename)) {
                "Could not reset unreadable secure preferences"
            }
            if (failure == Failure.KEY_INVALIDATED) {
                // Authentication failure alone does not justify deleting a usable master key.
                val keyStore = java.security.KeyStore.getInstance("AndroidKeyStore")
                keyStore.load(null)
                keyStore.deleteEntry(masterKeyAlias)
            }
            android.util.Log.w("SomsSecureStore", "Reset unreadable device credentials: $failure")
        },
    )

    fun classify(error: Exception): Failure? {
        val causes = generateSequence<Throwable>(error) { it.cause }.take(16).toList()
        return when {
            causes.any { it is KeyPermanentlyInvalidatedException } -> Failure.KEY_INVALIDATED
            causes.any { it is AEADBadTagException || it is InvalidEncryptedEntry } -> Failure.AUTHENTICATION_FAILED
            else -> null
        }
    }

    fun <T> openAtStartup(openAndValidate: () -> T, reset: (Failure) -> Unit): T {
        return try {
            openAndValidate()
        } catch (error: Exception) {
            val failure = classify(error) ?: throw error
            reset(failure)
            // One attempt only. I/O failures or a still-unavailable Keystore must propagate;
            // never fall back to plaintext or repeatedly erase newly created storage.
            openAndValidate()
        }
    }
}
