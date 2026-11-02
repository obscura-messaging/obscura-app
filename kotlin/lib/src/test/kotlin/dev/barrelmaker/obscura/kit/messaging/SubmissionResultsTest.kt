package dev.barrelmaker.obscura.kit.messaging

import com.google.protobuf.ByteString
import com.sun.net.httpserver.HttpServer
import dev.barrelmaker.obscura.kit.SubmissionStatus
import dev.barrelmaker.obscura.kit.crypto.SignalStore
import dev.barrelmaker.obscura.kit.crypto.UuidCodec
import dev.barrelmaker.obscura.kit.newInMemoryDatabase
import dev.barrelmaker.obscura.kit.network.APIClient
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import xyz.obscura.server.contracts.ObscuraProtocol.SendMessageRequest
import xyz.obscura.server.contracts.ObscuraProtocol.SendMessageResponse
import java.net.InetSocketAddress
import java.util.UUID

class SubmissionResultsTest {
    private fun submission() = SendMessageRequest.Submission.newBuilder()
        .setDeviceId(UuidCodec.uuidToBytes(UUID.randomUUID()))
        .setMessage(ByteString.copyFromUtf8("encrypted"))
        .build()

    @Test
    fun `maps partial rejection to exactly its submission`() {
        val a = submission()
        val b = submission()
        val response = SendMessageResponse.newBuilder()
            .addInvalidDeviceIds(a.deviceId)
            .build()
        val decoded = decodeSubmissionResults("user", listOf(a, b), response)
        val results = decoded.submitted.map { it.result }
        assertEquals(listOf(SubmissionStatus.REJECTED, SubmissionStatus.ACCEPTED), results.map { it.status })
        assertEquals(listOf(true, false), decoded.submitted.map { it.invalidDevice })
        assertNull(decoded.missingDeviceIds)
        assertEquals("Device not found", results[0].error)
        assertNull(results[1].error)
        assertEquals(UuidCodec.uuidString(b.deviceId), results[1].deviceId)
    }

    private val userId = "019f025a-0000-7de6-84b6-000000000002"

    private fun mismatch(user: String = userId, vararg missing: UUID) =
        SendMessageResponse.newBuilder()
            .addDeviceMismatches(SendMessageResponse.DeviceMismatch.newBuilder().setUserId(UuidCodec.uuidToBytes(UUID.fromString(user)))
                .addAllMissingDeviceIds(missing.map { UuidCodec.uuidToBytes(it) }))

    @Test
    fun `a device mismatch names the user's missing devices`() {
        val a = submission()
        val missing = UUID.randomUUID()
        val decoded = decodeSubmissionResults(userId, listOf(a), mismatch(userId, missing).build())
        assertEquals(listOf(missing.toString()), decoded.missingDeviceIds)
        assertFalse(decoded.submitted.single().invalidDevice)
        assertEquals(SubmissionStatus.REJECTED, decoded.submitted.single().result.status)
    }

    @Test
    fun `a mismatch without a submission names devices of a user with no target`() {
        val missing = UUID.randomUUID()
        val decoded = decodeSubmissionResults(userId, emptyList(), mismatch(userId, missing).build())
        assertEquals(listOf(missing.toString()), decoded.missingDeviceIds)
        assertTrue(decoded.submitted.isEmpty())
    }

    @Test
    fun `an inconsistent or foreign device mismatch is a protocol violation`() {
        val a = submission()
        val missing = UUID.randomUUID()
        for (response in listOf(
            mismatch(user = "019f025a-0000-7de6-84b6-000000000003", missing).build(),
            mismatch(userId, missing).addDeviceMismatches(mismatch(userId, missing).build().getDeviceMismatches(0)).build(),
        )) assertThrows(dev.barrelmaker.obscura.kit.ObscuraError.ProtocolViolation::class.java) {
            decodeSubmissionResults(userId, listOf(a), response)
        }
    }

    @Test
    fun `rejects unknown and duplicate invalid device IDs`() {
        val a = submission()
        val unknown = submission()
        assertThrows(dev.barrelmaker.obscura.kit.ObscuraError.ProtocolViolation::class.java) {
            decodeSubmissionResults("user", listOf(a),
                SendMessageResponse.newBuilder().addInvalidDeviceIds(unknown.deviceId).build())
        }
        assertThrows(dev.barrelmaker.obscura.kit.ObscuraError.ProtocolViolation::class.java) {
            decodeSubmissionResults("user", listOf(a), SendMessageResponse.newBuilder()
                .addInvalidDeviceIds(a.deviceId).addInvalidDeviceIds(a.deviceId).build())
        }
    }

    @Test
    fun `preprocessing HTTP rejections are definitive but network failure stays unknown`() = runBlocking {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        var status = 400
        server.createContext("/v1/messages") { exchange ->
            exchange.requestBody.readBytes()
            val bytes = "definitive rejection".toByteArray()
            exchange.sendResponseHeaders(status, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        val messenger = Messenger(SignalStore(newInMemoryDatabase()),
            APIClient("http://127.0.0.1:${server.address.port}") { "unit-test" })
        try {
            for ((code, expected) in listOf(
                400 to SubmissionStatus.REJECTED, 413 to SubmissionStatus.REJECTED,
                401 to SubmissionStatus.UNKNOWN, 403 to SubmissionStatus.UNKNOWN,
            )) {
                status = code
                val result = messenger.submit(userId, listOf(submission())).submitted.single().result
                assertEquals(expected, result.status, "HTTP $code")
                assertTrue(result.error!!.contains(code.toString()))
            }
        } finally { server.stop(0) }
        assertEquals(SubmissionStatus.UNKNOWN, messenger.submit(userId, listOf(submission())).submitted.single().result.status)
    }

    @Test
    fun `scoped submit decodes HTTP 200 rejections and reports uncertain HTTP failures`() = runBlocking {
        val a = submission()
        val received = mutableListOf<SendMessageRequest>()
        var status = 200
        var response = SendMessageResponse.newBuilder().addInvalidDeviceIds(a.deviceId).build().toByteArray()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/v1/messages") { exchange ->
            received.add(SendMessageRequest.parseFrom(exchange.requestBody.readBytes()))
            exchange.sendResponseHeaders(status, response.size.toLong())
            exchange.responseBody.use { it.write(response) }
        }
        server.start()
        try {
            val messenger = Messenger(SignalStore(newInMemoryDatabase()),
                APIClient("http://127.0.0.1:${server.address.port}") { "unit-test" })
            assertEquals(SubmissionStatus.REJECTED, messenger.submit(userId, listOf(a)).submitted.single().result.status)
            val b = submission()
            response = byteArrayOf()
            assertEquals(SubmissionStatus.ACCEPTED, messenger.submit(userId, listOf(b)).submitted.single().result.status)
            assertEquals(listOf(listOf(a), listOf(b)), received.map { it.recipientsList.single().submissionsList })
            status = 503
            response = "unavailable".toByteArray()
            assertEquals(SubmissionStatus.UNKNOWN, messenger.submit(userId, listOf(b)).submitted.single().result.status)
        } finally {
            server.stop(0)
        }
    }
}
