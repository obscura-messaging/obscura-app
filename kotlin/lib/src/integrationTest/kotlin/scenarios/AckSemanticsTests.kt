package scenarios

import com.google.protobuf.ByteString
import dev.barrelmaker.obscura.kit.ObscuraClient
import dev.barrelmaker.obscura.kit.ObscuraLogger
import dev.barrelmaker.obscura.kit.crypto.UuidCodec
import dev.barrelmaker.obscura.kit.messaging.Messenger
import kotlinx.coroutines.runBlocking
import obscura.client.v1.Client.ClientMessage
import obscura.client.v1.Client.EncryptedMessage
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.signal.libsignal.protocol.SessionCipher
import org.signal.libsignal.protocol.message.CiphertextMessage
import xyz.obscura.server.contracts.ObscuraProtocol.SendMessageRequest
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

/**
 * An ack deletes the server copy, and an unacked message is redelivered only on a new connection.
 * So a message that fails to decrypt must come back after a reconnect.
 */
class AckSemanticsTests {

    private class CountingLogger : ObscuraLogger {
        val decryptFailures = AtomicInteger(0)
        override fun log(message: String) {}
        override fun decryptFailed(sourceUserId: String, reason: String) { decryptFailures.incrementAndGet() }
        override fun ackFailed(envelopeId: String, reason: String) {}
        override fun tokenRefreshFailed(attempt: Int, reason: String) {}
        override fun preKeyReplenishFailed(reason: String) {}
        override fun identityChanged(userId: String) {}
        override fun databaseError(store: String, operation: String, reason: String) {}
    }

    /** A real ciphertext for [deviceId] with its MAC corrupted, so it fails at the Signal decrypt. */
    private suspend fun sendCorruptCiphertext(sender: ObscuraClient, userId: String, deviceId: String) {
        val address = Messenger.addressFor(deviceId)
        val plaintext = ClientMessage.newBuilder().setAppEntry(obscura.client.v1.appEntry { model = "corrupt" }).build()
        val ciphertext = SessionCipher(sender.signalStore, address).encrypt(plaintext.toByteArray())
        val bytes = ciphertext.serialize().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 0xFF).toByte() }
        val encrypted = EncryptedMessage.newBuilder()
            .setType(
                if (ciphertext.type == CiphertextMessage.PREKEY_TYPE) EncryptedMessage.Type.TYPE_PREKEY_MESSAGE
                else EncryptedMessage.Type.TYPE_ENCRYPTED_MESSAGE
            )
            .setContent(ByteString.copyFrom(bytes))
            .build()
        val submission = SendMessageRequest.Submission.newBuilder()
            .setDeviceId(UuidCodec.uuidToBytes(UUID.fromString(deviceId)))
            .setMessage(encrypted.toByteString())
            .build()
        val recipient = SendMessageRequest.Recipient.newBuilder()
            .setUserId(UuidCodec.uuidToBytes(UUID.fromString(userId)))
            .addSubmissions(submission)
            .build()
        sender.api.sendMessage(SendMessageRequest.newBuilder().addRecipients(recipient).build().toByteArray())
    }

    @Test
    fun `a decrypt failure is not acked and redelivers after reconnect`() = runBlocking {
        requireServer()
        val logger = CountingLogger()
        val alice = registerAndConnect("ack_alice").also { it.logger = logger }
        val bob = registerAndConnect("ack_bob")
        becomeFriends(bob, alice)
        sendAndVerify(bob, alice, "warmup")
        assertEquals(0, logger.decryptFailures.get())

        sendCorruptCiphertext(bob, alice.userId!!, alice.deviceId!!)
        eventually(message = "first decrypt failure") { logger.decryptFailures.get() == 1 }

        alice.disconnect()
        alice.connect()
        eventually(message = "redelivery") { logger.decryptFailures.get() == 2 }
        assertEquals(1L, alice.inbox.depth(), "only the warmup is stored")

        alice.disconnect(); bob.disconnect()
    }
}
