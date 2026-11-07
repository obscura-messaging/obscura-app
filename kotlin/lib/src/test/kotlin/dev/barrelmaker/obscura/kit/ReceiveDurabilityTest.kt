package dev.barrelmaker.obscura.kit

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.google.protobuf.ByteString
import dev.barrelmaker.obscura.kit.crypto.SignalStore
import dev.barrelmaker.obscura.kit.crypto.UuidCodec
import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import dev.barrelmaker.obscura.kit.managers.SignalKeyUtils
import dev.barrelmaker.obscura.kit.messaging.Messenger
import dev.barrelmaker.obscura.kit.messaging.parsePeerBundles
import dev.barrelmaker.obscura.kit.network.APIClient
import dev.barrelmaker.obscura.kit.stores.FriendStatus
import dev.barrelmaker.obscura.kit.stores.FriendStore
import kotlinx.coroutines.runBlocking
import obscura.client.v1.Client.ClientMessage
import obscura.client.v1.Client.DirectMessage
import org.json.JSONArray
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import xyz.obscura.server.contracts.ObscuraProtocol.Envelope
import java.util.UUID

class ReceiveDurabilityTest {
    private val peerUser = UUID.randomUUID().toString()
    private val peerDevice = UUID.randomUUID().toString()

    private suspend fun fixture(malformedPlaintext: Boolean = false, incoming: ClientMessage? = null): Triple<ObscuraClient, JdbcSqliteDriver, Envelope> {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        ObscuraDatabase.Schema.create(driver)
        val c = ObscuraClient(ObscuraConfig("http://127.0.0.1:1", "test"), driver, storedSession())
        val keys = SignalKeyUtils.generateProvisioningKeys(org.signal.libsignal.protocol.IdentityKeyPair.generate())
        SignalKeyUtils.install(c.signalStore, keys)
        c.storeLocalDevice()
        assertTrue(c.auth.restore())
        val senderDb = newInMemoryDatabase().apply { deviceQueries.insert(SELF_USER_ID, SELF_DEVICE_ID) }
        val sender = SignalStore(senderDb).also { it.generateIdentity() }
        val messenger = Messenger(sender, APIClient("http://127.0.0.1:1") { null })
        messenger.establishSession(parsePeerBundles(JSONArray().put(keys.bundle(SELF_DEVICE_ID))).single())
        val message = incoming ?: ClientMessage.newBuilder().setTimestamp(1).setDirectMessage(
            DirectMessage.newBuilder()
                .setId("entry")
                .setPeerUserId(SELF_USER_ID)
                .setContent("""{"deviceId":"payload-is-not-discovery"}"""),
        ).build()
        val encrypted = if (malformedPlaintext) {
            val ciphertext = org.signal.libsignal.protocol.SessionCipher(sender, Messenger.addressFor(SELF_DEVICE_ID))
                .encrypt(byteArrayOf(-1, -1, -1))
            obscura.client.v1.Client.EncryptedMessage.newBuilder()
                .setType(obscura.client.v1.Client.EncryptedMessage.Type.TYPE_PREKEY_MESSAGE)
                .setContent(ByteString.copyFrom(ciphertext.serialize())).build().toByteString()
        } else messenger.prepareSubmission(SELF_DEVICE_ID, message).message
        val envelope = Envelope.newBuilder()
            .setId(UuidCodec.uuidToBytes(UUID.randomUUID()))
            .setSenderUserId(UuidCodec.uuidToBytes(UUID.fromString(peerUser)))
            .setSenderDeviceId(UuidCodec.uuidToBytes(UUID.fromString(peerDevice)))
            .setMessage(encrypted).build()
        return Triple(c, driver, envelope)
    }

    @Test fun `local friend request and accept writes commit with decrypt or remain recoverable`() = runBlocking {
        for (accept in listOf(false, true)) {
            val message = if (accept) ClientMessage.newBuilder().setFriendAccept(obscura.client.v1.friendAccept {}).build()
                else ClientMessage.newBuilder().setFriendRequest(obscura.client.v1.friendRequest { username = "peer" }).build()
            val (c, driver, envelope) = fixture(incoming = message)
            val friends = FriendStore(c.db)
            if (accept) friends.add(peerUser, "peer", FriendStatus.PENDING_SENT)
            val operation = if (accept) "UPDATE" else "INSERT"
            driver.execute(null, "CREATE TRIGGER fail_friend BEFORE $operation ON Friend BEGIN SELECT RAISE(FAIL, 'friend disk unavailable'); END", 0)
            var acks = 0
            c.receive(envelope) { acks++ }
            assertEquals(0, acks)
            assertEquals(if (accept) FriendStatus.PENDING_SENT else null, friends.get(peerUser)?.status)
            assertTrue(c.devices.devicesOf(peerUser).isEmpty())
            driver.execute(null, "DROP TRIGGER fail_friend", 0)
            c.receive(envelope) { acks++ }
            assertEquals(1, acks)
            assertEquals(if (accept) FriendStatus.ACCEPTED else FriendStatus.PENDING_RECEIVED, friends.get(peerUser)?.status)
            c.auth.end()
            driver.close()
        }
    }

