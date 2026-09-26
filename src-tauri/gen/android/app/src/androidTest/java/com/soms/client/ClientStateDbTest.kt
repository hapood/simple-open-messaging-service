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
            RustRuntimeBridge.setNotificationPreference("notificationPreviewMode", "private")
            RustRuntimeBridge.setNotificationPreference("notificationAlertPolicy", "once_per_thread")
            assertEquals("private", RustRuntimeBridge.getNotificationPreference("notificationPreviewMode"))
            assertEquals("once_per_thread", RustRuntimeBridge.getNotificationPreference("notificationAlertPolicy"))
        } finally {
            RustRuntimeBridge.setNotificationPreference("notificationPreviewMode", previousPreview ?: "message")
            RustRuntimeBridge.setNotificationPreference("notificationAlertPolicy", previousAlert ?: "cooldown_5s")
        }
    }

    @Test
    fun missingCallThreadReturnsNoPeerWithoutOpeningPlatformSqlite() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        SomsSecureStore.setCurrentUserId(context, 41)

        assertNull(ClientStateDb.getCallPeer(context, "missing", "local", 999999))
    }
}
