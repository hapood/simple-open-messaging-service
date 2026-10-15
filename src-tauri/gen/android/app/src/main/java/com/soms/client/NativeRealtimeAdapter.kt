package com.soms.client

/** Platform resource ownership only. Connection policy and asynchronous work belong to Rust. */
internal interface NativeRealtimeRuntime {
    fun start(): Long
    fun stop(instance: Long)
    fun network(instance: Long, online: Boolean)
    fun retry(instance: Long): Long
    fun reconnect(instance: Long): Long
}

/** A service instance cannot issue commands after destruction or target a successor's runtime lease.
 * Native calls run outside the lock; Rust validates the captured lease again at command admission. */
internal class NativeRealtimeAdapter(private val runtime: NativeRealtimeRuntime) {
    private val lock = Any()
    private var instance = 0L
    private var starting = false
    @Volatile private var destroyed = false
    val isAlive: Boolean get() = !destroyed

    fun start() {
        synchronized(lock) {
            if (destroyed || starting || instance != 0L) return
            starting = true
        }
        val lease = try {
            runtime.start().also { check(it > 0) { "Rust realtime returned no instance lease" } }
        } catch (error: Throwable) {
            synchronized(lock) { starting = false }
            throw error
        }
        val discard = synchronized(lock) {
            starting = false
            if (destroyed) true else { instance = lease; false }
        }
        if (discard) runtime.stop(lease)
    }

    private fun lease(): Long = synchronized(lock) { if (destroyed) 0L else instance }
    fun network(online: Boolean) { lease().takeIf { it > 0 }?.let { runtime.network(it, online) } }
    fun retry() = command { runtime.retry(it) }
    fun reconnect() = command { runtime.reconnect(it) }

    private fun command(call: (Long) -> Long) {
        val previous = lease().takeIf { it > 0 } ?: return
        val next = call(previous)
        if (next <= 0) return // Rust rejected a stale command, not a new resource to bind.
        val discard = synchronized(lock) {
            if (destroyed || instance != previous) true else { instance = next; false }
        }
        if (discard && next != previous) runtime.stop(next)
    }

    fun destroy() {
        val lease = synchronized(lock) {
            if (destroyed) return
            destroyed = true
            instance.also { instance = 0L }
        }
        if (lease > 0) runtime.stop(lease)
    }
}
