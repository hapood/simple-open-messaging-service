package com.soms.client

import org.json.JSONObject

/**
 * Pure (Android-free) HELLO-cache merge logic — the rules [RealtimeService.cacheHelloFrame] applies to keep
 * the cached HELLO fresh across a WebView reclaim (a retained open `/events` stream does not re-push HELLO).
 * Extracted into a top-level object so it is JVM-unit-testable (parity with the Rust `merge_cached_hello`
 * test in src-tauri/src/lib.rs) WITHOUT instantiating the Android `Service`.
 *
 * HELLO replaces the cache wholesale; each incremental revision frame patches its matching field IN PLACE
 * (cheap — one deserialize on HELLO + one serialize at replay). `stateFeedEndId` is monotonic — an
 * out-of-order (older) value is dropped so a stale push can't regress replay state. A frame before the
 * first HELLO yields null (no partial cached handshake). Best-effort: a
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
        "PUSH_SUBSCRIPTION_CHANGED" -> {
          val input = JSONObject(data)
          val rev = input.optLong("pushSubscriptionRev", 0)
          if (input.optLong("sessionId", -1) == c.optLong("sessionId", -2) &&
              rev > c.optLong("pushSubscriptionRev", 0) && rev <= Int.MAX_VALUE) {
            c.put("pushSubscriptionRev", rev)
          }
        }
        "STATE_FEED_UPDATED", "THREAD_FEED_UPDATED" -> {
          val input = if (type == "STATE_FEED_UPDATED") "feedId" else "threadFeedEndId"
          val output = if (type == "STATE_FEED_UPDATED") "stateFeedEndId" else "threadFeedEndId"
          val inc = JSONObject(data).optLong(input, Long.MIN_VALUE)
          if (inc != Long.MIN_VALUE && inc >= c.optLong(output, Long.MIN_VALUE)) {
            c.put(output, inc)
          }
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
