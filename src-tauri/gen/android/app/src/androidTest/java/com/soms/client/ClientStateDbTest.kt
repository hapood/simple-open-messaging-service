package com.soms.client

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ClientStateDbTest {
    @Test
    fun notificationPreferencesRoundTripThroughRustWithoutPlatformSqlite() {
        val previousPreview = RustRuntimeBridge.getNotificationPreference("notificationPreviewMode")
        val previousAlert = RustRuntimeBridge.getNotificationPreference("notificationAlertPolicy")
        try {
            ClientStateDb.setNotificationPreviewMode("private")
            ClientStateDb.setNotificationAlertPolicy("once_per_thread")
            assertEquals("private", ClientStateDb.getNotificationPreviewMode())
            assertEquals("once_per_thread", ClientStateDb.getNotificationAlertPolicy())
        } finally {
            ClientStateDb.setNotificationPreviewMode(previousPreview ?: "message")
            ClientStateDb.setNotificationAlertPolicy(previousAlert ?: "cooldown_5s")
        }
    }

    @Test
    fun missingCallThreadReturnsNoPeerWithoutOpeningPlatformSqlite() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        SomsSecureStore.setCurrentUserId(context, 41)

        assertNull(ClientStateDb.getCallPeer(context, "missing", 0, 999999))
    }
}
