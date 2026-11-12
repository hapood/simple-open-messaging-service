package com.soms.client

import androidx.annotation.Keep

/** Call policy and asynchronous orchestration belong to the shared Rust runtime. */
@Keep
internal object RustCallBridge {
    init { System.loadLibrary("soms_client_lib") }
    external fun bind(callbacks: NativeCallCallbacks)
    external fun command(lease: Long, command: String): String
    external fun isCurrent(lease: Long): Boolean
    external fun isLive(lease: Long): Boolean
    external fun canRing(lease: Long): Boolean
    external fun detach(lease: Long)
}

@Keep
interface NativeCallCallbacks {
    fun onCommand(command: String)
}
