package dev.barrelmaker.obscura.kit.stores

import dev.barrelmaker.obscura.kit.newInMemoryDatabase
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class FriendStoreTest {

    private fun newDomain() = FriendStore(newInMemoryDatabase())

    @Test
    fun `add then get returns the friend`() = runTest {
        val d = newDomain()
        d.add("u1", "alice", FriendStatus.ACCEPTED)
        assertEquals(FriendData("u1", "alice", FriendStatus.ACCEPTED), d.get("u1"))
    }

    @Test
    fun `get returns null for a user who was never added`() = runTest {
        assertNull(newDomain().get("nope"))
    }

    @Test
    fun `getAll lists every friend in name order`() = runTest {
        val d = newDomain()
        d.add("u2", "bob", FriendStatus.PENDING_SENT)
        d.add("u1", "alice", FriendStatus.ACCEPTED)

        assertEquals(listOf("alice", "bob"), d.getAll().map { it.username })
    }

    @Test
    fun `updateStatus promotes in place without touching the name`() = runTest {
        val d = newDomain()
        d.add("u1", "alice", FriendStatus.PENDING_SENT)

        d.updateStatus("u1", FriendStatus.ACCEPTED)

        assertEquals(FriendData("u1", "alice", FriendStatus.ACCEPTED), d.get("u1"))
    }

    @Test
    fun `remove deletes only that friend`() = runTest {
        val d = newDomain()
        d.add("u1", "alice", FriendStatus.ACCEPTED)
        d.add("u2", "bob", FriendStatus.ACCEPTED)
        d.remove("u1")

        assertNull(d.get("u1"))
        assertEquals("bob", d.get("u2")!!.username)
    }

    @Test
    fun `request preparation preserves existing records and conditional cleanup never deletes accepted friendship`() = runTest {
        val d = newDomain()
        assertNull(d.prepareRequest("new", "alice"))
        assertEquals(FriendData("new", "alice", FriendStatus.PENDING_SENT), d.get("new"))
        d.removePendingRequest("new")
        assertNull(d.get("new"))
        d.add("accepted", "trusted name", FriendStatus.ACCEPTED)
        assertEquals(FriendData("accepted", "trusted name", FriendStatus.ACCEPTED), d.prepareRequest("accepted", "spoof"))
        d.removePendingRequest("accepted")
        assertEquals(FriendData("accepted", "trusted name", FriendStatus.ACCEPTED), d.get("accepted"))
    }
}
