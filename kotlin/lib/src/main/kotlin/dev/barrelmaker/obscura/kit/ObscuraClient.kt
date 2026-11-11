package dev.barrelmaker.obscura.kit

import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.google.protobuf.ByteString
import dev.barrelmaker.obscura.kit.crypto.AttachmentCrypto
import dev.barrelmaker.obscura.kit.crypto.LinkCrypto
import dev.barrelmaker.obscura.kit.crypto.SignalStore
import dev.barrelmaker.obscura.kit.wire.UuidCodec
import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import dev.barrelmaker.obscura.kit.linking.HistorySync
import dev.barrelmaker.obscura.kit.auth.AuthManager
import dev.barrelmaker.obscura.kit.auth.Credentials
import dev.barrelmaker.obscura.kit.messaging.MessageSender
import dev.barrelmaker.obscura.kit.crypto.PreKeys
import dev.barrelmaker.obscura.kit.auth.TokenStatus
import dev.barrelmaker.obscura.kit.messaging.Messenger
import dev.barrelmaker.obscura.kit.network.APIClient
import dev.barrelmaker.obscura.kit.network.GatewayConnection
import dev.barrelmaker.obscura.kit.stores.ContentStore
import dev.barrelmaker.obscura.kit.stores.ConversationItem
import dev.barrelmaker.obscura.kit.stores.DeviceStore
import dev.barrelmaker.obscura.kit.stores.Friend
import dev.barrelmaker.obscura.kit.stores.FriendList
import dev.barrelmaker.obscura.kit.stores.FriendStatus
import dev.barrelmaker.obscura.kit.stores.FriendStore
import dev.barrelmaker.obscura.kit.stores.LocalDevice
import dev.barrelmaker.obscura.kit.stores.MediaAttachment
import dev.barrelmaker.obscura.kit.stores.ProfileItem
import dev.barrelmaker.obscura.kit.stores.StoryItem
import dev.barrelmaker.obscura.kit.stores.expiresAt
import dev.barrelmaker.obscura.kit.stores.pragma
import dev.barrelmaker.obscura.kit.stores.truncateWal
import dev.barrelmaker.obscura.kit.wire.PayloadDisposition
import dev.barrelmaker.obscura.kit.wire.TypingTracker
import dev.barrelmaker.obscura.kit.wire.WireCodec
import dev.barrelmaker.obscura.kit.wire.payloadDisposition
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import com.google.protobuf.InvalidProtocolBufferException
import obscura.client.v1.Client.ClientMessage
import obscura.client.v1.Client.EncryptedMessage
import obscura.client.v1.Client.FriendListSync
import obscura.client.v1.Client.LinkBundle
import obscura.client.v1.Client.LinkCode
import obscura.client.v1.Client.SeenReceipt
import obscura.client.v1.friendAccept
import obscura.client.v1.friendRequest
import obscura.client.v1.typingSignal
import org.signal.libsignal.protocol.DuplicateMessageException
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.ecc.ECKeyPair
import xyz.obscura.server.contracts.ObscuraProtocol.Envelope
import java.io.File
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentLinkedDeque

/**
 * The kit. With [driver] null the kit opens [ObscuraConfig.databasePath] (or an in-memory database)
 * and creates the schema; an app-supplied driver must already have it.
 */
