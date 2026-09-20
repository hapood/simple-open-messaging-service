package com.soms.client

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * JVM unit tests for [HelloMerger] — the cached-HELLO merge rules (parity with the Rust
 * `cached_hello_merge_tests` in src-tauri/src/lib.rs). Pins the same contract both native owners rely on to
 * keep a re-attached WebView's replayed HELLO fresh.
 */
class HelloMergerTest {

    @Test
    fun push_revision_survives_webview_suspension_and_is_session_scoped() {
        var c = HelloMerger.merge(null, "HELLO", """{"sessionId":7,"pushSubscriptionRev":1}""")
        c = HelloMerger.merge(c, "PUSH_SUBSCRIPTION_CHANGED", """{"sessionId":7,"pushSubscriptionRev":3}""")
        c = HelloMerger.merge(c, "PUSH_SUBSCRIPTION_CHANGED", """{"sessionId":7,"pushSubscriptionRev":2}""")
        c = HelloMerger.merge(c, "PUSH_SUBSCRIPTION_CHANGED", """{"sessionId":8,"pushSubscriptionRev":4}""")
        assertEquals(3, c!!.getInt("pushSubscriptionRev"))
    }

    @Test
    fun thread_feed_cursor_is_independent_and_monotonic() {
        assertNull(HelloMerger.merge(null, "THREAD_FEED_UPDATED", """{"threadFeedEndId":9}"""))
        var c = HelloMerger.merge(null, "HELLO", """{"userId":1,"stateFeedEndId":5,"threadFeedEndId":2}""")
        c = HelloMerger.merge(c, "THREAD_FEED_UPDATED", """{"threadFeedEndId":9}""")
        c = HelloMerger.merge(c, "THREAD_FEED_UPDATED", """{"threadFeedEndId":8}""")
        assertEquals(9L, c!!.getLong("threadFeedEndId"))
        assertEquals(5L, c.getLong("stateFeedEndId"))
    }

    @Test
    fun hello_seeds_then_incremental_frames_patch_their_fields() {
        var c = HelloMerger.merge(
            null, "HELLO",
            """{"userId":1,"stateFeedEndId":5,"profileRev":2}""",
        )
        assertEquals(1, c!!.getInt("userId"))
        assertEquals(5, c.getInt("stateFeedEndId"))

        c = HelloMerger.merge(c, "STATE_FEED_UPDATED", """{"feedId":6}""")
        assertEquals(6, c!!.getInt("stateFeedEndId"))

        c = HelloMerger.merge(c, "UNRELATED_EVENT", """{"threadId":7,"seq":9,"ts":123}""")
        assertFalse(c!!.has("latestMessage"))
    }

    @Test
    fun state_feed_end_is_monotonic_out_of_order_dropped() {
        var c = HelloMerger.merge(null, "HELLO", """{"userId":1,"stateFeedEndId":5}""")
        c = HelloMerger.merge(c, "STATE_FEED_UPDATED", """{"feedId":9}""")
        c = HelloMerger.merge(c, "STATE_FEED_UPDATED", """{"feedId":8}""")
        assertEquals(9L, c!!.getLong("stateFeedEndId"))
    }

    @Test
    fun incremental_before_hello_is_dropped_no_partial_cache() {
        assertNull(HelloMerger.merge(null, "STATE_FEED_UPDATED", """{"feedId":6}"""))
    }

    @Test
    fun malformed_frame_leaves_cache_untouched() {
        val c = HelloMerger.merge(null, "HELLO", """{"userId":1,"stateFeedEndId":5}""")
        // Malformed JSON on an incremental → cache unchanged (not nulled, not corrupted).
        val c2 = HelloMerger.merge(c, "STATE_FEED_UPDATED", "{not json")
        assertEquals(1, c2!!.getInt("userId"))
        assertEquals(5, c2.getInt("stateFeedEndId"))
    }
}
