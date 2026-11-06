package dev.barrelmaker.obscura.kit.managers

import com.google.protobuf.ByteString
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import dev.barrelmaker.obscura.kit.crypto.SignalStore
import dev.barrelmaker.obscura.kit.crypto.UuidCodec
import dev.barrelmaker.obscura.kit.crypto.toBase64
import dev.barrelmaker.obscura.kit.messaging.Messenger
import dev.barrelmaker.obscura.kit.network.APIClient
import dev.barrelmaker.obscura.kit.newInMemoryDatabase
import dev.barrelmaker.obscura.kit.stores.DeviceStore
import obscura.client.v1.Client.ClientMessage
import obscura.client.v1.Client.EncryptedMessage
import org.json.JSONArray
import org.json.JSONObject
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.message.PreKeySignalMessage
import org.signal.libsignal.protocol.state.PreKeyRecord
import xyz.obscura.server.contracts.ObscuraProtocol.Envelope
import xyz.obscura.server.contracts.ObscuraProtocol.SendMessageRequest
import xyz.obscura.server.contracts.ObscuraProtocol.SendMessageResponse
import java.net.InetSocketAddress
import java.util.Collections
import java.util.UUID

/**
 * An in-process stand-in for the bundle and message endpoints, with the real server's semantics.
 * An account's devices share its identity. `GET /v1/keys/{id}` returns one bundle per device and
 * consumes a one-time prekey from each (404 when the user has none); `GET /v1/keys/{id}/devices/{d}`
 * consumes one from that device only. `POST /v1/messages` requires complete delivery: for each
 * recipient user, submissions are queued only when they cover all of the user's current devices
 * (the sender's own device excluded); otherwise none are queued and the untargeted devices are
 * listed in `device_mismatches`, even with no submission. A device not belonging to its recipient
 * user is listed in `invalid_device_ids`.
 */
class FakeObscuraServer : AutoCloseable {
    private val devices = Collections.synchronizedMap(linkedMapOf<String, FakeDevice>())
    private val identities = Collections.synchronizedMap(mutableMapOf<String, IdentityKeyPair>())
    private val consumed = Collections.synchronizedMap(mutableMapOf<String, Int>())
    private val sendRequests = Collections.synchronizedList(mutableListOf<Pair<String, SendMessageRequest>>())
    private val http = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
        createContext("/v1/keys/") { respond(it, bundles(it.requestURI.path.removePrefix("/v1/keys/").split("/"))) }
        createContext("/v1/messages") { respond(it, accept(it)) }
        start()
    }
    val url = "http://127.0.0.1:${http.address.port}"

    /** One-time prekeys consumed from [userId]'s devices by bundle fetches. */
    fun prekeysConsumed(userId: String) = consumed[userId] ?: 0

    /** Every message request with its idempotency key, in order. */
    val requests: List<Pair<String, SendMessageRequest>> get() = sendRequests.toList()

    /**
     * A new device of [userId]: the first one creates the account identity, later ones share it, as
     * linking does. [identity] overrides that, which the real server forbids. A device without
     * [servesBundles] is listed as current but its bundle is never found.
     */
    fun register(
        userId: String,
        corruptBundle: Boolean = false,
        identity: IdentityKeyPair = identities.getOrPut(userId) { IdentityKeyPair.generate() },
        servesBundles: Boolean = true,
    ): FakeDevice = FakeDevice(this, userId, identity, corruptBundle, servesBundles).also { devices[it.deviceId] = it }

    fun remove(device: FakeDevice) { devices.remove(device.deviceId) }

    /** Delete every device of [userId] and its identity, as an account reset does. */
    fun reset(userId: String) {
        devices.values.removeIf { it.userId == userId }
        identities.remove(userId)
    }

    override fun close() = http.stop(0)

    private fun bundles(path: List<String>): Pair<Int, ByteArray> {
        val userId = path[0]
        val owned = devices.values.filter { it.userId == userId && it.servesBundles && (path.size == 1 || it.deviceId == path[2]) }
        if (owned.isEmpty()) return 404 to ByteArray(0)
        consumed.merge(userId, owned.size, Int::plus)
        val bundles = owned.map { it.consumeBundle() }
        return 200 to (if (path.size == 1) JSONObject().put("bundles", JSONArray(bundles)).toString() else bundles.single().toString()).toByteArray()
    }

    private fun accept(exchange: HttpExchange): Pair<Int, ByteArray> {
        val sender = devices.getValue(exchange.requestHeaders.getFirst("Authorization").removePrefix("Bearer "))
        val request = SendMessageRequest.parseFrom(exchange.requestBody.readBytes())
        sendRequests.add(exchange.requestHeaders.getFirst("Idempotency-Key") to request)
        val response = SendMessageResponse.newBuilder()
        for (recipient in request.recipientsList) {
            val userId = UuidCodec.uuidString(recipient.userId)!!
            val current = devices.values.filter { it.userId == userId && it !== sender }.map { it.deviceId }.toSet()
            val valid = recipient.submissionsList.filter { sub ->
                val deviceId = UuidCodec.uuidString(sub.deviceId)!!
                (deviceId in current).also { if (!it) response.addInvalidDeviceIds(sub.deviceId) }
            }
            val targeted = valid.map { UuidCodec.uuidString(it.deviceId)!! }.toSet()
            if (targeted != current) {
                response.addDeviceMismatches(SendMessageResponse.DeviceMismatch.newBuilder()
                    .setUserId(recipient.userId)
                    .addAllMissingDeviceIds((current - targeted).map { UuidCodec.uuidToBytes(UUID.fromString(it)) }))
                continue
            }
            for (submission in valid) {
                devices.getValue(UuidCodec.uuidString(submission.deviceId)!!).mailbox.add(Envelope.newBuilder()
                    .setId(UuidCodec.uuidToBytes(UUID.randomUUID()))
                    .setSenderUserId(UuidCodec.uuidToBytes(UUID.fromString(sender.userId)))
                    .setSenderDeviceId(UuidCodec.uuidToBytes(UUID.fromString(sender.deviceId)))
                    .setMessage(submission.message)
                    .build())
            }
        }
        return 200 to response.build().toByteArray()
    }

    private fun respond(exchange: HttpExchange, reply: Pair<Int, ByteArray>) {
        val (status, body) = reply
        exchange.sendResponseHeaders(status, if (body.isEmpty()) -1 else body.size.toLong())
        exchange.responseBody.use { it.write(body) }
    }
}

