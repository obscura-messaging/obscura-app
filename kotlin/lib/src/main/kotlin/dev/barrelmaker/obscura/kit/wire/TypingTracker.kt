package dev.barrelmaker.obscura.kit.wire

import dev.barrelmaker.obscura.kit.TypingState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.job
import kotlinx.coroutines.launch

/** Who is typing where, and the send throttle. In memory, per client. */
internal class TypingTracker(private val scope: CoroutineScope) {
    private val lock = Any()
    // contextId -> senderDeviceId -> senderUserId
    private val typing = MutableStateFlow<Map<String, Map<String, String>>>(emptyMap())
    private val expiries = mutableMapOf<Pair<String, String>, Job>()
    private val lastSent = mutableMapOf<Pair<String, TypingState>, Long>()

    fun shouldSend(contextId: String, state: TypingState, nowMs: Long = System.currentTimeMillis()): Boolean =
        synchronized(lock) {
            val last = lastSent[contextId to state]
            if (last != null && nowMs - last < THROTTLE_MS) return false
            lastSent[contextId to state] = nowMs
            true
        }

    fun started(contextId: String, senderUserId: String, senderDeviceId: String) = synchronized(lock) {
        val key = contextId to senderDeviceId
        typing.update { it + (contextId to (it[contextId].orEmpty() + (senderDeviceId to senderUserId))) }
        expiries.remove(key)?.cancel()
        expiries[key] = scope.launch {
            delay(EXPIRE_MS)
            synchronized(lock) { if (expiries[key] === coroutineContext.job) remove(key) }
        }
    }

    fun stopped(contextId: String, senderDeviceId: String) = synchronized(lock) {
        val key = contextId to senderDeviceId
        expiries.remove(key)?.cancel()
        remove(key)
    }

    fun observe(contextId: String): Flow<List<String>> =
        typing.map { it[contextId].orEmpty().values.distinct().sorted() }.distinctUntilChanged()

    fun clear() = synchronized(lock) {
        expiries.values.forEach { it.cancel() }
        expiries.clear()
        lastSent.clear()
        typing.value = emptyMap()
    }

    private fun remove(key: Pair<String, String>) {
        expiries.remove(key)
        val (contextId, deviceId) = key
        typing.update { current ->
            val remaining = current[contextId].orEmpty() - deviceId
            if (remaining.isEmpty()) current - contextId else current + (contextId to remaining)
        }
    }

    companion object {
        const val EXPIRE_MS = 5_000L
        const val THROTTLE_MS = 2_000L
    }
}
