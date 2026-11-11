package scenarios

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import dev.barrelmaker.obscura.kit.AuthState
import dev.barrelmaker.obscura.kit.LoginScenario
import dev.barrelmaker.obscura.kit.ObscuraClient
import dev.barrelmaker.obscura.kit.ObscuraError
import dev.barrelmaker.obscura.kit.ObscuraConfig
import dev.barrelmaker.obscura.kit.SubmissionStatus
import dev.barrelmaker.obscura.kit.wire.UuidCodec
import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import dev.barrelmaker.obscura.kit.auth.AuthManager
import dev.barrelmaker.obscura.kit.crypto.PreKeys
import dev.barrelmaker.obscura.kit.messaging.Messenger
import dev.barrelmaker.obscura.kit.messaging.parsePeerBundles
import dev.barrelmaker.obscura.kit.network.PreKeyCounts
import dev.barrelmaker.obscura.kit.network.PreKeyUpload
import dev.barrelmaker.obscura.kit.stores.FriendStatus
import kotlinx.coroutines.runBlocking
import obscura.client.v1.Client.ClientMessage
import obscura.client.v1.Client.DirectMessage
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

/** Contracts from the real server's auth, key, device and message services. */
class ServerContractTests {
    companion object {
        @JvmStatic
        @BeforeAll
        fun requireConfiguredServer() {
            assertFalse(System.getenv("OBSCURA_TEST_API").isNullOrBlank(), "OBSCURA_TEST_API must name the test server")
            java.net.URI("$API/openapi.yaml").toURL().openConnection().apply {
                connectTimeout = 5000
                readTimeout = 5000
            }.getInputStream().use { it.read() }
        }
    }

    private fun entry(id: String) = ClientMessage.newBuilder()
        .setDirectMessage(DirectMessage.newBuilder().setId(id).setContent(id)).build()

    // Alter only the access credential; the refresh credential is still issued by the real server.
    private fun expireAccess(client: ObscuraClient) {
        val current = client.auth.requireCredentials()
        AuthManager::class.java.getDeclaredField("credentials").apply { isAccessible = true }
            .set(client.auth, current.copy(token = "expired.token.sig", expiresAt = 1L))
    }

