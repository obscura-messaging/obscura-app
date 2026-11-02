package scenarios

import dev.barrelmaker.obscura.kit.ConnectionState
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** `processPendingMessages`, as a silent push wake calls it. */
class PushTests {

    @Test
    fun `a push drain connects, processes what was queued and stays connected`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("push_a")
        val bob = registerAndConnect("push_b")
        becomeFriends(alice, bob)
        bob.disconnect()

        for ((model, id) in listOf("model-a" to "a1", "model-a" to "a2", "model-b" to "b1")) {
            alice.send(listOf(bob.userId!!), model, id, System.currentTimeMillis(), "opaque-$id".toByteArray())
        }

        assertEquals(3, bob.processPendingMessages(timeoutMs = 10_000))
        assertEquals(ConnectionState.CONNECTED, bob.connectionState.value)
        assertEquals(listOf("model-a", "model-a", "model-b"), List(3) { bob.messageReceived.tryReceive().getOrNull() })
        assertEquals(3L, bob.inbox.depth())
        alice.disconnect(); bob.disconnect()
    }

    @Test
    fun `an empty drain on a live socket returns soon after reconnecting once`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("push_empty")

        val started = System.currentTimeMillis()
        assertEquals(0, alice.processPendingMessages(timeoutMs = 10_000))

        assertTrue(System.currentTimeMillis() - started < 5_000, "idle detection, not the full timeout")
        assertEquals(ConnectionState.CONNECTED, alice.connectionState.value)
        assertTrue(alice.getDebugLog().any { it.contains("PUSH nothing drained") })
        alice.disconnect()
    }
}
