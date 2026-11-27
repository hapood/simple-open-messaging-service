package com.soms.client

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NotificationOpeningIntentTest {
    private fun threadIntent() = Intent().putExtra(
        SomsMessagingService.EXTRA_TARGET, """{"kind":"thread","threadId":7}""",
    )

    @Test fun preservesAbsentSequence() {
        val opening = JSONObject(threadIntent().notificationOpeningPayload()!!)
        assertFalse(opening.has("latestSeq"))
        assertEquals(7, opening.getJSONObject("target").getInt("threadId"))
    }

    @Test fun preservesIntegerSequenceIncludingZeroAndBounds() {
        for (seq in listOf(0, 42, Int.MAX_VALUE, -1)) {
            val intent = threadIntent().putExtra(SomsMessagingService.EXTRA_LATEST_SEQ, seq)
            assertEquals(seq, JSONObject(intent.notificationOpeningPayload()!!).getInt("latestSeq"))
        }
    }

    @Test fun wrongTypedOrNullSequenceCannotBecomeAValidZeroCeiling() {
        val key = SomsMessagingService.EXTRA_LATEST_SEQ
        val intents = listOf(
            threadIntent().putExtra(key, "42"),
            threadIntent().putExtra(key, 42L),
            threadIntent().putExtra(key, 1.5),
            threadIntent().putExtra(key, null as String?),
        )
        for (intent in intents) {
            assertEquals(-1, JSONObject(intent.notificationOpeningPayload()!!).getInt("latestSeq"))
        }
    }

    @Test fun missingOrMalformedTargetCannotProduceAnOpening() {
        assertNull(Intent().notificationOpeningPayload())
        assertNull(Intent().putExtra(SomsMessagingService.EXTRA_TARGET, "not-json").notificationOpeningPayload())
    }

    @Test fun preservesNonThreadOpeningWithoutSequence() {
        val target = """{"kind":"friend-requests"}"""
        val intent = Intent().putExtra(SomsMessagingService.EXTRA_TARGET, target)
        val opening = JSONObject(intent.notificationOpeningPayload()!!)
        assertEquals("friend-requests", opening.getJSONObject("target").getString("kind"))
        assertFalse(opening.has("latestSeq"))
    }
}
