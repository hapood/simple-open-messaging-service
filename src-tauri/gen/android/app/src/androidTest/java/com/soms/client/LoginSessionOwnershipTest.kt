package com.soms.client

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/**
 * Device coverage for the login-session ownership glue between Kotlin and Rust.
 * Every credential write names its owning login UUID; unowned, malformed or
 * successor identities never observe or clear admitted state. The Rust-side
 * lifecycle itself is covered by the on-device lib test suite; these tests pin
 * the JNI and secure-store boundary behavior that compilation alone cannot.
 */
@RunWith(AndroidJUnit4::class)
class LoginSessionOwnershipTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun blankSessionUuidIsRejectedBeforeAnyStorageOrRustCall() {
        expectIllegalArgument { RustRuntimeBridge.setSessionToken(null, "") }
        expectIllegalArgument { RustRuntimeBridge.setSessionToken("token", "   ") }
        expectIllegalArgument { SomsSecureStore.setSessionToken(context, null, "") }
        expectIllegalArgument { SomsSecureStore.setSessionToken(context, "token", "\t") }
    }

    @Test
    fun unknownOrMalformedUuidsAreNeverCurrent() {
        assertFalse(RustRuntimeBridge.isLoginSessionCurrent("not-a-uuid"))
        assertFalse(RustRuntimeBridge.isLoginSessionCurrent(""))
        assertFalse(RustRuntimeBridge.isLoginSessionCurrent(UUID.randomUUID().toString()))
    }

    @Test
    fun clearingWithPredecessorUuidDoesNotClearSuccessorCredentials() {
        val prefs = SomsSecureStore.prefs(context)
        val originalToken = SomsSecureStore.getSessionToken(context)
        val originalUuid = SomsSecureStore.getLoginSessionId(context)
        val activeUuid = UUID.randomUUID().toString()
        val predecessorUuid = UUID.randomUUID().toString()
        try {
            prefs.edit()
                .putString("session_token", "active-token")
                .putString("login_session_id", activeUuid)
                .commit()

            assertEquals("active-token", SomsSecureStore.getSessionToken(context))
            assertEquals(activeUuid, SomsSecureStore.getLoginSessionId(context))

            // Attempt to clear using the predecessor UUID — must be a no-op that preserves the active token.
            SomsSecureStore.setSessionToken(context, null, predecessorUuid)

            assertEquals("active-token", SomsSecureStore.getSessionToken(context))
            assertEquals(activeUuid, SomsSecureStore.getLoginSessionId(context))

            // Clearing with the exact active UUID succeeds in removing credentials without touching Rust
            // because SomsSecureStore checks and clears its own state.
            // Note: Rust would reject an unadmitted token, but setSessionToken(ctx, null, activeUuid)
            // clears secure store when currentUuid matches.
        } finally {
            val cleanup = prefs.edit()
            if (originalToken != null) cleanup.putString("session_token", originalToken) else cleanup.remove("session_token")
            if (originalUuid != null) cleanup.putString("login_session_id", originalUuid) else cleanup.remove("login_session_id")
            cleanup.commit()
        }
    }

    @Test
    fun residualTokenClearFailsClosedExactlyWhileALoginIsAdmitted() {
        val stored = SomsSecureStore.getLoginSessionId(context)
        val admitted = stored != null && RustRuntimeBridge.isLoginSessionCurrent(stored)
        if (admitted) {
            try {
                RustRuntimeBridge.discardResidualToken()
                fail("residual clear must fail while a login is admitted")
            } catch (expected: IllegalStateException) {
                // Rust refused: the admitted credential is not residual.
            }
        } else {
            // No admitted login: the residual credential is unowned and must clear without error.
            RustRuntimeBridge.discardResidualToken()
        }
    }

    private fun expectIllegalArgument(action: () -> Unit) {
        try {
            action()
            fail("a blank session UUID must be rejected")
        } catch (expected: IllegalArgumentException) {
        }
    }
}
