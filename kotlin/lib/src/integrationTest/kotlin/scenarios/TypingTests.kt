package scenarios

import dev.barrelmaker.obscura.kit.TypingState
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class TypingTests {

    @Test
    fun `typing reaches exactly the named recipients and stops`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("typ_a")
        val bob = registerAndConnect("typ_b")
        val carol = registerAndConnect("typ_c")
        val dave = registerAndConnect("typ_d")
        becomeFriends(alice, bob)
        becomeFriends(alice, carol)
        becomeFriends(alice, dave)
        val context = "opaque-context"

        alice.sendTyping(listOf(bob.userId!!, carol.userId!!, alice.userId!!), context, TypingState.STARTED)

        for (client in listOf(bob, carol)) {
            withTimeout(15_000) { client.observeTyping(context).first { it == listOf(alice.userId!!) } }
        }
        assertNull(withTimeoutOrNull(3_000) { dave.observeTyping(context).first { it.isNotEmpty() } })

        alice.sendTyping(listOf(bob.userId!!), context, TypingState.STOPPED)
        withTimeout(15_000) { bob.observeTyping(context).first { it.isEmpty() } }
        assertEquals(0L, bob.inbox.depth(), "typing is never inboxed")

        listOf(alice, bob, carol, dave).forEach { it.disconnect() }
    }
}