/** A real Signal device of an account: its own store, keys, directory and [MessageSender], on [FakeObscuraServer]. */
class FakeDevice internal constructor(
    server: FakeObscuraServer,
    val userId: String,
    identity: IdentityKeyPair,
    private val corruptBundle: Boolean,
    internal val servesBundles: Boolean,
) {
    val deviceId: String = UUID.randomUUID().toString()
    private val db = newInMemoryDatabase()
    internal val signalStore = SignalStore(db)
    internal val directory = DeviceStore(db)
    internal val messenger: Messenger
    internal val sender: MessageSender
    val mailbox: MutableList<Envelope> = Collections.synchronizedList(mutableListOf())
    private val unusedPreKeys = ArrayDeque<PreKeyRecord>()

    init {
        val api = APIClient(server.url) { deviceId }
        messenger = Messenger(signalStore, api)
        sender = MessageSender(api, messenger, directory) { deviceId }
        val keys = SignalKeyUtils.generateProvisioningKeys(identity)
        SignalKeyUtils.install(signalStore, keys)
        unusedPreKeys.addAll(keys.oneTimePreKeys)
    }

    val remainingPreKeys get() = unusedPreKeys.size

    internal fun consumeBundle(): JSONObject {
        val spk = signalStore.loadSignedPreKey(1)
        val otpk = unusedPreKeys.removeFirstOrNull()
        val signature = if (corruptBundle) ByteArray(64) else spk.signature
        return JSONObject()
            .put("deviceId", deviceId)
            .put("registrationId", signalStore.localRegistrationId)
            .put("identityKey", signalStore.identityKeyPair.publicKey.serialize().toBase64())
            .put("signedPreKey", JSONObject().put("keyId", 1)
                .put("publicKey", spk.keyPair.publicKey.serialize().toBase64())
                .put("signature", signature.toBase64()))
            .put("oneTimePreKey", otpk?.let { JSONObject().put("keyId", it.id).put("publicKey", it.keyPair.publicKey.serialize().toBase64()) } ?: JSONObject.NULL)
    }

    /** Decrypt and clear the mailbox, recording each stamped sender as the receive path does. */
    suspend fun receive(): List<Received> = mailbox.toList().also { mailbox.clear() }.map { envelope ->
        val encrypted = EncryptedMessage.parseFrom(envelope.message)
        val senderDevice = UuidCodec.uuidString(envelope.senderDeviceId)!!
        val plaintext = messenger.decryptAndCommit(senderDevice, envelope.message,
            record = { directory.addInTransaction(UuidCodec.uuidString(envelope.senderUserId)!!, senderDevice) }) { it }
        Received(
            ClientMessage.parseFrom(plaintext),
            encrypted.type,
            if (encrypted.type == EncryptedMessage.Type.TYPE_PREKEY_MESSAGE) {
                ByteString.copyFrom(PreKeySignalMessage(encrypted.content.toByteArray()).baseKey.serialize())
            } else null,
        )
    }
}

/** A decrypted delivery. [baseKey] identifies the session a prekey message starts; null otherwise. */
data class Received(val message: ClientMessage, val type: EncryptedMessage.Type, val baseKey: ByteString?)
