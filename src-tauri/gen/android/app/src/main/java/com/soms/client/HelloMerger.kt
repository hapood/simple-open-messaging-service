package com.soms.client

import org.json.JSONObject

/**
 * Pure (Android-free) HELLO-cache merge logic — the rules [RealtimeService.cacheHelloFrame] applies to keep
 * the cached HELLO fresh across a WebView reclaim (a retained open `/events` stream does not re-push HELLO).
 * Extracted into a top-level object so it is JVM-unit-testable (parity with the Rust `merge_cached_hello`
 * test in src-tauri/src/lib.rs) WITHOUT instantiating the Android `Service`.
 *
 * HELLO replaces the cache wholesale; each incremental revision frame patches its matching field IN PLACE
 * (cheap — one deserialize on HELLO + one serialize at replay). `threadRevision`, `friendReqRev`, and
 * `friendReqAckRev` are monotonic — an out-of-order (older) value is dropped so a stale push can't regress
 * replay state. A frame before the first HELLO yields null (no partial cached handshake). Best-effort: a
 * malformed frame leaves the cache untouched.
 */
object HelloMerger {

  /** Merge one inbound SSE frame into the cached HELLO; return the resulting JSONObject (the caller stores
   *  it). `cached` null + a non-HELLO frame → null (drop, no partial cache). */
  fun merge(cached: JSONObject?, type: String, data: String): JSONObject? {
    return try {
    if (type == "HELLO") JSONObject(data)
    else {
      val c = cached ?: return null
      when (type) {
        "STATE_REV_UPDATED" -> {
          val inc = JSONObject(data).optLong("stateRevision", Long.MIN_VALUE)
          if (inc != Long.MIN_VALUE && inc >= c.optLong("stateRevision", Long.MIN_VALUE)) {
            c.put("stateRevision", inc)
          }
        }
        "FRIEND_REQ_REV_UPDATED" -> {
          val inc = JSONObject(data).optLong("friendReqRev", Long.MIN_VALUE)
          if (inc != Long.MIN_VALUE && inc >= c.optLong("friendReqRev", Long.MIN_VALUE)) c.put("friendReqRev", inc)
          val ack = JSONObject(data).optLong("friendReqAckRev", Long.MIN_VALUE)
          if (ack != Long.MIN_VALUE && ack >= c.optLong("friendReqAckRev", Long.MIN_VALUE)) c.put("friendReqAckRev", ack)
        }
        "NEW_MESSAGE" -> {
          val d = JSONObject(data)
          c.put(
            "latestMessage",
            JSONObject()
              .put("threadId", d.opt("threadId"))
              .put("seq", d.opt("seq"))
              .put("ts", d.opt("ts")),
          )
        }
      }
      c
    }
  } catch (_: Exception) {
    // Malformed frame — leave the cache as-is; the next HELLO reseeds it wholesale.
    cached
  }
  }
}
