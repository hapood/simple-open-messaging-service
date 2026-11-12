package com.soms.client

import androidx.annotation.Keep

/** Transport only: Rust owns candidate search, demand consumers and cancellation. */
@Keep
internal object RustMentionBridge {
    init { System.loadLibrary("soms_client_lib") }

    @Keep
    interface Callbacks {
        fun onResults(contextId: Long, requestId: Long, metadata: String, avatars: Array<ByteArray>)
    }

    external fun open(callbacks: Callbacks): Long
    external fun query(
        lease: Long,
        userId: Long,
        threadId: Long,
        contextId: Long,
        requestId: Long,
        query: String,
        allLabel: String,
    )
    external fun cancel(lease: Long)
    external fun close(lease: Long)
}