    @Test
    fun `pre-key sync rotates on schedule, refills a low supply, and old sessions still decrypt`(): Unit = runBlocking {
        val storage = MemoryStorage()
        val receiver = newClient(storage = storage)
        val inspector = newClient()
        receiver.register(uniqueName("refill"), TEST_PASSWORD)
        inspector.register(uniqueName("inspector"), TEST_PASSWORD)
        try {
            val sender = Messenger(inspector.signalStore, inspector.api) { inspector.deviceId }
            inspector.devices.add(receiver.userId!!, listOf(receiver.deviceId!!))
            val original = inspector.api.fetchPreKeyBundles(receiver.userId!!)
            val first = original.getJSONObject(0)
            val identity = first.getString("identityKey")
            val originalSignedId = first.getJSONObject("signedPreKey").getInt("keyId")
            val originalKyberId = first.getJSONObject("kyberPreKey").getInt("keyId")
            sender.establishSession(parsePeerBundles(original).single())
            val delayed = sender.prepareSubmission(receiver.deviceId!!, entry("delayed-before-rotation"))
            assertEquals(PreKeyCounts(PreKeys.BATCH_SIZE - 1, PreKeys.BATCH_SIZE - 1), receiver.api.fetchPreKeyCounts(),
                "the fetch used up one one-time key of each kind")

            // Two days since the last sync: connecting rotates the signed and last-resort keys.
            val state = receiver.signalStore.preKeyState()!!
            val longAgo = System.currentTimeMillis() - PreKeys.REFRESH_INTERVAL_MS - 1
            receiver.signalStore.savePreKeyState(state.copy(synced_at = longAgo, rotated_at = longAgo))
            receiver.preKeySyncSpacingMs = 0 // the refill below follows this sync within seconds
            receiver.connect()
            eventually(message = "rotated signed pre-key is active") {
                receiver.signalStore.preKeyState()!!.active_signed_id != originalSignedId.toLong()
            }
            val rotated = inspector.api.fetchPreKeyBundles(receiver.userId!!).getJSONObject(0)
            assertEquals(identity, rotated.getString("identityKey"))
            assertEquals(receiver.signalStore.preKeyState()!!.active_signed_id, rotated.getJSONObject("signedPreKey").getLong("keyId"))
            assertNotEquals(originalKyberId, rotated.getJSONObject("kyberPreKey").getInt("keyId"))
            assertTrue(receiver.signalStore.containsSignedPreKey(originalSignedId), "kept for messages in flight")

            // Leave the server only 5 of each kind. The delayed message, built on the original keys, still
            // decrypts after rotation, and as a pre-key message it makes the receiver refill both kinds,
            // refreshing its token on the way.
            val low = PreKeys.prepareRefill(receiver.signalStore, PreKeyCounts(0, 0), System.currentTimeMillis()).toUpload()
            receiver.api.uploadPreKeys(PreKeyUpload(null, null, low.oneTimePreKeys.take(5), low.kyberPreKeys.take(5)))
            assertEquals(PreKeyCounts(5, 5), receiver.api.fetchPreKeyCounts())
            val oldRefresh = storage.data!!.getValue("refreshToken")
            expireAccess(receiver)
            assertEquals(SubmissionStatus.ACCEPTED, sender.submit(receiver.userId!!, listOf(delayed)).submitted.single().result.status)
            receiver.awaitRow { it.id == "delayed-before-rotation" }
            eventually(message = "server-visible refill") {
                receiver.api.fetchPreKeyCounts() == PreKeyCounts(PreKeys.BATCH_SIZE, PreKeys.BATCH_SIZE)
            }
            assertNotEquals(oldRefresh, storage.data!!.getValue("refreshToken"))
            assertEquals(receiver.auth.requireCredentials().toMap(), storage.data)

            val fresh = registerAndConnect("fresh_signal")
            try {
                becomeFriends(fresh, receiver)
                sendText(fresh, receiver, "after automatic refill")
                receiver.awaitContent("after automatic refill")
            } finally { fresh.logout() }
        } finally { receiver.logout(); inspector.logout() }
    }

    @Test
    fun `a recipient whose every device is gone is rejected and forgotten`(): Unit = runBlocking {
        val alice = registerAndConnect("deleted_sender")
        try {
            val userId = UUID.randomUUID().toString()
            alice.devices.add(userId, listOf(UUID.randomUUID().toString()))
            suspend fun gone(text: String) = alice.sender.send(listOf(userId), entry(text))
            val results = gone("not deliverable")
            assertEquals(1, results.size)
            assertEquals(userId, results.single().userId)
            assertNull(results.single().deviceId)
            assertEquals(SubmissionStatus.REJECTED, results.single().status)
            assertEquals("No devices found", results.single().error)
            assertTrue(alice.devices.devicesOf(userId).isEmpty())
            assertEquals(SubmissionStatus.REJECTED, gone("no devices").single().status)
        } finally { alice.logout() }
    }

    @Test
    fun `attachment upload refreshes and durably rotates expired access credentials`(): Unit = runBlocking {
        val storage = MemoryStorage()
        val client = newClient(storage = storage)
        client.register(uniqueName("upload_refresh"), TEST_PASSWORD)
        try {
            val oldRefresh = storage.data!!.getValue("refreshToken")
            expireAccess(client)
            val upload = client.uploadAttachment("opaque plaintext".toByteArray())
            assertNotEquals(oldRefresh, storage.data!!.getValue("refreshToken"))
            assertEquals(client.auth.requireCredentials().toMap(), storage.data)
            assertEquals("opaque plaintext", String(client.downloadDecryptedAttachment(upload.id, upload.contentKey, upload.nonce)))
        } finally { client.logout() }
    }