class ObscuraClient(
    config: ObscuraConfig,
    driver: SqlDriver?,
    sessionStorage: SessionStorage,
    val attachmentCacheDir: File? = null,
    internal val clock: () -> Long = System::currentTimeMillis,
) {
    var logger: ObscuraLogger = NoOpLogger

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val sqlDriver: SqlDriver
    internal val db: ObscuraDatabase

    init {
        if (driver != null && config.databasePath != null) throw ObscuraError.InvalidArgument("Pass either a driver or a databasePath, not both")
        sqlDriver = driver ?: JdbcSqliteDriver(config.databasePath?.let { "jdbc:sqlite:$it" } ?: JdbcSqliteDriver.IN_MEMORY)
            .also { ObscuraDatabase.Schema.create(it) }
        // EntryStore.erase relies on freed pages being zeroed.
        sqlDriver.pragma("PRAGMA secure_delete = ON")
        db = ObscuraDatabase(sqlDriver)
    }

    internal val signalStore = SignalStore(db).apply {
        onIdentityChanged = {
            log("IDENTITY changed for $it; sessions with its devices dropped")
            logger.identityChanged(it)
        }
    }
    private val friends = FriendStore(db)
    internal val devices = DeviceStore(db)
    internal val content = ContentStore(db, sqlDriver)

    internal val auth: AuthManager
    internal val api: APIClient
    private val gateway: GatewayConnection
    private val messenger: Messenger
    internal val sender: MessageSender
    private val typing = TypingTracker(scope, clock)

    init {
        lateinit var authRef: AuthManager
        api = APIClient(config.apiUrl, refresh = { authRef.refresh() }) { authRef.credentials?.token }
        auth = AuthManager(
            api, signalStore, devices, sessionStorage, config.deviceName, scope,
            logger = { logger },
            onRejected = { credentials, generation -> endSession(revoke = false, expected = credentials, expectedGeneration = generation) },
            clock = clock,
        )
        authRef = auth
        gateway = GatewayConnection(api, scope, beforeConnect = { requireFreshToken() }, log = ::log)
        messenger = Messenger(signalStore, api) { auth.credentials?.deviceId }
        sender = MessageSender(api, messenger, devices, logger = { logger }) { auth.credentials?.deviceId }
    }

    val authState: StateFlow<AuthState> get() = auth.state
    val connectionState: StateFlow<ConnectionState> get() = gateway.state

    val userId: String? get() = auth.credentials?.userId
    val deviceId: String? get() = auth.credentials?.deviceId
    val username: String? get() = auth.credentials?.username

    /** Payload-free; emits on collection and on every friend change. Call [getFriends] for the rows. */
    val friendsChanged: Flow<Unit> = friends.changes

    private val newEntries = Channel<EntryModel>(MESSAGE_RECEIVED_CAPACITY, BufferOverflow.DROP_OLDEST)

    /** The model key of each newly inboxed APP_ENTRY row. One consumer. The inbox is the delivery path. */
    val messageReceived: ReceiveChannel<EntryModel> = newEntries

    private val debugLog = ConcurrentLinkedDeque<String>()

    /** The last [DEBUG_LOG_SIZE] log lines, newest first. */
    fun getDebugLog(): List<String> = debugLog.toList()

    /** Creates the account; this device becomes its primary with a new identity. */
    suspend fun register(username: String, password: String) = auth.register(username, password)

    suspend fun login(username: String, password: String): LoginScenario = auth.login(username, password)

    /**
     * Deletes every device of the account on the server, wipes all local data, and provisions this
     * device as the new primary with a new identity. Peers see the new identity as an identity change.
     */
    suspend fun resetAccount(username: String, password: String) {
        auth.resetAccount(username, password) { wipeDevice(revoke = false) }
    }

    /** Whether this device is the account's primary. False before provisioning. */
    suspend fun isPrimary(): Boolean = devices.getLocal()?.isPrimary == true

    /** Start linking this unprovisioned device. The ephemeral key lives only in the returned request. */
    suspend fun beginLink(username: String, password: String, deviceName: String): LinkRequest {
        if (deviceName.isBlank()) throw ObscuraError.InvalidArgument("deviceName must not be blank")
        val session = auth.takeOrCreateLinkSession(username, password)
        val ephemeral = ECKeyPair.generate()
        val code = LinkCode.newBuilder()
            .setSessionId(session.id)
            .setEphemeralPublicKey(ByteString.copyFrom(ephemeral.publicKey.serialize()))
            .setDeviceName(deviceName)
            .build()
        return LinkRequest(LinkCrypto.encodeCode(code), session.id, session.userId, session.expiresAt, ephemeral, username, deviceName)
    }

    /**
     * Wait for the primary's approval, then provision this device with the account identity, import
     * the friend list and history, and connect. Nothing is stored if provisioning fails.
     */
    suspend fun completeLink(request: LinkRequest) {
        val bundle = try {
            LinkBundle.parseFrom(LinkCrypto.open(awaitApproval(request), request.ephemeral.privateKey))
        } catch (e: InvalidProtocolBufferException) {
            throw ObscuraError.ProtocolViolation("Invalid link bundle", e)
        }
        if (bundle.userId != request.userId) throw ObscuraError.ProtocolViolation("Link bundle is for another account")
        if (!dev.barrelmaker.obscura.kit.network.isUuid(bundle.primaryDeviceId)) {
            throw ObscuraError.ProtocolViolation("Invalid primary device in link bundle")
        }
        val identity = try {
            IdentityKeyPair(bundle.identityKeyPair.toByteArray())
        } catch (e: Exception) {
            throw ObscuraError.ProtocolViolation("Invalid identity in link bundle", e)
        }
        val friendList = FriendList(bundle.friendListVersion, bundle.friendsList.map {
            WireCodec.decodeFriend(it) ?: throw ObscuraError.ProtocolViolation("Invalid friend in link bundle")
        })
        auth.provisionLinked(
            request.userId, bundle.primaryDeviceId, request.username, request.deviceName,
            PreKeys.generateProvisioningKeys(identity, clock()), request.sessionId,
        ) { friends.replaceInTransaction(friendList) }
        try {
            if (bundle.hasHistory()) {
                HistorySync.restoreHistorySnapshot(bundle.history, content, ::downloadDecryptedAttachment)
            }
            connect()
        } finally {
            auth.publishAuthenticated()
        }
    }

    private suspend fun awaitApproval(request: LinkRequest): ByteArray {
        while (clock() / 1000 < request.expiresAt) {
            val body = try {
                api.awaitLinkSession(request.sessionId)
            } catch (e: ObscuraError.Http) {
                if (e.status == 404) throw ObscuraError.LinkFailed("Link session expired or unknown", e)
                throw e
            }
            if (body != null) return body
            delay(LINK_POLL_MS)
        }
        throw ObscuraError.LinkFailed("Link session expired")
    }

    /** Primary only: approve the device showing [code] by sending it the account identity, friends and history. */
    suspend fun approveLink(code: String) {
        val self = requirePrimary()
        val link = LinkCrypto.decodeCode(code)
        val friendList = friends.list()
        val bundle = LinkBundle.newBuilder()
            .setIdentityKeyPair(ByteString.copyFrom(signalStore.identityKeyPair.serialize()))
            .setUserId(self.userId)
            .setUsername(self.username)
            .setPrimaryDeviceId(self.deviceId)
            .setFriendListVersion(friendList.version)
            .addAllFriends(friendList.friends.map(WireCodec::encodeFriend))
        HistorySync.uploadHistorySnapshot(content, ::uploadAttachment)?.let { bundle.setHistory(it) }
        val envelope = LinkCrypto.seal(bundle.build().toByteArray(), LinkCrypto.publicKey(link))
        try {
            api.approveLinkSession(link.sessionId, envelope.toByteArray())
        } catch (e: ObscuraError.Http) {
            if (e.status == 404) throw ObscuraError.LinkFailed("Link session expired or unknown", e)
            throw e
        }
    }

    /** The account's devices. */
    suspend fun devices(): List<DeviceInfo> {
        val self = requireFreshToken()
        val list = api.fetchOwnDevices()
        if (list.count { it.isPrimary } != 1) throw ObscuraError.ProtocolViolation("The account has no primary device")
        return list.map { DeviceInfo(it.deviceId, it.name, it.isPrimary, it.deviceId == self.deviceId) }
    }

    /**
     * The primary unlinks any other device. A linked device unlinks only itself, then is wiped and
     * logged out. The primary cannot unlink itself: [resetAccount] instead.
     */
    suspend fun unlinkDevice(deviceId: String) {
        val self = requireFreshToken()
        val primary = isPrimary()
        when {
            deviceId == self.deviceId && primary ->
                throw ObscuraError.InvalidArgument("The primary device cannot unlink itself; reset the account instead")
            deviceId == self.deviceId -> {
                api.deleteDevice(deviceId)
                wipeDevice(revoke = false)
            }
            !primary -> throw ObscuraError.NotPrimary()
            else -> {
                api.deleteDevice(deviceId)
                devices.remove(self.userId, listOf(deviceId))
            }
        }
    }

    /**
     * Restore the stored session. True when restored; the client then connects if it can and stays
     * authenticated but disconnected if it cannot. Never throws.
     */
    suspend fun restorePersistedSession(): Boolean {
        try {
            if (!auth.restore()) return false
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            log("SESSION restore failed: ${e.message}")
            return false
        }
        try {
            connect()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            log("SESSION restored offline: ${e.message}")
        }
        return true
    }

    /** Ends the session and revokes it on the server. Local data is kept. */
    suspend fun logout() = endSession(revoke = true)

    /** [logout], then delete every piece of local kit data. */
    suspend fun wipeDevice() = wipeDevice(revoke = true)

    private suspend fun wipeDevice(revoke: Boolean) {
        endSession(revoke = revoke)
        withContext(Dispatchers.IO) {
            db.transaction {
                sqlDriver.pragma("PRAGMA secure_delete = ON")
                db.friendQueries.deleteAll()
                db.friendQueries.deleteVersion()
                db.deviceQueries.deleteAll()
                db.deviceQueries.deleteIdentity()
                content.deleteAllInTransaction()
                signalStore.clear()
            }
            sqlDriver.truncateWal()
            attachmentCacheDir?.let(AttachmentCrypto::purgeAllCached)
        }
    }

    private suspend fun endSession(revoke: Boolean, expected: Credentials? = null, expectedGeneration: Long? = null) {
        val previous = try {
            auth.end(expected, expectedGeneration)
        } finally {
            if (auth.credentials == null) {
                gateway.disconnect()
                val stopping = synchronized(this) {
                    val jobs = listOfNotNull(receiveJob, preKeySyncJob)
                    jobs.forEach { it.cancel() }
                    receiveJob = null
                    preKeySyncJob = null
                    jobs
                }
                withContext(NonCancellable) { stopping.forEach { it.join() } }
                typing.clear()
            }
        }
        if (expected != null && previous == null) return
        if (revoke && previous != null) auth.revoke(previous)
        log("SESSION ended")
    }

    private suspend fun requireFreshToken(): Credentials {
        if (auth.ensureFreshToken() == TokenStatus.REJECTED) throw ObscuraError.NotAuthenticated()
        return auth.requireCredentials()
    }

    /** Returns once the socket is open. Idempotent; joins an in-flight connect. */
    suspend fun connect() {
        auth.requireCredentials()
        startReceiving()
        startPreKeySync()
        if (PreKeys.isSyncDue(signalStore, clock())) requestPreKeySync()
        gateway.connect()
        log("CONNECTED")
    }

    /** Closes the socket and stops reconnection. */
    fun disconnect() {
        gateway.disconnect()
        log("DISCONNECTED")
    }

    private var receiveJob: Job? = null
    private var preKeySyncJob: Job? = null

    /** Conflated, so requests made while a sync runs collapse into one more sync after it. */
    private val preKeySyncRequests = Channel<Unit>(Channel.CONFLATED)

    /** How often a signed-in client checks its supply anyway: peers fetching bundles use keys up without messaging. */
    internal var preKeyCheckIntervalMs = PreKeys.CHECK_INTERVAL_MS

    /** The least time between syncs, so a backlog of pre-key messages costs one or two checks rather than one each. */
    internal var preKeySyncSpacingMs = PreKeys.SYNC_SPACING_MS

    private fun requestPreKeySync() {
        if (startPreKeySync()) preKeySyncRequests.trySend(Unit)
    }

    /** Syncs run one at a time on their own job, which the session's end cancels. False when signed out. */
    private fun startPreKeySync(): Boolean = synchronized(this) {
        if (auth.credentials == null) return false
        if (preKeySyncJob?.isActive != true) preKeySyncJob = scope.launch {
            launch {
                while (true) {
                    delay(preKeyCheckIntervalMs)
                    preKeySyncRequests.trySend(Unit)
                }
            }
            for (request in preKeySyncRequests) {
                syncPreKeys()
                delay(preKeySyncSpacingMs)
            }
        }
        true
    }
    private val processedEnvelopes = MutableStateFlow(0L)
    @Volatile private var lastProcessedAtMs = 0L

    private fun startReceiving() = synchronized(this) {
        if (receiveJob?.isActive == true) return
        receiveJob = scope.launch { for (envelope in gateway.envelopes) receive(envelope) }
    }

    /** Commit receive ratchets with local durable writes; network-dependent control handlers run afterward. */
    internal suspend fun receive(envelope: Envelope, ack: suspend (ByteString) -> Unit = { gateway.ack(it) }) {
        val envelopeId = UuidCodec.uuidString(envelope.id)
        val senderUserId = UuidCodec.uuidString(envelope.senderUserId)
        val senderDeviceId = UuidCodec.uuidString(envelope.senderDeviceId)
        if (envelopeId == null || senderUserId == null || senderDeviceId == null) {
            log("RECV malformed envelope (id, sender or sender device is not 16 bytes); not acked")
            return
        }
        try {
            if (content.containsEnvelope(envelopeId)) {
                acknowledge(envelope.id, envelopeId, ack)
                return
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            log("RECV duplicate lookup failed for $envelopeId: ${e.message}")
            logger.databaseError("content", "containsEnvelope", e.reason())
            return
        }
        val encrypted = try {
            EncryptedMessage.parseFrom(envelope.message)
        } catch (e: com.google.protobuf.InvalidProtocolBufferException) {
            log("RECV decrypt failed from $senderUserId: ${e.message}")
            logger.decryptFailed(senderUserId, e.reason())
            return
        }
        var stage = "directory"
        val stored = try {
            messenger.decryptAndCommit(senderDeviceId, encrypted, record = {
                devices.addInTransaction(senderUserId, senderDeviceId)
                stage = "decrypt"
            }) { plaintext ->
                val parsed = try {
                    ClientMessage.parseFrom(plaintext)
                } catch (e: com.google.protobuf.InvalidProtocolBufferException) {
                    // Its ratchet step is committed and it can never parse, so it is acked and dropped.
                    log("RECV invalid client message from $senderUserId: ${e.message}; dropped")
                    logger.log("dropped an unparseable client message from $senderUserId: ${e.message}")
                    return@decryptAndCommit null
                }
                stage = "persist"
                store(parsed, senderUserId, senderDeviceId, envelopeId)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: DuplicateMessageException) {
            // Decrypt commits only with its durable writes, so a spent message key means this
            // redelivered envelope is already stored.
            log("RECV redelivered envelope $envelopeId was already processed; acked")
            acknowledge(envelope.id, envelopeId, ack)
            return
        } catch (e: Exception) {
            if (stage == "decrypt" || e is ObscuraError.ProtocolViolation) {
                log("RECV decrypt failed from $senderUserId: ${e.message}")
                logger.decryptFailed(senderUserId, e.reason())
            } else {
                log("RECV $stage not stored: ${e.message}")
                logger.databaseError(stage, "receive", e.reason())
            }
            return
        }
        if (stored != null) {
            val arm = stored.message.payloadCase.name
            try {
                followUp(stored, senderUserId, senderDeviceId, envelopeId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                log("RECV $arm not stored: ${e.message}")
                logger.databaseError("receive", arm, e.reason())
                return
            }
        }
        // As Signal-Android does after a pre-key message: the sender used up one of this device's keys.
        if (encrypted.type == EncryptedMessage.Type.TYPE_PREKEY_MESSAGE) requestPreKeySync()
        acknowledge(envelope.id, envelopeId, ack)
    }

    private suspend fun acknowledge(id: ByteString, envelopeId: String, ack: suspend (ByteString) -> Unit) {
        try {
            ack(id)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            log("RECV ack failed for $envelopeId: ${e.message}")
            logger.ackFailed(envelopeId, e.reason())
        }
        markProcessed()
    }

    private fun markProcessed() {
        lastProcessedAtMs = clock()
        processedEnvelopes.value++
    }

    /** A decrypted message after its durable writes, and the network work that follows them. */
    private class Stored(
        val message: ClientMessage,
        val wokeModel: EntryModel? = null,
        val friendFollowUp: FriendFollowUp = FriendFollowUp.NONE,
    )

    private enum class FriendFollowUp { NONE, SYNC, ACCEPT, REPLY_ACCEPT }

    /** [store] then [followUp] for a decrypted message outside a decrypt transaction. Throws when it could not be stored. */
    internal suspend fun route(message: ClientMessage, senderUserId: String, senderDeviceId: String, envelopeId: String) {
        val stored = withContext(Dispatchers.IO) { db.transactionWithResult { store(message, senderUserId, senderDeviceId, envelopeId) } }
        followUp(stored, senderUserId, senderDeviceId, envelopeId)
    }

    /** The local, synchronous part of handling a message; runs inside the receive transaction. */
    private fun store(message: ClientMessage, senderUserId: String, senderDeviceId: String, envelopeId: String): Stored =
        when (payloadDisposition(message.payloadCase)) {
            PayloadDisposition.CONTENT -> storeContent(message, senderUserId, senderDeviceId, envelopeId)
            PayloadDisposition.KIT_INTERNAL -> Stored(message, friendFollowUp = applyFriendMessage(message, senderUserId, senderDeviceId))
            PayloadDisposition.DROPPABLE -> {
                if (message.payloadCase != ClientMessage.PayloadCase.TYPING_SIGNAL) {
                    log("RECV unknown client message arm from $senderUserId; ignored")
                }
                Stored(message)
            }
        }

    /** Network-dependent work after the receive transaction committed. Throws when it failed. */
    private suspend fun followUp(stored: Stored, senderUserId: String, senderDeviceId: String, envelopeId: String) {
        val message = stored.message
        when (payloadDisposition(message.payloadCase)) {
            PayloadDisposition.CONTENT -> stored.wokeModel?.let { newEntries.trySend(it) }
            PayloadDisposition.DROPPABLE -> if (message.payloadCase == ClientMessage.PayloadCase.TYPING_SIGNAL) {
                onTypingSignal(message, senderUserId, senderDeviceId)
            }
            PayloadDisposition.KIT_INTERNAL -> when (stored.friendFollowUp) {
                FriendFollowUp.NONE -> Unit
                FriendFollowUp.SYNC -> syncFriendList()
                // Crossed requests are mutual consent.
                FriendFollowUp.ACCEPT -> acceptFriend(senderUserId)
                FriendFollowUp.REPLY_ACCEPT -> {
                    requireFreshToken()
                    sendFriendAccept(senderUserId)
                    log("FRIEND_REQUEST from known peer $senderUserId (accepted); unchanged, acceptance replied")
                }
            }
        }
    }

    private fun resolvePeerUserId(senderUserId: String, claimedPeerUserId: String): String? {
        if (senderUserId.isBlank()) return null
        val selfUserId = auth.credentials?.userId
        return if (senderUserId == selfUserId) {
            if (claimedPeerUserId.isNotBlank() && claimedPeerUserId != selfUserId) claimedPeerUserId else null
        } else {
            if (claimedPeerUserId.isNotBlank() && claimedPeerUserId != selfUserId && claimedPeerUserId != senderUserId) {
                null
            } else {
                senderUserId
            }
        }
    }

    private fun storeContent(
        message: ClientMessage,
        senderUserId: String,
        senderDeviceId: String,
        envelopeId: String,
    ): Stored {
        if (!content.recordEnvelopeInTransaction(envelopeId)) {
            log("RECV duplicate envelope $envelopeId")
            return Stored(message)
        }
        val sentAt = clampFutureTimestamp(message.timestamp, clock())
        return when (message.payloadCase) {
            ClientMessage.PayloadCase.DIRECT_MESSAGE -> {
                val dm = message.directMessage
                val peer = resolvePeerUserId(senderUserId, dm.peerUserId)
                if (dm.id.isBlank() || peer == null) {
                    log("RECV DIRECT_MESSAGE with blank id or invalid peer from $senderUserId; ignored")
                    Stored(message)
                } else if (!content.canInsertConversationInTransaction(dm.id)) {
                    Stored(message)
                } else {
                    content.insertConversationInTransaction(
                        ConversationItem.message(
                            id = dm.id,
                            peerUserId = peer,
                            authorUserId = senderUserId,
                            sentAt = sentAt,
                            content = dm.content,
                        ),
                    )
                    Stored(message, wokeModel = EntryModel.DIRECT_MESSAGE)
                }
            }
            ClientMessage.PayloadCase.PIX -> {
                val pix = message.pix
                val peer = resolvePeerUserId(senderUserId, pix.peerUserId)
                val att = if (pix.hasAttachment()) MediaAttachment.fromProto(pix.attachment) else null
                if (pix.id.isBlank() || peer == null || att == null) {
                    log("RECV PIX with invalid fields from $senderUserId; ignored")
                    Stored(message)
                } else if (!content.canInsertConversationInTransaction(pix.id)) {
                    Stored(message)
                } else {
                    content.insertConversationInTransaction(
                        ConversationItem.pix(
                            id = pix.id,
                            peerUserId = peer,
                            authorUserId = senderUserId,
                            sentAt = sentAt,
                            attachment = att,
                            caption = pix.caption.ifEmpty { null },
                            captionMeta = pix.captionMeta.ifEmpty { null },
                            displayDuration = pix.displayDurationSecs,
                        ),
                    )
                    Stored(message, wokeModel = EntryModel.PIX)
                }
            }
            ClientMessage.PayloadCase.SEEN_RECEIPT -> {
                val sr = message.seenReceipt
                val peer = resolvePeerUserId(senderUserId, sr.peerUserId)
                if (sr.entryId.isBlank() || peer == null) {
                    log("RECV SEEN_RECEIPT with blank entryId or invalid peer from $senderUserId; ignored")
                    Stored(message)
                } else {
                    val row = content.getConversationInTransaction(sr.entryId)
                    if (row != null && row.peerUserId == peer && row.authorUserId != senderUserId && row.viewedAt == null) {
                        val viewedAt = minOf(sr.viewedAt.coerceAtLeast(0L), sentAt)
                        content.markConversationViewedInTransaction(sr.entryId, viewedAt, expiresAt(row.sentAt, viewedAt))
                        Stored(message, wokeModel = EntryModel.SEEN)
                    } else {
                        Stored(message)
                    }
                }
            }
            ClientMessage.PayloadCase.STORY -> {
                val st = message.story
                if (st.id.isBlank()) {
                    log("RECV STORY with blank id from $senderUserId; ignored")
                    Stored(message)
                } else if (!content.canInsertStoryInTransaction(st.id)) {
                    Stored(message)
                } else {
                    val att = if (st.hasAttachment()) MediaAttachment.fromProto(st.attachment) else null
                    content.insertStoryInTransaction(
                        StoryItem(
                            id = st.id,
                            authorUserId = senderUserId,
                            sentAt = sentAt,
                            content = st.content,
                            attachment = att,
                            captionMeta = st.captionMeta.ifEmpty { null },
                        ),
                    )
                    Stored(message, wokeModel = EntryModel.STORY)
                }
            }
            ClientMessage.PayloadCase.PROFILE -> {
                val pr = message.profile
                val updated = content.upsertProfileIfNewerInTransaction(
                    ProfileItem(
                        userId = senderUserId,
                        authorDeviceId = senderDeviceId,
                        updatedAt = sentAt,
                        displayName = pr.displayName,
                        bio = pr.bio,
                    ),
                )
                Stored(message, wokeModel = if (updated) EntryModel.PROFILE else null)
            }
            else -> Stored(message)
        }
    }

    /**
     * The primary owns the friend list: it applies requests and accepts. A linked device leaves its
     * list alone except for a newer [ClientMessage.PayloadCase.FRIEND_LIST_SYNC] from the primary.
     */
    private fun applyFriendMessage(message: ClientMessage, senderUserId: String, senderDeviceId: String): FriendFollowUp {
        val local = devices.getLocalInTransaction()
        if (message.payloadCase == ClientMessage.PayloadCase.FRIEND_LIST_SYNC) {
            applyFriendListSync(message.friendListSync, local, senderUserId, senderDeviceId)
            return FriendFollowUp.NONE
        }
        if (local?.isPrimary != true) {
            log("${message.payloadCase} from $senderUserId on a linked device; unchanged")
            return FriendFollowUp.NONE
        }
        val existing = friends.getInTransaction(senderUserId)
        return if (message.payloadCase == ClientMessage.PayloadCase.FRIEND_REQUEST) {
            when (existing?.status) {
                null -> {
                    friends.addInTransaction(senderUserId, message.friendRequest.username, FriendStatus.PENDING_RECEIVED)
                    FriendFollowUp.SYNC
                }
                FriendStatus.PENDING_SENT -> FriendFollowUp.ACCEPT
                FriendStatus.ACCEPTED -> FriendFollowUp.REPLY_ACCEPT
                FriendStatus.PENDING_RECEIVED -> {
                    log("FRIEND_REQUEST from known peer $senderUserId (${existing.status.value}); unchanged")
                    FriendFollowUp.NONE
                }
            }
        } else if (existing?.status == FriendStatus.PENDING_SENT) {
            friends.updateStatusInTransaction(senderUserId, FriendStatus.ACCEPTED)
            FriendFollowUp.SYNC
        } else {
            log("FRIEND_ACCEPT from $senderUserId without a pending request; ignored")
            FriendFollowUp.NONE
        }
    }

    private fun applyFriendListSync(sync: FriendListSync, local: LocalDevice?, senderUserId: String, senderDeviceId: String) {
        val records = sync.friendsList.map(WireCodec::decodeFriend)
        val reason = when {
            local == null || local.isPrimary -> "this device is not a linked device"
            senderUserId != auth.credentials?.userId || senderDeviceId != local.primaryDeviceId -> "not from this account's primary"
            java.lang.Long.compareUnsigned(sync.version, friends.versionInTransaction()) <= 0 -> "version ${sync.version} is not newer"
            records.any { it == null } -> "it has an invalid friend record"
            else -> return friends.replaceInTransaction(FriendList(sync.version, records.filterNotNull()))
        }
        log("FRIEND_LIST_SYNC from $senderUserId ignored: $reason")
    }

    private fun onTypingSignal(message: ClientMessage, senderUserId: String, senderDeviceId: String) {
        val signal = message.typingSignal
        if (signal.contextId.isBlank()) return
        when (WireCodec.decodeTypingState(signal.state)) {
            TypingState.STARTED -> typing.started(signal.contextId, senderUserId, senderDeviceId)
            TypingState.STOPPED -> typing.stopped(signal.contextId, senderDeviceId)
            null -> log("TYPING with unspecified state from $senderUserId; ignored")
        }
    }

    /**
     * Signal-Android's `PreKeysSyncJob`: ask the server how many one-time keys it still holds for this
     * device, upload a refill of each kind it is short of and the signed and last-resort keys due for
     * rotation, then clean up old keys.
     */
    private suspend fun syncPreKeys() {
        try {
            requireFreshToken()
            val counts = api.fetchPreKeyCounts()
            val refill = withContext(Dispatchers.IO) { PreKeys.prepareRefill(signalStore, counts, clock()) }
            if (!refill.isEmpty) api.uploadPreKeys(refill.toUpload())
            withContext(Dispatchers.IO) { PreKeys.confirmRefill(signalStore, refill, clock()) }
            if (!refill.isEmpty) log("PREKEYS uploaded (counts were ${counts.oneTime} EC, ${counts.kyber} Kyber)")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            logger.preKeySyncFailed(e.reason())
        }
    }

    private val drainMutex = Mutex()

    /**
     * After a push wake: connect, wait until the receive path has been idle for 500 ms or
     * [timeoutMs] passes, and return how many envelopes were processed. Stays connected.
     */
    suspend fun processPendingMessages(timeoutMs: Long): Int = drainMutex.withLock {
        val start = processedEnvelopes.value
        val deadline = clock() + timeoutMs
        val startedConnected = connectionState.value == ConnectionState.CONNECTED
        if (!startedConnected && !tryConnect()) return 0
        awaitIdle(deadline)
        // A push means the server holds something this device has not acked, so an empty drain on a
        // socket that looked connected and has been quiet means the socket is dead.
        if (startedConnected && processedEnvelopes.value == start &&
            clock() - lastProcessedAtMs > PUSH_RECENT_ACTIVITY_MS
        ) {
            log("PUSH nothing drained on a connected socket; reconnecting")
            gateway.disconnect()
            if (tryConnect()) awaitIdle(deadline)
        }
        (processedEnvelopes.value - start).toInt()
    }

    private suspend fun tryConnect(): Boolean = try {
        connect()
        true
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        log("PUSH connect failed: ${e.message}")
        false
    }

    private suspend fun awaitIdle(deadline: Long) {
        var seen = processedEnvelopes.value
        while (true) {
            val remaining = deadline - clock()
            if (remaining <= 0) return
            seen = withTimeoutOrNull(minOf(PUSH_IDLE_MS, remaining)) { processedEnvelopes.first { it > seen } } ?: return
        }
    }

    suspend fun registerPushToken(token: String) {
        requireFreshToken()
        api.registerPushToken(token)
    }

    suspend fun getMessages(): List<ConversationItem> = content.getMessages()

    suspend fun sendMessage(peerUserId: String, content: String): String {
        if (peerUserId.isBlank()) throw ObscuraError.InvalidArgument("peerUserId must not be blank")
        val self = requireFreshToken()
        if (peerUserId == self.userId) throw ObscuraError.InvalidArgument("Cannot message yourself")
        val sentAt = clock()
        val id = generateEntryId("dm", sentAt)
        val item = ConversationItem.message(
            id = id,
            peerUserId = peerUserId,
            authorUserId = self.userId,
            sentAt = sentAt,
            content = content,
        )
        this.content.putConversation(item)
        val peers = acceptedFriendIds(self.userId).intersect(setOf(peerUserId)).toList()
        val report = sendToPeersAndSelf(self.userId, peers, item.toClientMessage())
        if (peers.isEmpty() || report.recipients.none { it.status == SubmissionStatus.ACCEPTED }) {
            this.content.setConversationUndelivered(id, true)
            throw sendFailed(EntryModel.DIRECT_MESSAGE, report)
        }
        return id
    }

    /**
     * Uploads [file] once, sends it as a pix to each of [peerUserIds] and, if [toStory], posts it as a
     * story with [caption] as its text, so key material never reaches the host. Recipients and the
     * session are checked before the upload, so a reported recipient almost always has a stored pix
     * that `flushOutbox` retries; only a session lost mid-send leaves one unstored.
     */
    suspend fun sendCapture(
        file: File,
        mediaType: MediaType,
        caption: String,
        captionMeta: String?,
        displayDuration: Int,
        peerUserIds: List<String>,
        toStory: Boolean,
    ): CaptureResult {
        val self = requireFreshToken()
        for (peer in peerUserIds) {
            if (peer.isBlank()) throw ObscuraError.InvalidArgument("peerUserId must not be blank")
            if (peer == self.userId) throw ObscuraError.InvalidArgument("Cannot message yourself")
        }
        val attachment = uploadAttachmentFile(file).media(mediaType)
        val undelivered = peerUserIds.filter { peer ->
            !succeeds("send.pix") { sendPix(peer, attachment, caption, captionMeta, displayDuration) }
        }
        val storyUndelivered = toStory && !succeeds("send.story") { postStory(caption, attachment, captionMeta) }
        return CaptureResult(undelivered, storyUndelivered)
    }

    private suspend fun succeeds(event: String, block: suspend () -> Unit): Boolean = try {
        block()
        true
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        log("$event failed: ${e.reason()}")
        false
    }

    suspend fun sendPix(
        peerUserId: String,
        attachment: MediaAttachment,
        caption: String,
        captionMeta: String?,
        displayDuration: Int,
    ): String {
        if (peerUserId.isBlank()) throw ObscuraError.InvalidArgument("peerUserId must not be blank")
        val self = requireFreshToken()
        if (peerUserId == self.userId) throw ObscuraError.InvalidArgument("Cannot message yourself")
        val sentAt = clock()
        val id = generateEntryId("pix", sentAt)
        val item = ConversationItem.pix(
            id = id,
            peerUserId = peerUserId,
            authorUserId = self.userId,
            sentAt = sentAt,
            attachment = attachment,
            caption = caption.ifEmpty { null },
            captionMeta = captionMeta?.ifEmpty { null },
            displayDuration = displayDuration,
        )
        content.putConversation(item)
        val peers = acceptedFriendIds(self.userId).intersect(setOf(peerUserId)).toList()
        val report = sendToPeersAndSelf(self.userId, peers, item.toClientMessage())
        if (peers.isEmpty() || report.recipients.none { it.status == SubmissionStatus.ACCEPTED }) {
            content.setConversationUndelivered(id, true)
            throw sendFailed(EntryModel.PIX, report)
        }
        return id
    }

    suspend fun markSeen(entryId: String) {
        if (entryId.isBlank()) throw ObscuraError.InvalidArgument("entryId must not be blank")
        val self = requireFreshToken()
        val row = content.getConversation(entryId) ?: return
        if (row.authorUserId == self.userId || row.viewedAt != null) return
        val now = clock()
        content.markConversationViewed(entryId, now, expiresAt(row.sentAt, now))
        val message = ClientMessage.newBuilder()
            .setTimestamp(now)
            .setSeenReceipt(
                SeenReceipt.newBuilder()
                    .setEntryId(entryId)
                    .setPeerUserId(row.peerUserId)
                    .setViewedAt(now),
            )
            .build()
        val peers = acceptedFriendIds(self.userId).intersect(setOf(row.peerUserId)).toList()
        sendToPeersAndSelf(self.userId, peers, message)
    }

    suspend fun getStories(now: Long = clock()): List<StoryItem> = content.getStories(now)

    suspend fun postStory(content: String, attachment: MediaAttachment?, captionMeta: String?): String {
        val self = requireFreshToken()
        val sentAt = clock()
        val id = generateEntryId("story", sentAt)
        val item = StoryItem(
            id = id,
            authorUserId = self.userId,
            sentAt = sentAt,
            content = content,
            attachment = attachment,
            captionMeta = captionMeta?.ifEmpty { null },
        )
        this.content.putStory(item)
        val peers = acceptedFriendIds(self.userId).toList()
        val report = sendToPeersAndSelf(self.userId, peers, item.toClientMessage())
        if (peers.isNotEmpty() && report.recipients.none { it.status == SubmissionStatus.ACCEPTED }) {
            this.content.setStoryUndelivered(id, true)
            throw sendFailed(EntryModel.STORY, report)
        }
        return id
    }

    suspend fun getProfiles(): List<ProfileItem> = content.getProfiles()

    suspend fun updateProfile(displayName: String, bio: String) {
        val self = requireFreshToken()
        val existing = content.getProfile(self.userId)
        val sentAt = maxOf(clock(), (existing?.updatedAt ?: 0L) + 1L)
        val item = ProfileItem(
            userId = self.userId,
            authorDeviceId = self.deviceId,
            updatedAt = sentAt,
            displayName = displayName,
            bio = bio,
        )
        content.putProfile(item)
        val peers = acceptedFriendIds(self.userId).toList()
        val report = sendToPeersAndSelf(self.userId, peers, item.toClientMessage())
        if (peers.isNotEmpty() && report.recipients.none { it.status == SubmissionStatus.ACCEPTED }) {
            content.setProfileUndelivered(self.userId, sentAt, true)
            throw sendFailed(EntryModel.PROFILE, report)
        }
    }

    suspend fun flushOutbox(): Int {
        val self = requireFreshToken()
        val accepted = acceptedFriendIds(self.userId)
        var delivered = 0
        for (row in content.getUndeliveredMessages()) {
            val peers = accepted.intersect(setOf(row.peerUserId)).toList()
            if (peers.isEmpty()) continue
            val report = sendToPeersAndSelf(self.userId, peers, row.toClientMessage())
            if (report.recipients.any { it.status == SubmissionStatus.ACCEPTED }) {
                content.setConversationUndelivered(row.id, false)
                delivered++
            }
        }
        for (row in content.getUndeliveredStories()) {
            val peers = accepted.toList()
            val report = sendToPeersAndSelf(self.userId, peers, row.toClientMessage())
            if (peers.isEmpty() || report.recipients.any { it.status == SubmissionStatus.ACCEPTED }) {
                content.setStoryUndelivered(row.id, false)
                delivered++
            }
        }
        for (row in content.getUndeliveredProfiles()) {
            val peers = accepted.toList()
            val report = sendToPeersAndSelf(self.userId, peers, row.toClientMessage())
            if (peers.isEmpty() || report.recipients.any { it.status == SubmissionStatus.ACCEPTED }) {
                content.setProfileUndelivered(row.userId, row.updatedAt, false)
                delivered++
            }
        }
        return delivered
    }

    suspend fun sweepExpired(now: Long = clock()): Set<EntryModel> {
        val outcome = content.sweepExpired(now)
        attachmentCacheDir?.let { dir ->
            for (mediaRef in outcome.purgedMediaRefs) {
                AttachmentCrypto.purgeCached(dir, mediaRef)
            }
        }
        return outcome.touchedModels.toSet()
    }

    private suspend fun acceptedFriendIds(selfUserId: String): Set<String> =
        friends.getAll().asSequence().filter { it.status == FriendStatus.ACCEPTED && it.userId != selfUserId }.map { it.userId }.toSet()

    private suspend fun sendToPeersAndSelf(selfUserId: String, peers: List<String>, message: ClientMessage): SendReport {
        val distinctPeers = peers.distinct().filter { it != selfUserId }
        val results = sender.send(distinctPeers + selfUserId, message)
        val (selfSync, recipients) = results.partition { it.userId == selfUserId }
        return SendReport(recipients, selfSync)
    }

    private fun sendFailed(model: EntryModel, report: SendReport): ObscuraError.SendFailed {
        val reasons = report.recipients.joinToString("; ") { it.error ?: it.status.name.lowercase() }
        return ObscuraError.SendFailed(if (reasons.isEmpty()) "${model.value} reached none of its recipients" else "${model.value} reached none of its recipients: $reasons")
    }

    private fun generateEntryId(prefix: String, now: Long): String {
        val token = java.lang.Long.toUnsignedString(random.nextLong(), 36).take(8).padStart(8, '0')
        return "${prefix}_${now}_$token"
    }

    private fun requireUserId(): String = auth.requireCredentials().userId

    private fun typingConvId(userA: String, userB: String): String =
        if (userA <= userB) "${userA}_$userB" else "${userB}_$userA"

    /** 1:1 convenience wrapper around [sendTyping]. */
    suspend fun sendTyping(peerUserId: String, state: TypingState) {
        if (peerUserId.isBlank()) throw ObscuraError.InvalidArgument("peerUserId must not be blank")
        val selfId = requireUserId()
        sendTyping(listOf(peerUserId), typingConvId(selfId, peerUserId), state)
    }

    /** 1:1 convenience wrapper around [observeTyping]. */
    fun observePeerTyping(peerUserId: String): Flow<Boolean> {
        if (peerUserId.isBlank()) throw ObscuraError.InvalidArgument("peerUserId must not be blank")
        val selfId = requireUserId()
        return observeTyping(typingConvId(selfId, peerUserId)).map { it.contains(peerUserId) }
    }

    /** Throttled per (context, state). A recipient that cannot be reached is logged and skipped. */
    suspend fun sendTyping(recipientUserIds: List<String>, contextId: String, state: TypingState) {
        if (contextId.isBlank()) throw ObscuraError.InvalidArgument("contextId must not be blank")
        val self = auth.requireCredentials()
        if (!typing.shouldSend(contextId, state)) return
        requireFreshToken()
        val message = clientMessage {
            setTypingSignal(typingSignal {
                this.contextId = contextId
                this.state = WireCodec.encodeTypingState(state)
            })
        }
        val peers = recipientUserIds.distinct().filter { it != self.userId }
        val results = sender.send(peers, message)
        for (recipient in peers) {
            val recipientResults = results.filter { it.userId == recipient }
            if (recipientResults.none { it.status == SubmissionStatus.ACCEPTED }) {
                log("TYPING not delivered to $recipient: ${recipientResults.joinToString { it.error ?: it.status.name }}")
            }
        }
    }

    /** The ids of users typing in [contextId], sorted. Each expires 5 s after its last signal. */
    fun observeTyping(contextId: String): Flow<List<String>> {
        if (contextId.isBlank()) throw ObscuraError.InvalidArgument("contextId must not be blank")
        return typing.observe(contextId)
    }

    suspend fun uploadAttachment(plaintext: ByteArray): AttachmentUpload {
        requireFreshToken()
        val encrypted = AttachmentCrypto.encrypt(plaintext)
        return AttachmentUpload(api.uploadAttachment(encrypted.ciphertext), encrypted.contentKey, encrypted.nonce)
    }

    suspend fun uploadAttachmentFile(file: File): AttachmentUpload =
        uploadAttachment(withContext(Dispatchers.IO) { file.readBytes() })

    suspend fun downloadDecryptedAttachment(id: String, contentKey: ByteArray, nonce: ByteArray): ByteArray {
        requireFreshToken()
        return AttachmentCrypto.decrypt(api.fetchAttachment(id), contentKey, nonce)
    }

    /** Decrypts the attachment of entry [entryId] (a pix or story) to the cache, keyed by attachment id. */
    suspend fun downloadAttachmentToCache(entryId: String): File {
        val dir = attachmentCacheDir ?: throw ObscuraError.InvalidArgument("attachmentCacheDir is not configured")
        val att = content.getAttachment(entryId) ?: throw ObscuraError.InvalidArgument("No attachment for entry $entryId")
        withContext(Dispatchers.IO) {
            dir.mkdirs()
            AttachmentCrypto.readCached(dir, att.id)
        }?.let { return it }
        val data = downloadDecryptedAttachment(att.id, att.contentKey, att.nonce)
        return withContext(Dispatchers.IO) { AttachmentCrypto.writeCached(dir, att.id, data) }
    }

    fun friendCode(): String {
        val self = auth.requireCredentials()
        return FriendCode.encode(self.userId, self.username)
    }

    /** Primary only. Whitespace and soft hyphens (added by share sheets) are stripped before decoding. */
    suspend fun addFriendByCode(code: String) {
        requirePrimary()
        val decoded = FriendCode.decode(code.filterNot { it.isWhitespace() || it == '­' })
        befriend(decoded.userId, decoded.username)
    }

    internal suspend fun befriend(targetUserId: String, targetUsername: String) {
        val self = requirePrimary()
        if (targetUserId == self.userId) throw ObscuraError.InvalidArgument("Cannot befriend yourself")
        val existing = friends.prepareRequest(targetUserId, targetUsername)
        when (existing?.status) {
            FriendStatus.ACCEPTED -> return
            FriendStatus.PENDING_RECEIVED -> return acceptFriend(targetUserId)
            FriendStatus.PENDING_SENT, null -> Unit
        }
        try {
            sender.sendOrThrow(targetUserId, clientMessage { setFriendRequest(friendRequest { username = self.username }) })
        } catch (e: Exception) {
            if (existing == null) withContext(NonCancellable) { friends.removePendingRequest(targetUserId) }
            throw e
        }
        if (existing == null) syncFriendList()
    }

    /** Primary only. */
    suspend fun acceptFriend(userId: String) {
        requirePrimary()
        if (friends.get(userId) == null) throw ObscuraError.InvalidArgument("No friend request from $userId")
        sendFriendAccept(userId)
        if (friends.updateStatus(userId, FriendStatus.ACCEPTED)) syncFriendList()
    }

    private suspend fun sendFriendAccept(userId: String) =
        sender.sendOrThrow(userId, clientMessage { setFriendAccept(friendAccept {}) })

    /** Primary only. Forget [userId] and their devices locally. Nothing is sent to them. */
    suspend fun removeFriend(userId: String) {
        requirePrimary()
        val removed = friends.remove(userId)
        devices.removeByUser(userId)
        if (removed) syncFriendList()
    }

    suspend fun getFriends(): List<Friend> = friends.getAll()

    /**
     * Send the whole friend list to this account's other devices after a change. Best effort and
     * logged: every later change sends the whole list again.
     */
    private suspend fun syncFriendList() {
        try {
            val self = requireFreshToken()
            val list = friends.list()
            val sync = FriendListSync.newBuilder().setVersion(list.version).addAllFriends(list.friends.map(WireCodec::encodeFriend))
            sender.send(self.userId, clientMessage { setFriendListSync(sync) })
                .filter { it.status != SubmissionStatus.ACCEPTED }
                .forEach { log("FRIEND_LIST_SYNC v${list.version} not accepted by ${it.deviceId}: ${it.error}") }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            log("FRIEND_LIST_SYNC not sent: ${e.message}")
        }
    }

    private suspend fun requirePrimary(): Credentials {
        val self = requireFreshToken()
        if (!isPrimary()) throw ObscuraError.NotPrimary()
        return self
    }

    private fun clientMessage(build: ClientMessage.Builder.() -> Unit): ClientMessage =
        ClientMessage.newBuilder().setTimestamp(clock()).apply(build).build()

    private fun Throwable.reason(): String = message ?: javaClass.simpleName

    private fun log(message: String) {
        debugLog.addFirst("[${SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(Date(clock()))}] $message")
        while (debugLog.size > DEBUG_LOG_SIZE) debugLog.pollLast()
        logger.log(message)
    }

    companion object {
        /** The name a new device put in its link [code], to show before [approveLink]. No network. */
        fun linkCodeDeviceName(code: String): String = LinkCrypto.decodeCode(code).deviceName

        private val random = SecureRandom()
        private const val MESSAGE_RECEIVED_CAPACITY = 100
        private const val DEBUG_LOG_SIZE = 200
        private const val PUSH_IDLE_MS = 500L
        private const val PUSH_RECENT_ACTIVITY_MS = 10_000L
        private const val LINK_POLL_MS = 250L
    }
}

/**
 * A peer's `sentAt` capped at now + 60 s so it cannot win every later conflict. `ClientMessage.timestamp`
 * is a uint64 that arrives negative above 2^63; that is far future too.
 */
internal fun clampFutureTimestamp(sentAt: Long, nowMs: Long): Long {
    val cap = nowMs + 60_000L
    return if (sentAt < 0) cap else minOf(sentAt, cap)
}

const val EXPIRE_AFTER_VIEW_MS = dev.barrelmaker.obscura.kit.stores.EXPIRE_AFTER_VIEW_MS
const val MAX_EPHEMERAL_AGE_MS = dev.barrelmaker.obscura.kit.stores.MAX_EPHEMERAL_AGE_MS
const val STORY_MAX_AGE_MS = dev.barrelmaker.obscura.kit.stores.STORY_MAX_AGE_MS

fun expiresAt(sentAt: Long, viewedAt: Long?): Long = dev.barrelmaker.obscura.kit.stores.expiresAt(sentAt, viewedAt)
