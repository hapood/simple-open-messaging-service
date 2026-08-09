package com.soms.client

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * JVM unit tests for [HelloMerger] — the cached-HELLO merge rules (parity with the Rust
 * `cached_hello_merge_tests` in src-tauri/src/lib.rs). Pins the same contract both native owners rely on to
 * keep a re-attached WebView's replayed HELLO fresh.
 */
class HelloMergerTest {

    @Test
    fun hello_seeds_then_incremental_frames_patch_their_fields() {
        var c = HelloMerger.merge(
            null, "HELLO",
            """{"userId":1,"stateRevision":5,"profileRev":2,"friendReqRev":1000,"friendReqAckRev":0}""",
        )
        assertEquals(1, c!!.getInt("userId"))
        assertEquals(5, c.getInt("stateRevision"))

        c = HelloMerger.merge(c, "STATE_REV_UPDATED", """{"stateRevision":6}""")
        assertEquals(6, c!!.getInt("stateRevision"))

        // A newer state pair advances both friendReqRev + friendReqAckRev.
        c = HelloMerger.merge(c, "FRIEND_REQ_REV_UPDATED", """{"friendReqRev":2000,"friendReqAckRev":1500}""")
        assertEquals(2000L, c!!.getLong("friendReqRev"))
        assertEquals(1500L, c.getLong("friendReqAckRev"))

        c = HelloMerger.merge(c, "NEW_MESSAGE", """{"threadId":7,"seq":9,"ts":123}""")
        assertEquals(7, c!!.getJSONObject("latestMessage").getInt("threadId"))
        assertEquals(9, c.getJSONObject("latestMessage").getInt("seq"))
    }

    @Test
    fun friendreq_revisions_are_monotonic_out_of_order_dropped() {
        var c = HelloMerger.merge(null, "HELLO", """{"userId":1,"friendReqRev":2000,"friendReqAckRev":1500}""")
        // An OLDER (stale/out-of-order) pair must not regress either cursor.
        c = HelloMerger.merge(c, "FRIEND_REQ_REV_UPDATED", """{"friendReqRev":1000,"friendReqAckRev":1000}""")
        assertEquals(2000L, c!!.getLong("friendReqRev"))
        assertEquals(1500L, c.getLong("friendReqAckRev"))
    }

    @Test
    fun state_revision_is_monotonic_out_of_order_dropped() {
        var c = HelloMerger.merge(null, "HELLO", """{"userId":1,"stateRevision":5}""")
        c = HelloMerger.merge(c, "STATE_REV_UPDATED", """{"stateRevision":9}""")
        c = HelloMerger.merge(c, "STATE_REV_UPDATED", """{"stateRevision":8}""")
        assertEquals(9L, c!!.getLong("stateRevision"))
    }

    @Test
    fun incremental_before_hello_is_dropped_no_partial_cache() {
        assertNull(HelloMerger.merge(null, "STATE_REV_UPDATED", """{"stateRevision":6}"""))
    }

    @Test
    fun malformed_frame_leaves_cache_untouched() {
        val c = HelloMerger.merge(null, "HELLO", """{"userId":1,"stateRevision":5}""")
        // Malformed JSON on an incremental → cache unchanged (not nulled, not corrupted).
        val c2 = HelloMerger.merge(c, "STATE_REV_UPDATED", "{not json")
        assertEquals(1, c2!!.getInt("userId"))
        assertEquals(5, c2.getInt("stateRevision"))
    }
}
