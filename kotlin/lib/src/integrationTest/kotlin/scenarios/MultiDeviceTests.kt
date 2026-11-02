package scenarios

import dev.barrelmaker.obscura.kit.AuthState
import dev.barrelmaker.obscura.kit.LoginScenario
import dev.barrelmaker.obscura.kit.ObscuraError
import dev.barrelmaker.obscura.kit.stores.ConversationItemData
import dev.barrelmaker.obscura.kit.stores.FriendStatus
import dev.barrelmaker.obscura.kit.stores.ProfileItemData
import dev.barrelmaker.obscura.kit.stores.STORY_MAX_AGE_MS
import dev.barrelmaker.obscura.kit.stores.StoryItemData
import dev.barrelmaker.obscura.kit.stores.expiresAt
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** One account, a primary and linked devices: linking, fanout, the friend list, unlinking and reset. */
class MultiDeviceTests {
    @Test
    fun `two devices linked by code string share the identity and messages flow to all three`() = runBlocking {
        requireServer()
        val alice1 = registerAndConnect("md_alice", newClient(deviceName = "Alice Phone"))
        val bob = registerAndConnect("md_bob")
        becomeFriends(alice1, bob)
        val alice2 = linkDevice(alice1, "Alice Tablet")
        val alice3 = linkDevice(alice1, "Alice Laptop")
        for (linked in listOf(alice2, alice3)) {
            assertEquals(alice1.userId, linked.userId)
            assertFalse(linked.isPrimary())
            assertArrayEquals(alice1.signalStore.identityKeyPair.serialize(), linked.signalStore.identityKeyPair.serialize())
        }

        sendText(bob, alice1, "hello all three")
        for (alice in listOf(alice1, alice2, alice3)) {
            assertEquals(bob.userId, alice.awaitContent("hello all three").authorUserId)
        }

        sendText(alice2, bob, "from the tablet")
        bob.awaitContent("from the tablet")
        assertEquals(alice1.userId, alice1.awaitContent("from the tablet").authorUserId)
        assertEquals(alice1.userId, alice3.awaitContent("from the tablet").authorUserId)
        alice1.disconnect(); alice2.disconnect(); alice3.disconnect(); bob.disconnect()
    }

    @Test
    fun `a friend change on the primary reaches its linked devices`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("sync_alice")
        val bob = registerAndConnect("sync_bob")
        val carol = registerAndConnect("sync_carol")
        becomeFriends(alice, bob)
        val tablet = linkDevice(alice, "Alice Tablet")
        assertEquals(listOf(bob.userId), tablet.getFriends().map { it.userId }, "the link carries the friend list")

        alice.addFriendByCode(carol.friendCode())
        eventually(message = "pending request synced") { tablet.friendStatus(carol.userId!!) == FriendStatus.PENDING_SENT }
        eventually(message = "request at carol") { carol.friendStatus(alice.userId!!) == FriendStatus.PENDING_RECEIVED }
        carol.acceptFriend(alice.userId!!)
        eventually(message = "acceptance synced") { tablet.friendStatus(carol.userId!!) == FriendStatus.ACCEPTED }