    @Test
    fun `attachment download refreshes and server stores ciphertext rather than plaintext`(): Unit = runBlocking {
        val storage = MemoryStorage()
        val client = newClient(storage = storage)
        client.register(uniqueName("download_refresh"), TEST_PASSWORD)
        try {
            val plaintext = "opaque attachment".toByteArray()
            val upload = client.uploadAttachment(plaintext)
            assertFalse(plaintext.contentEquals(client.api.fetchAttachment(upload.id)))
            val oldRefresh = storage.data!!.getValue("refreshToken")
            expireAccess(client)
            assertArrayEquals(plaintext, client.downloadDecryptedAttachment(upload.id, upload.contentKey, upload.nonce))
            assertNotEquals(oldRefresh, storage.data!!.getValue("refreshToken"))
            assertEquals(client.auth.requireCredentials().toMap(), storage.data)
        } finally { client.logout() }
    }

    @Test
    fun `push registration refreshes expired access without promising push delivery`(): Unit = runBlocking {
        val storage = MemoryStorage()
        val client = newClient(storage = storage)
        client.register(uniqueName("push_refresh"), TEST_PASSWORD)
        try {
            val oldRefresh = storage.data!!.getValue("refreshToken")
            expireAccess(client)
            client.registerPushToken("contract-${UUID.randomUUID()}")
            assertNotEquals(oldRefresh, storage.data!!.getValue("refreshToken"))
            assertEquals(client.auth.requireCredentials().toMap(), storage.data)
        } finally { client.logout() }
    }

    @Test
    fun `101 valid encrypted submissions receive definitive HTTP 413 rejection`(): Unit = runBlocking {
        val alice = newClient()
        val bob = newClient()
        alice.register(uniqueName("batch_sender"), TEST_PASSWORD)
        bob.register(uniqueName("batch_target"), TEST_PASSWORD)
        try {
            val messenger = Messenger(alice.signalStore, alice.api) { alice.deviceId }
            alice.devices.add(bob.userId!!, listOf(bob.deviceId!!))
            messenger.establishSession(parsePeerBundles(alice.api.fetchPreKeyBundles(bob.userId!!)).single())
            val submissions = List(101) { messenger.prepareSubmission(bob.deviceId!!, entry("batch-$it")) }
            val results = messenger.submit(bob.userId!!, submissions).submitted.map { it.result }
            assertEquals(101, results.size)
            assertTrue(results.all { it.status == SubmissionStatus.REJECTED }, results.toString())
            assertTrue(results.all { it.error?.contains("413") == true })
            assertTrue(results.all { it.deviceId == bob.deviceId && it.userId == bob.userId })
        } finally { alice.logout(); bob.logout() }
    }

    @Test
    fun `wrong password on existing device differs from deleted or wrong owner device`(): Unit = runBlocking {
        val first = newClient()
        val second = newClient()
        first.register(uniqueName("login_device"), TEST_PASSWORD)
        second.register(uniqueName("login_owner"), TEST_PASSWORD)
        val firstName = first.username!!
        val secondName = second.username!!
        try {
            first.logout()
            assertEquals(LoginScenario.INVALID_CREDENTIALS, first.login(firstName, "$TEST_PASSWORD-wrong"))
            assertEquals(AuthState.LOGGED_OUT, first.authState.value)
            assertEquals(LoginScenario.DEVICE_MISMATCH, first.login(secondName, TEST_PASSWORD))
            assertEquals(AuthState.LOGGED_OUT, first.authState.value)
            assertEquals(LoginScenario.EXISTING_DEVICE, first.login(firstName, TEST_PASSWORD))
            first.logout()
            val resetKeys = dev.barrelmaker.obscura.kit.crypto.PreKeys.generateProvisioningKeys(
                org.signal.libsignal.protocol.IdentityKeyPair.generate()
            )
            first.api.resetAccount(firstName, TEST_PASSWORD, "replacement", resetKeys.toDeviceKeys())
            assertEquals(LoginScenario.DEVICE_MISMATCH, first.login(firstName, TEST_PASSWORD))
            assertEquals(AuthState.LOGGED_OUT, first.authState.value)
        } finally { first.logout(); second.logout() }
    }

