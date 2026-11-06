package scenarios

import dev.barrelmaker.obscura.kit.ConnectionState
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class ConnectionTests {

    @Test
    fun `concurrent connects share one socket and messaging survives reconnect cycles`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("conn_a")
        val bob = registerAndConnect("conn_b")
        becomeFriends(alice, bob)
        sendAndVerify(alice, bob, "before")

        repeat(3) {
            alice.disconnect()
            assertEquals(ConnectionState.DISCONNECTED, alice.connectionState.value)
            List(3) { async { alice.connect() } }.awaitAll()
            assertEquals(ConnectionState.CONNECTED, alice.connectionState.value)
        }
        bob.disconnect()
        bob.connect()

        sendAndVerify(alice, bob, "after alice cycles")
        sendAndVerify(bob, alice, "after bob reconnect")
        alice.disconnect(); bob.disconnect()
    }
}
