package scenarios

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import dev.barrelmaker.obscura.kit.AuthState
import dev.barrelmaker.obscura.kit.LoginScenario
import dev.barrelmaker.obscura.kit.ObscuraClient
import dev.barrelmaker.obscura.kit.ObscuraError
import dev.barrelmaker.obscura.kit.ObscuraConfig
import dev.barrelmaker.obscura.kit.SubmissionStatus
import dev.barrelmaker.obscura.kit.crypto.UuidCodec
import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import dev.barrelmaker.obscura.kit.managers.AuthManager
import dev.barrelmaker.obscura.kit.messaging.Messenger
import dev.barrelmaker.obscura.kit.messaging.parsePeerBundles
import dev.barrelmaker.obscura.kit.stores.FriendStatus
import kotlinx.coroutines.runBlocking
import obscura.client.v1.Client.ClientMessage
import obscura.client.v1.appEntry
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.Base64
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
        .setAppEntry(appEntry { model = "contract"; this.id = id }).build()

    // Alter only the access credential; the refresh credential is still issued by the real server.
    private fun expireAccess(client: ObscuraClient) {
        val current = client.auth.requireCredentials()
        AuthManager::class.java.getDeclaredField("credentials").apply { isAccessible = true }
            .set(client.auth, current.copy(token = "expired.token.sig", expiresAt = 1L))
    }

    @Test
    fun `gateway refills twice with rotated signed keys new one time keys and working Signal sessions`(): Unit = runBlocking {
        val storage = MemoryStorage()
        val receiver = newClient(storage = storage)
        val inspector = newClient()
        receiver.register(uniqueName("refill"), TEST_PASSWORD)
        inspector.register(uniqueName("inspector"), TEST_PASSWORD)
        try {
            val sender = Messenger(inspector.signalStore, inspector.api)
            inspector.devices.add(receiver.userId!!, listOf(receiver.deviceId!!))
            val original = inspector.api.fetchPreKeyBundles(receiver.userId!!)
            val first = original.getJSONObject(0)
            val identity = first.getString("identityKey")
            val originalSignedId = first.getJSONObject("signedPreKey").getInt("keyId")
            sender.establishSession(parsePeerBundles(original).single())
            val delayed = sender.prepareSubmission(receiver.deviceId!!, entry("delayed-before-rotation"))

            // Drain while offline so the gateway's on-connect PREKEY_STATUS must cause the upload.
            var empty = false
            repeat(100) {
                if (!empty) empty = inspector.api.fetchPreKeyBundles(receiver.userId!!)
                    .getJSONObject(0).optJSONObject("oneTimePreKey") == null
            }
            assertTrue(empty, "provisioning must have at most 100 one-time keys")
            receiver.connect()
            var rotated = first
            eventually(message = "server-visible automatic refill") {
                rotated = inspector.api.fetchPreKeyBundles(receiver.userId!!).getJSONObject(0)
                rotated.getJSONObject("signedPreKey").getInt("keyId") > originalSignedId &&
                    (rotated.optJSONObject("oneTimePreKey")?.getInt("keyId") ?: 0) > 100
            }
            val secondSignedId = rotated.getJSONObject("signedPreKey").getInt("keyId")
            assertEquals(identity, rotated.getString("identityKey"))
            assertTrue(receiver.signalStore.containsSignedPreKey(originalSignedId))
            assertEquals(SubmissionStatus.ACCEPTED,
                sender.submit(receiver.userId!!, listOf(delayed)).submitted.single().result.status)
            receiver.awaitRow { it.entryId == "delayed-before-rotation" }

            // Consumption while connected must trigger another advisory-driven refill, including refresh.
            val oldRefresh = storage.data!!.getValue("refreshToken")
            val highestBefore = receiver.signalStore.getHighestPreKeyId()
            expireAccess(receiver)
            var newest = rotated
            eventually(message = "second server-visible automatic refill") {
                newest = inspector.api.fetchPreKeyBundles(receiver.userId!!).getJSONObject(0)
                newest.getJSONObject("signedPreKey").getInt("keyId") > secondSignedId &&
                    (newest.optJSONObject("oneTimePreKey")?.getLong("keyId") ?: 0) > highestBefore
            }
            assertEquals(identity, newest.getString("identityKey"))
            assertNotEquals(oldRefresh, storage.data!!.getValue("refreshToken"))
            assertEquals(receiver.auth.requireCredentials().toMap(), storage.data)
            assertTrue(receiver.signalStore.containsSignedPreKey(originalSignedId))
            assertTrue(receiver.signalStore.containsSignedPreKey(secondSignedId))

            val fresh = registerAndConnect("fresh_signal")
            try {
                assertEquals(SubmissionStatus.ACCEPTED, sendText(fresh, receiver, "after automatic refill")
                    .recipients.single().status)
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
            suspend fun gone(text: String) = alice.send(listOf(userId), "directMessage", text, 1, text.toByteArray()).recipients
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
            val messenger = Messenger(alice.signalStore, alice.api)
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
            val resetKeys = dev.barrelmaker.obscura.kit.managers.SignalKeyUtils.generateProvisioningKeys(
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
        try {
            val before = alice.api.fetchPreKeyBundles(bob.userId!!).getJSONObject(0)
                .getJSONObject("oneTimePreKey").getInt("keyId")
            repeat(3) { assertEquals(listOf(bob.deviceId), bob.api.fetchOwnDevices().map { it.deviceId }) }
            sendAndVerify(alice, bob, "first session")
            val afterFirst = alice.api.fetchPreKeyBundles(bob.userId!!).getJSONObject(0)
                .getJSONObject("oneTimePreKey").getInt("keyId")
            assertNotEquals(before, afterFirst)
            val session = alice.signalStore.loadSession(Messenger.addressFor(bob.deviceId!!)).serialize()
            sendAndVerify(alice, bob, "reused session")
            val afterSecond = alice.api.fetchPreKeyBundles(bob.userId!!).getJSONObject(0)
                .getJSONObject("oneTimePreKey").getInt("keyId")
            assertNotEquals(afterFirst, afterSecond)
            assertFalse(session.contentEquals(alice.signalStore.loadSession(Messenger.addressFor(bob.deviceId!!)).serialize()),
                "sending must advance the existing ratchet")
            bob.disconnect()
            var remaining = 0
            var exhausted = false
            repeat(100) {
                if (!exhausted) {
                    val key = alice.api.fetchPreKeyBundles(bob.userId!!).getJSONObject(0).optJSONObject("oneTimePreKey")
                    if (key == null) exhausted = true else remaining++
                }
            }
            assertTrue(exhausted)
            assertEquals(96, remaining, "three inspections and first-session discovery consume four keys; metadata and reuse consume none")
        } finally { alice.logout(); bob.logout() }
    }

    @Test
    fun `failed local inbox persistence rolls back decrypt and redelivery persists exactly once`(): Unit = runBlocking {
        verifyReceiveRecovery("InboxRow")
    }

    @Test
    fun `failed local directory persistence rolls back decrypt and redelivery persists exactly once`(): Unit = runBlocking {
        verifyReceiveRecovery("Device")
    }

    private suspend fun verifyReceiveRecovery(table: String) {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        ObscuraDatabase.Schema.create(driver)
        val bob = ObscuraClient(ObscuraConfig(API, "durability"), driver, MemoryStorage())
        val alice = registerAndConnect("durable_sender")
        bob.register(uniqueName("durable_receiver"), TEST_PASSWORD)
        bob.connect()
        try {
            // Use an established ratchet, not a repeated initial prekey message.
            sendAndVerify(alice, bob, "establish durable session")
            sendAndVerify(bob, alice, "acknowledge Signal session")
            bob.inbox.consume(bob.inbox.peek().map { it.id })
            while (bob.messageReceived.tryReceive().isSuccess) { }
            driver.execute(null,
                "CREATE TRIGGER fail_contract_write BEFORE INSERT ON $table BEGIN SELECT RAISE(FAIL, 'contract disk failure'); END", 0)
            assertEquals(SubmissionStatus.ACCEPTED, sendText(alice, bob, "recover after storage failure").recipients.single().status)
            eventually(message = "local durable insert rejection") {
                bob.getDebugLog().any { it.contains("contract disk failure") }
            }
            assertEquals(0L, bob.inbox.depth())
            assertNull(bob.messageReceived.tryReceive().getOrNull())
            bob.disconnect()
            driver.execute(null, "DROP TRIGGER fail_contract_write", 0)
            bob.connect()
            val recovered = bob.awaitContent("recover after storage failure")
            assertEquals(alice.userId, recovered.senderUserId)
            assertEquals(alice.deviceId, recovered.senderDeviceId)
            assertEquals(1L, bob.inbox.depth())
            assertEquals("directMessage", bob.messageReceived.tryReceive().getOrNull())
            assertNull(bob.messageReceived.tryReceive().getOrNull())
            bob.processPendingMessages(2_000)
            bob.disconnect()
            // Remove the local deduplication row: an unacknowledged server copy would now fail decrypt.
            bob.inbox.consume(listOf(recovered.id))
            val decryptFailures = bob.getDebugLog().count { it.contains("decrypt failed") }
            bob.connect()
            sendAndVerify(alice, bob, "after recovered ack")
            assertEquals(decryptFailures, bob.getDebugLog().count { it.contains("decrypt failed") })
            assertEquals(listOf("after recovered ack"), bob.inbox.peek().map { it.content() })
        } finally { alice.logout(); bob.logout(); driver.close() }
    }

    @Test
    fun `failed local friend request persistence recovers on real server redelivery`(): Unit = runBlocking {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        ObscuraDatabase.Schema.create(driver)
        val bob = ObscuraClient(ObscuraConfig(API, "friend durability"), driver, MemoryStorage())
        val alice = registerAndConnect("durable_friend_sender")
        bob.register(uniqueName("durable_friend_receiver"), TEST_PASSWORD)
        bob.connect()
        try {
            sendAndVerify(alice, bob, "establish friendship ratchet")
            sendAndVerify(bob, alice, "acknowledge friendship ratchet")
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