    @Test fun `successful decrypt adds stamped sender additively before persist then ack`() = runBlocking {
        val (c, driver, envelope) = fixture()
        val old = UUID.randomUUID().toString()
        c.devices.add(peerUser, listOf(old))
        var acks = 0
        c.receive(envelope) {
            assertEquals(1, c.getMessages().size)
            assertEquals(setOf(old, peerDevice), c.devices.devicesOf(peerUser).toSet())
            acks++
        }
        assertEquals(1, acks)
        assertEquals(peerUser, c.getMessages().single().authorUserId)
        c.auth.end()
        driver.close()
    }

    @Test fun `a persisted ciphertext redelivery acks without decrypting twice or waking twice`() = runBlocking {
        val (c, driver, envelope) = fixture()
        var acks = 0
        c.receive(envelope) { acks++ }
        c.receive(envelope) { acks++ }
        assertEquals(2, acks)
        assertEquals(1, c.getMessages().size)
        assertEquals("directMessage", c.messageReceived.tryReceive().getOrNull())
        assertNull(c.messageReceived.tryReceive().getOrNull())
        c.auth.end()
        driver.close()
    }

    @Test fun `failed decrypt and malformed sender never add directory evidence or ack`() = runBlocking {
        val (c, driver, envelope) = fixture()
        var acks = 0
        c.receive(envelope.toBuilder().setMessage(ByteString.copyFromUtf8("corrupt")).build()) { acks++ }
        c.receive(envelope.toBuilder().clearSenderDeviceId().build()) { acks++ }
        assertEquals(0, acks)
        assertTrue(c.devices.devicesOf(peerUser).isEmpty())
        assertTrue(c.getMessages().isEmpty())
        c.auth.end()
        driver.close()
    }

    @Test fun `durable directory and content failures both withhold ack`() = runBlocking {
        for (table in listOf("Device", "ConversationEntry", "ProcessedEnvelope")) {
            val (c, driver, envelope) = fixture()
            driver.execute(null, "CREATE TRIGGER fail_write BEFORE INSERT ON $table BEGIN SELECT RAISE(FAIL, 'disk unavailable'); END", 0)
            var acks = 0
            c.receive(envelope) { acks++ }
            assertEquals(0, acks, table)
            assertTrue(c.getMessages().isEmpty())
            assertTrue(c.getDebugLog().any { it.contains("not stored") })
            assertTrue(c.devices.devicesOf(peerUser).isEmpty(), "failed receive must roll back directory evidence")
            driver.execute(null, "DROP TRIGGER fail_write", 0)
            c.receive(envelope) { acks++ }
            assertEquals(1, acks, "redelivery after a durable failure must remain decryptable")
            assertEquals(1, c.getMessages().size)
            assertEquals(listOf(peerDevice), c.devices.devicesOf(peerUser))
            c.auth.end()
            driver.close()
        }
    }

    @Test fun `authenticated plaintext that is not a client message is acked and dropped`() = runBlocking {
        val (c, driver, envelope) = fixture(malformedPlaintext = true)
        var acks = 0
        c.receive(envelope) { acks++ }
        assertEquals(listOf(peerDevice), c.devices.devicesOf(peerUser))
        assertEquals(1, acks)
        assertTrue(c.getMessages().isEmpty())
        assertTrue(c.getDebugLog().any { it.contains("invalid client message") })
        c.auth.end()
        driver.close()
    }

    @Test fun `a redelivery of a message already swept is acked without a decrypt failure`() = runBlocking {
        val (c, driver, envelope) = fixture()
        var acks = 0
        c.receive(envelope) { acks++ }
        c.sweepExpired(now = Long.MAX_VALUE / 2)

        c.receive(envelope) { acks++ }

        assertEquals(2, acks)
        assertTrue(c.getMessages().isEmpty())
        assertFalse(c.getDebugLog().any { it.contains("decrypt failed") })
        c.auth.end()
        driver.close()
    }

