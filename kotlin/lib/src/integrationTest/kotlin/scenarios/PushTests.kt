package scenarios

import dev.barrelmaker.obscura.kit.ConnectionState
import dev.barrelmaker.obscura.kit.EntryModel
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

        alice.sendMessage(bob.userId!!, "a1")
        alice.sendMessage(bob.userId!!, "a2")
        alice.postStory("b1", null, null)

        assertEquals(3, bob.processPendingMessages(timeoutMs = 10_000))
        assertEquals(ConnectionState.CONNECTED, bob.connectionState.value)
        assertEquals(listOf(EntryModel.DIRECT_MESSAGE, EntryModel.DIRECT_MESSAGE, EntryModel.STORY), List(3) { bob.messageReceived.tryReceive().getOrNull() })
        assertEquals(2, bob.getMessages().size)
        assertEquals(1, bob.getStories().size)
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
