package scenarios

import dev.barrelmaker.obscura.kit.ObscuraError
import dev.barrelmaker.obscura.kit.stores.FriendStatus
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import obscura.client.v1.Client.ClientMessage
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class FriendTests {

    @Test
    fun `a friend code befriends, names come from the request, and accepting completes both sides`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("fc_a")
        val bob = registerAndConnect("fc_b")

        alice.addFriendByCode(" ${bob.friendCode()}\n")
        assertEquals(FriendStatus.PENDING_SENT, alice.friendStatus(bob.userId!!))
        eventually { bob.friendStatus(alice.userId!!) == FriendStatus.PENDING_RECEIVED }
        assertEquals(alice.username, bob.getFriends().single().username)

        bob.acceptFriend(alice.userId!!)
        eventually { alice.friendStatus(bob.userId!!) == FriendStatus.ACCEPTED }
        assertEquals(FriendStatus.ACCEPTED, bob.friendStatus(alice.userId!!))
        assertEquals(bob.username, alice.getFriends().single().username)
        assertEquals(0L, alice.inbox.depth() + bob.inbox.depth(), "friend messages are not inboxed")

        // Rescanning an accepted friend changes nothing.
        alice.addFriendByCode(bob.friendCode())
        assertEquals(FriendStatus.ACCEPTED, alice.friendStatus(bob.userId!!))
        alice.disconnect(); bob.disconnect()
    }

    @Test
    fun `crossed requests become a friendship`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("cross_a")
        val bob = registerAndConnect("cross_b")

        alice.befriend(bob.userId!!, bob.username!!)
        eventually { bob.friendStatus(alice.userId!!) == FriendStatus.PENDING_RECEIVED }
        bob.befriend(alice.userId!!, alice.username!!)

        eventually { alice.friendStatus(bob.userId!!) == FriendStatus.ACCEPTED }
        assertEquals(FriendStatus.ACCEPTED, bob.friendStatus(alice.userId!!))
        alice.disconnect(); bob.disconnect()
    }

    @Test
    fun `an accepted friend cannot rename itself or reset its status`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("fgi_alice")
        val mallory = registerAndConnect("fgi_mallory")
        becomeFriends(mallory, alice)
        val realName = alice.getFriends().single().username

        mallory.sender.sendOrThrow(alice.userId!!, ClientMessage.newBuilder()
            .setFriendRequest(obscura.client.v1.friendRequest { username = "Mum" }).build())
        eventually { alice.getDebugLog().any { it.contains("FRIEND_REQUEST from known peer") } }

        assertEquals(realName, alice.getFriends().single().username)
        assertEquals(FriendStatus.ACCEPTED, alice.friendStatus(mallory.userId!!))
        alice.disconnect(); mallory.disconnect()
    }

    @Test
    fun `an unsolicited acceptance creates no friend`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("fgi_victim")
        val stranger = registerAndConnect("fgi_stranger")

        stranger.sender.sendOrThrow(alice.userId!!, ClientMessage.newBuilder()
            .setFriendAccept(obscura.client.v1.friendAccept {}).build())
        eventually { alice.getDebugLog().any { it.contains("FRIEND_ACCEPT from") } }

        assertNull(alice.friendStatus(stranger.userId!!))
        alice.disconnect(); stranger.disconnect()
    }

    @Test
    fun `a removed friend is forgotten locally and can be befriended again`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("rm_a")
        val bob = registerAndConnect("rm_b")
        becomeFriends(alice, bob)

        alice.removeFriend(bob.userId!!)
        assertNull(alice.friendStatus(bob.userId!!))
        delay(500)
        assertEquals(FriendStatus.ACCEPTED, bob.friendStatus(alice.userId!!))

        alice.befriend(bob.userId!!, bob.username!!)
        eventually { alice.friendStatus(bob.userId!!) == FriendStatus.ACCEPTED }
        assertEquals(FriendStatus.ACCEPTED, bob.friendStatus(alice.userId!!))
        alice.disconnect(); bob.disconnect()
    }

    @Test
    fun `befriending yourself is rejected`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("self")
        assertThrows(ObscuraError.InvalidArgument::class.java) { runBlocking { alice.addFriendByCode(alice.friendCode()) } }
        alice.disconnect()
    }

    @Test
    fun `accepting a request that does not exist is rejected, and sending to a ghost fails`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("ghost")
        val ghost = java.util.UUID.randomUUID().toString()
        assertThrows(ObscuraError.InvalidArgument::class.java) { runBlocking { alice.acceptFriend(ghost) } }
        val error = runCatching { alice.befriend(ghost, "ghost") }.exceptionOrNull()
        assertEquals("SEND_FAILED", (error as ObscuraError).code)
        assertNull(alice.friendStatus(ghost))
        alice.disconnect()
    }
}