    @Test fun `duplicate Signal ciphertext, ack failure, followUp failure, prekey replenish failure, and database error branches`() = runBlocking {
        // Exercise all NoOpLogger methods directly
        NoOpLogger.log("msg")
        NoOpLogger.decryptFailed("u", "r")
        NoOpLogger.ackFailed("e", "r")
        NoOpLogger.tokenRefreshFailed(1, "r")
        NoOpLogger.preKeyReplenishFailed("r")
        NoOpLogger.identityChanged("u")
        NoOpLogger.databaseError("s", "op", "r")

        // 1. Logged-out client properties, isPrimary on unprovisioned client, and signalStore.onIdentityChanged callback
        val unprov = newClient()
        assertNull(unprov.userId)
        assertNull(unprov.deviceId)
        assertNull(unprov.username)
        assertFalse(unprov.isPrimary())
        assertNotNull(unprov.sender)
        assertTrue(runCatching { unprov.api.fetchGatewayTicket() }.exceptionOrNull() is ObscuraError.NotAuthenticated)

        unprov.db.deviceQueries.insert(peerUser, peerDevice)
        unprov.signalStore.saveIdentity(Messenger.addressFor(peerDevice), org.signal.libsignal.protocol.IdentityKeyPair.generate().publicKey)
        unprov.signalStore.saveIdentity(Messenger.addressFor(peerDevice), org.signal.libsignal.protocol.IdentityKeyPair.generate().publicKey)
        assertTrue(unprov.getDebugLog().any { it.contains("IDENTITY changed for $peerUser") })

        // 2. Malformed envelope IDs (missing id or missing senderUserId), duplicate ciphertext with new envelopeId, and ack failure
        val (c, driver, envelope) = fixture()
        var acks = 0
        c.receive(envelope.toBuilder().clearId().build()) { acks++ }
        c.receive(envelope.toBuilder().clearSenderUserId().build()) { acks++ }
        assertEquals(0, acks)

        // First receive with failing ack (null exception message to cover reason() fallback)
        c.receive(envelope) { throw RuntimeException() }
        assertTrue(c.getDebugLog().any { it.contains("RECV ack failed") })

        // Same Signal ciphertext in a new envelope ID triggers DuplicateMessageException and acks
        val newEnvId = Envelope.newBuilder(envelope).setId(UuidCodec.uuidToBytes(UUID.randomUUID())).build()
        c.receive(newEnvId) { acks++ }
        assertEquals(1, acks)
        assertTrue(c.getDebugLog().any { it.contains("redelivered envelope") })

        // Prekey count below 20 after decrypt triggers background replenishPreKeys which fails and calls logger.preKeyReplenishFailed
        val (cLow, driverLow, envLow) = fixture()
        val replenishFailures = kotlinx.coroutines.CompletableDeferred<String>()
        cLow.logger = object : ObscuraLogger by NoOpLogger {
            override fun preKeyReplenishFailed(reason: String) {
                replenishFailures.complete(reason)
            }
        }
        for (id in 2..90) cLow.signalStore.removePreKey(id)
        cLow.receive(envLow) { acks++ }
        kotlinx.coroutines.withTimeout(5_000) {
            assertTrue(replenishFailures.await().isNotBlank())
        }
        cLow.auth.end()
        driverLow.close()

        // 3. Sender device registered to a different user triggers ProtocolViolation in directory stage
        val (cConflict, driverConflict, envConflict) = fixture()
        cConflict.devices.add(UUID.randomUUID().toString(), listOf(peerDevice))
        cConflict.receive(envConflict) { acks++ }
        assertTrue(cConflict.getDebugLog().any { it.contains("RECV decrypt failed") })
        cConflict.auth.end()
        driverConflict.close()

        // 4. followUp failure inside receive() (incoming FRIEND_REQUEST from ACCEPTED peer when sendFriendAccept fails)
        val friendReqMsg = ClientMessage.newBuilder().setFriendRequest(obscura.client.v1.friendRequest { username = "peer" }).build()
        val (cFollow, driverFollow, envFollow) = fixture(incoming = friendReqMsg)
        FriendStore(cFollow.db).add(peerUser, "peer", FriendStatus.ACCEPTED)
        var followAcks = 0
        cFollow.receive(envFollow) { followAcks++ }
        assertEquals(0, followAcks)
        assertTrue(cFollow.getDebugLog().any { it.contains("RECV FRIEND_REQUEST not stored") })
        cFollow.auth.end()
        driverFollow.close()

        // 5. containsEnvelope database failure
        driver.execute(null, "DROP TABLE ProcessedEnvelope", 0)
        val freshEnv = Envelope.newBuilder(envelope).setId(UuidCodec.uuidToBytes(UUID.randomUUID())).build()
        c.receive(freshEnv) { acks++ }
        assertTrue(c.getDebugLog().any { it.contains("RECV duplicate lookup failed") })
        c.auth.end()
        driver.close()
    }
}
