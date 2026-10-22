package com.soms.client

import java.util.concurrent.CompletableFuture

/** Fences SDK execution and releases host resources; it never decides session policy or signals the server. */
internal class NativeCallResourceCancellation(
    private val enqueue: (() -> Unit) -> Unit,
    private val currentOwner: () -> String?,
    private val release: () -> Unit,
) {
    private val monitor = Any()
    private var revision = 0L
    private var released = CompletableFuture.completedFuture(Unit)
    private var networkCancellation: (() -> Unit)? = null
    val isClosing: Boolean get() = synchronized(monitor) { !released.isDone }

    // Admission and owner snapshot writes must be atomic. The action only mutates in-memory fields.
    fun admitWhileOpen(expected: Long? = null, action: () -> Boolean): Long? = synchronized(monitor) {
        if (!released.isDone || (expected != null && expected != revision) || !action()) null else revision
    }

    fun execute(action: () -> Unit) = execute(synchronized(monitor) { revision }, action)

    fun execute(admission: Long, action: () -> Unit) {
        val completion = synchronized(monitor) { released }
        completion.thenRun {
            enqueue {
                if (synchronized(monitor) { revision == admission }) action()
            }
        }
    }

    // This is a wake-up, not SDK work: the caller revalidates its original session binding.
    fun whenReleased(action: () -> Unit) {
        val completion = synchronized(monitor) { released }
        completion.thenRun { action() }
    }

    fun registerNetwork(cancel: () -> Unit): Boolean = synchronized(monitor) {
        if (!released.isDone) false else {
            networkCancellation = cancel
            true
        }
    }

    fun unregisterNetwork(cancel: () -> Unit) = synchronized(monitor) {
        if (networkCancellation === cancel) networkCancellation = null
    }

    // Preparing only closes admission; execute the returned action outside the credential monitor.
    fun prepare(): () -> Unit {
        val completion = CompletableFuture<Unit>()
        val captured = synchronized(monitor) {
            revision += 1
            released = completion
            currentOwner() to networkCancellation
        }
        val (owner, cancelNetwork) = captured
        return {
            // Interrupt the executing request now, not from the queue blocked by that request.
            try {
                cancelNetwork?.invoke()
            } finally {
                enqueue {
                    try {
                        if (!owner.isNullOrEmpty() && currentOwner() == owner) release()
                    } finally {
                        completion.complete(Unit)
                    }
                }
            }
        }
    }
}