    @Test
    fun `own metadata consumes no prekeys and established sends reuse their session`(): Unit = runBlocking {
        val alice = registerAndConnect("reuse_sender")
        val bob = registerAndConnect("reuse_target")
        becomeFriends(alice, bob)
        try {
            assertTrue(alice.signalStore.containsSession(Messenger.addressFor(bob.deviceId!!)), "the friend request started a session")
            val start = bob.api.fetchPreKeyCounts()
            repeat(3) { assertEquals(listOf(bob.deviceId), bob.api.fetchOwnDevices().map { it.deviceId }) }
            sendAndVerify(alice, bob, "first send")
            val session = alice.signalStore.loadSession(Messenger.addressFor(bob.deviceId!!)).serialize()
            sendAndVerify(alice, bob, "reused session")
            assertFalse(session.contentEquals(alice.signalStore.loadSession(Messenger.addressFor(bob.deviceId!!)).serialize()),
                "sending must advance the existing ratchet")
            assertEquals(start, bob.api.fetchPreKeyCounts(), "metadata and sends over an existing session consume no pre-keys")

            // A fetch, by contrast, uses up one of each kind.
            alice.api.fetchPreKeyBundles(bob.userId!!)
            assertEquals(PreKeyCounts(start.oneTime - 1, start.kyber - 1), bob.api.fetchPreKeyCounts())
        } finally { alice.logout(); bob.logout() }
    }

    @Test
    fun `failed local content persistence rolls back decrypt and redelivery persists exactly once`(): Unit = runBlocking {
        verifyReceiveRecovery("ConversationEntry")
    }

    @Test
    fun `failed local directory persistence rolls back decrypt and redelivery persists exactly once`(): Unit = runBlocking {
        verifyReceiveRecovery("Device")
    }

    /**
     * A database in a temporary file. These tests roll a receive back on purpose, and an in-memory
     * JDBC database shares one connection and one transaction across threads, so another coroutine's
     * transaction could commit the rolled-back writes. Android's driver and file databases keep each
     * thread's transaction to itself.
     */
    private fun fileDriver(): JdbcSqliteDriver =
        JdbcSqliteDriver("jdbc:sqlite:${java.io.File.createTempFile("obscura-test", ".db").apply { deleteOnExit() }.path}")

    private suspend fun verifyReceiveRecovery(table: String) {
        val driver = fileDriver()
        ObscuraDatabase.Schema.create(driver)
        val bob = ObscuraClient(ObscuraConfig(API, "durability"), driver, MemoryStorage())
        val alice = registerAndConnect("durable_sender")
        bob.register(uniqueName("durable_receiver"), TEST_PASSWORD)
        bob.connect()
        try {
            becomeFriends(alice, bob)
            // Use an established ratchet, not a repeated initial prekey message.
            sendAndVerify(alice, bob, "establish durable session")
            sendAndVerify(bob, alice, "acknowledge Signal session")
            bob.sweepExpired(now = Long.MAX_VALUE / 2)
            while (bob.messageReceived.tryReceive().isSuccess) { }
            driver.execute(null,
                "CREATE TRIGGER fail_contract_write BEFORE INSERT ON $table BEGIN SELECT RAISE(FAIL, 'contract disk failure'); END", 0)
            sendText(alice, bob, "recover after storage failure")
            eventually(message = "local durable insert rejection") {
                bob.getDebugLog().any { it.contains("contract disk failure") }
            }
            assertTrue(bob.getMessages().isEmpty())
            assertNull(bob.messageReceived.tryReceive().getOrNull())
            bob.disconnect()
            driver.execute(null, "DROP TRIGGER fail_contract_write", 0)
            bob.connect()
            val recovered = bob.awaitContent("recover after storage failure")
            assertEquals(alice.userId, recovered.authorUserId)
            assertEquals(1, bob.getMessages().size)
            assertEquals("directMessage", bob.messageReceived.tryReceive().getOrNull())
            assertNull(bob.messageReceived.tryReceive().getOrNull())
            bob.processPendingMessages(2_000)
            bob.disconnect()
            bob.sweepExpired(now = Long.MAX_VALUE / 2)
            val decryptFailures = bob.getDebugLog().count { it.contains("decrypt failed") }
            bob.connect()
            sendAndVerify(alice, bob, "after recovered ack")
            assertEquals(decryptFailures, bob.getDebugLog().count { it.contains("decrypt failed") })
            assertEquals(listOf("after recovered ack"), bob.getMessages().map { it.content })
        } finally { alice.logout(); bob.logout(); driver.close() }
    }

