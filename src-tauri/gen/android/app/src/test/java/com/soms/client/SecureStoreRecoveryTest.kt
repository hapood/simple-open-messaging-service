package com.soms.client

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.security.GeneralSecurityException
import javax.crypto.AEADBadTagException

class SecureStoreRecoveryTest {
    @Test
    fun validStoreIsNotReset() {
        assertEquals("token", SecureStoreRecovery.openAtStartup({ "token" }, { fail("reset") }))
        assertNull(SecureStoreRecovery.openAtStartup<String?>({ null }, { fail("reset") }))
    }

    @Test
    fun wrappedAuthenticationFailureReopensExactlyOnce() {
        var opens = 0
        var resets = 0
        val result = SecureStoreRecovery.openAtStartup(
            {
                opens++
                if (opens == 1) throw SecurityException("value decryption", AEADBadTagException())
                "fresh encrypted store"
            },
            {
                assertEquals(SecureStoreRecovery.Failure.AUTHENTICATION_FAILED, it)
                resets++
            },
        )
        assertEquals("fresh encrypted store", result)
        assertEquals(2, opens)
        assertEquals(1, resets)
    }

    @Test
    fun transientAndUnknownFailuresNeverReset() {
        for (error in listOf(IOException("disk"), GeneralSecurityException("provider"), SecurityException("permission"))) {
            try {
                SecureStoreRecovery.openAtStartup<Unit>({ throw error }, { fail("must preserve data") })
                fail("must propagate")
            } catch (actual: Exception) {
                assertSame(error, actual)
            }
        }
    }

    @Test
    fun tinkEntryFailureWithoutAeadCauseIsRecoveredOnlyAtValidation() {
        val error = SecurityException("entry", GeneralSecurityException("decryption failed"))
        assertNull(SecureStoreRecovery.classify(error))
        var opens = 0
        var resets = 0
        SecureStoreRecovery.openAtStartup(
            {
                opens++
                if (opens == 1) SecureStoreRecovery.validateEntries { throw error }
            },
            { resets++ },
        )
        assertEquals(2, opens)
        assertEquals(1, resets)
    }

    @Test
    fun failedRecreationDoesNotLoop() {
        var resets = 0
        try {
            SecureStoreRecovery.openAtStartup<Unit>({ throw AEADBadTagException() }, { resets++ })
            fail("must propagate")
        } catch (expected: AEADBadTagException) {
            assertEquals(1, resets)
        }
    }

    @Test
    fun resetFailureIsNotHidden() {
        val error = IOException("reset failed")
        try {
            SecureStoreRecovery.openAtStartup<Unit>({ throw AEADBadTagException() }, { throw error })
            fail("must propagate")
        } catch (actual: Exception) {
            assertSame(error, actual)
        }
    }
}