        alice.removeFriend(bob.userId!!)
        eventually(message = "removal synced") { tablet.friendStatus(bob.userId!!) == null }
        assertEquals(alice.getFriends(), tablet.getFriends())
        alice.disconnect(); bob.disconnect(); carol.disconnect(); tablet.disconnect()
    }

    @Test
    fun `a connected primary reaches a device linked after it on its next self sync`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("late_alice")
        val bob = registerAndConnect("late_bob")
        becomeFriends(alice, bob)
        assertEquals(listOf(alice.deviceId), alice.devices.devicesOf(alice.userId!!))

        val tablet = linkDevice(alice, "Alice Tablet")
        sendText(alice, bob, "after linking")

        assertEquals(alice.userId, tablet.awaitContent("after linking").authorUserId)
        bob.awaitContent("after linking")
        alice.disconnect(); bob.disconnect(); tablet.disconnect()
    }

    @Test
    fun `a linked device is refused friend changes and ignores friend requests`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("refuse_alice")
        val bob = registerAndConnect("refuse_bob")
        val tablet = linkDevice(alice, "Alice Tablet")

        for (call in listOf<suspend () -> Unit>(
            { tablet.addFriendByCode(bob.friendCode()) },
            { tablet.acceptFriend(bob.userId!!) },
            { tablet.removeFriend(bob.userId!!) },
            { tablet.approveLink("code") },
        )) assertTrue(runCatching { call() }.exceptionOrNull() is ObscuraError.NotPrimary)

        bob.addFriendByCode(alice.friendCode())
        eventually(message = "request at the primary") { alice.friendStatus(bob.userId!!) == FriendStatus.PENDING_RECEIVED }
        eventually(message = "request seen by the linked device") {
            tablet.getDebugLog().any { it.contains("FRIEND_REQUEST from ${bob.userId} on a linked device") }
        }
        assertNull(tablet.friendStatus(bob.userId!!))
        alice.disconnect(); bob.disconnect(); tablet.disconnect()
    }

    @Test
    fun `a device linked mid-conversation is discovered through the server's mismatch`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("mid_alice")
        val bob = registerAndConnect("mid_bob")
        becomeFriends(alice, bob)
        sendAndVerify(bob, alice, "before linking")
        assertEquals(listOf(alice.deviceId), bob.devices.devicesOf(alice.userId!!))

        val tablet = linkDevice(alice, "Alice Tablet")
        sendText(bob, alice, "after linking")

        alice.awaitContent("after linking")
        tablet.awaitContent("after linking")
        assertEquals(setOf(alice.deviceId, tablet.deviceId), bob.devices.devicesOf(alice.userId!!).toSet())
        alice.disconnect(); bob.disconnect(); tablet.disconnect()
    }

    @Test
    fun `an unlinked device is logged out and its next login is a device mismatch`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("unlink_alice")
        val tablet = linkDevice(alice, "Alice Tablet")
        val laptop = linkDevice(alice, "Alice Laptop")
        assertTrue(runCatching { alice.unlinkDevice(alice.deviceId!!) }.exceptionOrNull() is ObscuraError.InvalidArgument)
        assertTrue(runCatching { tablet.unlinkDevice(laptop.deviceId!!) }.exceptionOrNull() is ObscuraError.NotPrimary)

        alice.unlinkDevice(tablet.deviceId!!)
        eventually(timeoutMs = 30_000, message = "unlinked device logged out") { tablet.authState.value == AuthState.LOGGED_OUT }
        assertEquals(LoginScenario.DEVICE_MISMATCH, tablet.login(alice.username!!, TEST_PASSWORD))

        laptop.unlinkDevice(laptop.deviceId!!)
        assertEquals(AuthState.LOGGED_OUT, laptop.authState.value)
        assertNull(laptop.devices.getIdentity())
        assertEquals(LoginScenario.LINK_REQUIRED, laptop.login(alice.username!!, TEST_PASSWORD))
        assertEquals(listOf(alice.deviceId), alice.devices().map { it.deviceId })
        alice.disconnect()
    }

    @Test
    fun `a reset account is seen by a peer as an identity change`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("reset_alice")
        val bob = registerAndConnect("reset_bob")
        val changes = IdentityChanges()
        bob.logger = changes
        becomeFriends(alice, bob)
        sendAndVerify(alice, bob, "before reset")
        sendAndVerify(bob, alice, "reply before reset")

        val username = alice.username!!
        alice.resetAccount(username, TEST_PASSWORD)
        alice.connect()

        // The old device is invalid and the mismatch names the new primary, all in this one send.
        sendText(bob, alice, "after reset")
        assertEquals(listOf(alice.deviceId), bob.devices.devicesOf(alice.userId!!))
        alice.awaitContent("after reset")
        assertEquals(listOf(alice.userId), changes.users)
        alice.disconnect(); bob.disconnect()
    }

    @Test
    fun `a newly linked device has the primary's history`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("history_alice")
        val messages = (1..3).map {
            ConversationItemData(
                id = "e$it",
                peerUserId = "019f025a-0000-7de6-84b6-000000000002",
                kind = "message",
                authorUserId = alice.userId!!,
                sentAt = 1_000L + it,
                viewedAt = null,
                expiresAt = expiresAt(1_000L + it, null),
                content = "msg $it",
                undelivered = true,
            )
        }
        messages.forEach { alice.content.putConversation(it) }
        val story = StoryItemData("s1", alice.userId!!, 5_000L, 5_000L + STORY_MAX_AGE_MS, "story 1")
        alice.content.putStory(story)
        val profile = ProfileItemData(alice.userId!!, alice.deviceId!!, 6_000L, "Alice", "Bio")
        alice.content.putProfile(profile)

        val tablet = linkDevice(alice, "Alice Tablet")

        assertEquals(messages.map { it.copy(undelivered = false) }, tablet.getMessages())
        assertEquals(listOf(story), tablet.getStories(now = 0))
        assertEquals(listOf(profile), tablet.getProfiles())
        alice.disconnect(); tablet.disconnect()
    }
}
