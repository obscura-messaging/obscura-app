import java.nio.file.Files
import java.nio.file.Path
import java.util.Collections
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import uniffi.obscura_core.CiphertextKind
import uniffi.obscura_core.CoreException
import uniffi.obscura_core.CoreLogger
import uniffi.obscura_core.SpikeClient
import uniffi.obscura_core.setLogger

class BindingsTest {
    @TempDir
    lateinit var dir: Path

    private val aliceKey = ByteArray(32) { 1 }
    private val bobKey = ByteArray(32) { 2 }

    private fun open(name: String, key: ByteArray) =
        SpikeClient.open(dir.resolve("$name.db").toString(), key, name, 1u)

    /** The sender needs its own identity before it can process the peer's bundle. */
    private fun establish(alice: SpikeClient, bob: SpikeClient) {
        alice.createIdentityAndBundle()
        alice.processBundle("bob", 1u, bob.createIdentityAndBundle())
    }

    @Test
    fun sessionRoundTripsBothWays() {
        open("alice", aliceKey).use { alice ->
            open("bob", bobKey).use { bob ->
                establish(alice, bob)

                val first = alice.encrypt("bob", 1u, "hi bob".toByteArray())
                assertEquals(CiphertextKind.PRE_KEY, first.kind)
                assertEquals("hi bob", String(bob.decrypt("alice", 1u, first)))

                val reply = bob.encrypt("alice", 1u, "hi alice".toByteArray())
                assertEquals(CiphertextKind.WHISPER, reply.kind)
                assertEquals("hi alice", String(alice.decrypt("bob", 1u, reply)))

                val second = alice.encrypt("bob", 1u, "again".toByteArray())
                assertEquals(CiphertextKind.WHISPER, second.kind)
                assertEquals("again", String(bob.decrypt("alice", 1u, second)))
            }
        }
    }

    @Test
    fun sessionSurvivesReopen() {
        open("alice", aliceKey).use { alice ->
            open("bob", bobKey).use { bob ->
                establish(alice, bob)
                bob.decrypt("alice", 1u, alice.encrypt("bob", 1u, "one".toByteArray()))
            }
        }
        open("alice", aliceKey).use { alice ->
            open("bob", bobKey).use { bob ->
                val reply = bob.encrypt("alice", 1u, "two".toByteArray())
                assertEquals("two", String(alice.decrypt("bob", 1u, reply)))
            }
        }
    }

    @Test
    fun wrongDatabaseKeyThrowsStorage() {
        open("alice", aliceKey).use { it.createIdentityAndBundle() }
        assertThrows<CoreException.Storage> { open("alice", bobKey) }
    }

    @Test
    fun invalidDeviceIdThrowsInvalidArgument() {
        assertThrows<CoreException.InvalidArgument> {
            SpikeClient.open(dir.resolve("x.db").toString(), aliceKey, "x", 0u)
        }
    }

    @Test
    fun kotlinLoggerReceivesLines() {
        val lines = Collections.synchronizedList(mutableListOf<String>())
        setLogger(object : CoreLogger {
            override fun log(message: String) {
                lines += message
            }
        })
        open("alice", aliceKey).use { it.createIdentityAndBundle() }
        assertTrue("opened store" in lines, "got $lines")
        assertTrue("generated identity" in lines, "got $lines")
    }

    @Test
    fun decryptAsyncSuspends() = runBlocking {
        open("alice", aliceKey).use { alice ->
            open("bob", bobKey).use { bob ->
                establish(alice, bob)
                val bytes = "async hello".toByteArray()
                val plaintext = bob.decryptAsync("alice", 1u, alice.encrypt("bob", 1u, bytes))
                assertArrayEquals(bytes, plaintext)

                val bad = alice.encrypt("bob", 1u, bytes).copy(bytes = ByteArray(8))
                assertThrows<CoreException> { runBlocking { bob.decryptAsync("alice", 1u, bad) } }
            }
        }
        assertTrue(Files.exists(dir.resolve("bob.db")))
    }
}