    private suspend fun sendRatchetPrimer(sender: ObscuraClient, receiver: ObscuraClient, text: String) {
        val id = "primer_${System.currentTimeMillis()}"
        sender.sender.sendOrThrow(
            receiver.userId!!,
            ClientMessage.newBuilder()
                .setTimestamp(System.currentTimeMillis())
                .setDirectMessage(
                    obscura.client.v1.Client.DirectMessage.newBuilder()
                        .setId(id)
                        .setPeerUserId(receiver.userId!!)
                        .setContent(text),
                )
                .build(),
        )
        assertEquals(sender.userId, receiver.awaitContent(text).authorUserId)
    }

    @Test
    fun `failed local friend request persistence recovers on real server redelivery`(): Unit = runBlocking {
        val driver = fileDriver()
        ObscuraDatabase.Schema.create(driver)
        val bob = ObscuraClient(ObscuraConfig(API, "friend durability"), driver, MemoryStorage())
        val alice = registerAndConnect("durable_friend_sender")
        bob.register(uniqueName("durable_friend_receiver"), TEST_PASSWORD)
        bob.connect()
        try {
            sendRatchetPrimer(alice, bob, "establish friendship ratchet")
            sendRatchetPrimer(bob, alice, "acknowledge friendship ratchet")
            driver.execute(null,
                "CREATE TRIGGER fail_contract_friend BEFORE INSERT ON Friend BEGIN SELECT RAISE(FAIL, 'contract friend disk failure'); END", 0)
            alice.addFriendByCode(bob.friendCode())
            eventually(message = "friend durable insert rejection") {
                bob.getDebugLog().any { it.contains("contract friend disk failure") }
            }
            assertNull(bob.friendStatus(alice.userId!!))
            bob.disconnect()
            driver.execute(null, "DROP TRIGGER fail_contract_friend", 0)
            bob.connect()
            eventually(message = "friend request recovered from server") {
                bob.friendStatus(alice.userId!!) == FriendStatus.PENDING_RECEIVED
            }
            bob.acceptFriend(alice.userId!!)
            eventually(message = "recovered friendship accepted") {
                alice.friendStatus(bob.userId!!) == FriendStatus.ACCEPTED
            }
            assertEquals(FriendStatus.ACCEPTED, bob.friendStatus(alice.userId!!))
        } finally { alice.logout(); bob.logout(); driver.close() }
    }

    @Test
    fun `refresh is single use durably persisted and retains device scope`(): Unit = runBlocking {
        val storage = MemoryStorage()
        val client = newClient(storage = storage)
        client.register(uniqueName("rotation"), TEST_PASSWORD)
        try {
            val before = storage.data!!
            client.auth.refresh()
            assertNotEquals(before.getValue("refreshToken"), storage.data!!.getValue("refreshToken"))
            assertEquals(client.auth.requireCredentials().toMap(), storage.data)
            assertEquals(before.getValue("deviceId"), storage.data!!.getValue("deviceId"))
            val replay = runCatching { client.api.refreshSession(before.getValue("refreshToken")) }.exceptionOrNull()
            assertTrue(replay is ObscuraError.Http && replay.status == 401, "old refresh must be spent: $replay")
            assertEquals(listOf(client.deviceId), client.api.fetchOwnDevices().map { it.deviceId })
            client.connect()
        } finally { client.logout() }
    }
}
