package dev.barrelmaker.obscura.kit

import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import com.google.protobuf.ByteString
import dev.barrelmaker.obscura.kit.crypto.AttachmentCrypto
import dev.barrelmaker.obscura.kit.crypto.LinkCrypto
import dev.barrelmaker.obscura.kit.crypto.SignalStore
import dev.barrelmaker.obscura.kit.crypto.UuidCodec
import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import dev.barrelmaker.obscura.kit.managers.AuthManager
import dev.barrelmaker.obscura.kit.managers.Credentials
import dev.barrelmaker.obscura.kit.managers.MessageSender
import dev.barrelmaker.obscura.kit.managers.SignalKeyUtils
import dev.barrelmaker.obscura.kit.managers.TokenStatus
import dev.barrelmaker.obscura.kit.messaging.Messenger
import dev.barrelmaker.obscura.kit.network.APIClient
import dev.barrelmaker.obscura.kit.network.GatewayConnection
import dev.barrelmaker.obscura.kit.network.OwnDevice
import dev.barrelmaker.obscura.kit.persistence.SessionStorage
import dev.barrelmaker.obscura.kit.stores.DeviceStore
import dev.barrelmaker.obscura.kit.stores.EntryStore
import dev.barrelmaker.obscura.kit.stores.FriendData
import dev.barrelmaker.obscura.kit.stores.FriendList
import dev.barrelmaker.obscura.kit.stores.FriendStatus
import dev.barrelmaker.obscura.kit.stores.FriendStore
import dev.barrelmaker.obscura.kit.stores.InboxInsert
import dev.barrelmaker.obscura.kit.stores.InboxStore
import dev.barrelmaker.obscura.kit.stores.LocalDevice
import dev.barrelmaker.obscura.kit.stores.StoredEntry
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
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import com.google.protobuf.InvalidProtocolBufferException
import obscura.client.v1.Client.ClientMessage
import obscura.client.v1.Client.EntrySnapshot
import obscura.client.v1.Client.FriendListSync
import obscura.client.v1.Client.HistorySnapshot
import obscura.client.v1.Client.LinkBundle
import obscura.client.v1.Client.LinkCode
import obscura.client.v1.Client.SnapshotEntry
import obscura.client.v1.appEntry
import obscura.client.v1.friendAccept
import obscura.client.v1.friendRequest
import obscura.client.v1.typingSignal
import org.signal.libsignal.protocol.DuplicateMessageException
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.ecc.Curve
import xyz.obscura.server.contracts.ObscuraProtocol.Envelope
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

    val inbox = InboxStore(db) { ids, reason -> log("INBOX discarded ${ids.size} row(s) ($reason): $ids") }
    val entries = EntryStore(db, sqlDriver)

    internal val auth: AuthManager
    internal val api: APIClient
    private val gateway: GatewayConnection
    private val messenger: Messenger
    internal val sender: MessageSender
    private val typing = TypingTracker(scope)

    init {
        lateinit var authRef: AuthManager
        api = APIClient(config.apiUrl, refresh = { authRef.refresh() }) { authRef.credentials?.token }
        auth = AuthManager(
            api, signalStore, devices, sessionStorage, config.deviceName, scope,
            logger = { logger },
            onRejected = { credentials, generation -> endSession(revoke = false, expected = credentials, expectedGeneration = generation) },
        )
        authRef = auth
        gateway = GatewayConnection(api, scope, beforeConnect = { requireFreshToken() }, log = ::log)
        messenger = Messenger(signalStore, api)
        sender = MessageSender(api, messenger, devices) { auth.credentials?.deviceId }
    }

    val authState: StateFlow<AuthState> get() = auth.state
    val connectionState: StateFlow<ConnectionState> get() = gateway.state

    val userId: String? get() = auth.credentials?.userId
    val deviceId: String? get() = auth.credentials?.deviceId
    val username: String? get() = auth.credentials?.username

    /** Payload-free; emits on collection and on every friend change. Call [getFriends] for the rows. */
    val friendsChanged: Flow<Unit> = friends.changes

    private val newEntries = Channel<String>(MESSAGE_RECEIVED_CAPACITY, BufferOverflow.DROP_OLDEST)

    /** The model key of each newly inboxed APP_ENTRY row. One consumer. The inbox is the delivery path. */
    val messageReceived: ReceiveChannel<String> = newEntries

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
        val ephemeral = Curve.generateKeyPair()
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
            SignalKeyUtils.generateProvisioningKeys(identity), request.sessionId,
        ) { friends.replaceInTransaction(friendList) }
        try {
            if (bundle.hasHistory()) importHistory(bundle.history)
            connect()
        } finally {
            auth.publishAuthenticated()
        }
    }

    private suspend fun awaitApproval(request: LinkRequest): ByteArray {
        while (System.currentTimeMillis() / 1000 < request.expiresAt) {
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

    private suspend fun importHistory(history: HistorySnapshot) {
        val plaintext = downloadDecryptedAttachment(history.attachmentId, history.contentKey.toByteArray(), history.nonce.toByteArray())
        val snapshot = try {
            EntrySnapshot.parseFrom(plaintext)
        } catch (e: InvalidProtocolBufferException) {
            throw ObscuraError.ProtocolViolation("Invalid history snapshot", e)
        }
        entries.import(snapshot.entriesList.map {
            it.model to StoredEntry(it.id, it.data.toStringUtf8(), it.sentAt, it.authorUserId, it.authorDeviceId)
        })
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
        exportHistory()?.let { bundle.setHistory(it) }
        val envelope = LinkCrypto.seal(bundle.build().toByteArray(), LinkCrypto.publicKey(link))
        try {
            api.approveLinkSession(link.sessionId, envelope.toByteArray())
        } catch (e: ObscuraError.Http) {
            if (e.status == 404) throw ObscuraError.LinkFailed("Link session expired or unknown", e)
            throw e
        }
    }

    /** The whole entry store as an encrypted attachment; null when it is empty. */
    private suspend fun exportHistory(): HistorySnapshot? {
        val all = entries.export().ifEmpty { return null }
        val snapshot = EntrySnapshot.newBuilder().addAllEntries(all.map { (model, entry) ->
            SnapshotEntry.newBuilder()
                .setModel(model)
                .setId(entry.id)
                .setData(ByteString.copyFromUtf8(entry.data))
                .setSentAt(entry.sentAt)
                .setAuthorUserId(entry.authorUserId)
                .setAuthorDeviceId(entry.authorDeviceId)
                .build()
        }).build()
        val upload = uploadAttachment(snapshot.toByteArray())
        return HistorySnapshot.newBuilder()
            .setAttachmentId(upload.id)
            .setContentKey(ByteString.copyFrom(upload.contentKey))
            .setNonce(ByteString.copyFrom(upload.nonce))
            .build()
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
                db.modelEntryQueries.deleteAllEntries()
                db.inboxQueries.deleteAll()
                signalStore.clear()
            }
            sqlDriver.truncateWal()
        }
    }

    private suspend fun endSession(revoke: Boolean, expected: Credentials? = null, expectedGeneration: Long? = null) {
        val previous = try {
            auth.end(expected, expectedGeneration)
        } finally {
            if (auth.credentials == null) {
                gateway.disconnect()
                val stopping = synchronized(this) {
                    val jobs = listOfNotNull(receiveJob, replenishJob)
                    jobs.forEach { it.cancel() }
                    receiveJob = null
                    replenishJob = null
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
        gateway.connect()
        log("CONNECTED")
    }

    /** Closes the socket and stops reconnection. */
    fun disconnect() {
        gateway.disconnect()
        log("DISCONNECTED")
    }

    private var receiveJob: Job? = null
    private var replenishJob: Job? = null
    private val processedEnvelopes = MutableStateFlow(0L)
    @Volatile private var lastProcessedAtMs = 0L

    private fun startReceiving() = synchronized(this) {
        if (receiveJob?.isActive == true) return
        receiveJob = scope.launch {
            launch { for (envelope in gateway.envelopes) receive(envelope) }
            launch {
                for (status in gateway.preKeyStatus) {
                    if (status.oneTimePreKeyCount < status.minThreshold) replenishPreKeys { true }
                }
            }
        }
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
            if (inbox.contains(envelopeId)) {
                acknowledge(envelope.id, envelopeId, ack)
                return
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            log("RECV duplicate lookup failed for $envelopeId: ${e.message}")
            logger.databaseError("inbox", "contains", e.message ?: e.javaClass.simpleName)
            return
        }
        var stage = "directory"
        val stored = try {
            messenger.decryptAndCommit(senderDeviceId, envelope.message, record = {
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
                logger.decryptFailed(senderUserId, e.message ?: e.javaClass.simpleName)
            } else {
                log("RECV $stage not stored: ${e.message}")
                logger.databaseError(stage, "receive", e.message ?: e.javaClass.simpleName)
            }
            return
        }
        try {
            if (stored != null) followUp(stored, senderUserId, senderDeviceId, envelopeId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            log("RECV ${stored?.message?.payloadCase?.name} not stored: ${e.message}")
            logger.databaseError("receive", stored?.message?.payloadCase?.name ?: "UNKNOWN", e.message ?: e.javaClass.simpleName)
            return
        }
        replenishPreKeys { signalStore.getPreKeyCount() < PREKEY_MIN_COUNT }
        acknowledge(envelope.id, envelopeId, ack)
    }

    private suspend fun acknowledge(id: ByteString, envelopeId: String, ack: suspend (ByteString) -> Unit) {
        try {
            ack(id)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            log("RECV ack failed for $envelopeId: ${e.message}")
            logger.ackFailed(envelopeId, e.message ?: e.javaClass.simpleName)
        }
        markProcessed()
    }

    private fun markProcessed() {
        lastProcessedAtMs = System.currentTimeMillis()
        processedEnvelopes.value++
    }

    /** A decrypted message after its durable writes, and the network work that follows them. */
    private class Stored(val message: ClientMessage, val inserted: Boolean = false, val friendFollowUp: FriendFollowUp = FriendFollowUp.NONE)

    private enum class FriendFollowUp { NONE, SYNC, ACCEPT, REPLY_ACCEPT }

    /** [store] then [followUp] for a decrypted message outside a decrypt transaction. Throws when it could not be stored. */
    internal suspend fun route(message: ClientMessage, senderUserId: String, senderDeviceId: String, envelopeId: String) {
        val stored = withContext(Dispatchers.IO) { db.transactionWithResult { store(message, senderUserId, senderDeviceId, envelopeId) } }
        followUp(stored, senderUserId, senderDeviceId, envelopeId)
    }

    /** The local, synchronous part of handling a message; runs inside the receive transaction. */
    private fun store(message: ClientMessage, senderUserId: String, senderDeviceId: String, envelopeId: String): Stored =
        when (payloadDisposition(message.payloadCase)) {
            PayloadDisposition.INBOXED -> {
                val entry = message.appEntry
                if (entry.model.isBlank() || entry.id.isBlank()) {
                    log("RECV APP_ENTRY with blank model or id from $senderUserId; ignored")
                    Stored(message)
                } else {
                    Stored(message, inserted = inbox.putInTransaction(inboxRecord(entry, senderUserId, senderDeviceId, envelopeId)))
                }
            }
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
            PayloadDisposition.INBOXED -> wakeInbox(message, envelopeId, stored.inserted)
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

    private fun inboxRecord(
        entry: obscura.client.v1.Client.AppEntry,
        senderUserId: String,
        senderDeviceId: String,
        envelopeId: String,
    ): InboxInsert = InboxInsert(
        envelopeId = envelopeId,
        senderUserId = senderUserId,
        senderDeviceId = senderDeviceId,
        modelKey = entry.model,
        entryId = entry.id,
        sentAt = clampFutureTimestamp(entry.timestamp),
        payload = entry.data.toByteArray(),
    )

    private fun wakeInbox(message: ClientMessage, envelopeId: String, inserted: Boolean) {
        when {
            !inserted && message.appEntry.model.isNotBlank() && message.appEntry.id.isNotBlank() ->
                log("RECV duplicate envelope $envelopeId")
            inserted -> newEntries.trySend(message.appEntry.model)
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

    /** At most one replenish in flight; a backlog of envelopes would otherwise upload the same ids N times. */
    private fun replenishPreKeys(needed: () -> Boolean) = synchronized(this) {
        if (auth.credentials == null || replenishJob?.isActive == true) return
        replenishJob = scope.launch {
            try {
                if (needed()) {
                    requireFreshToken()
                    val keys = SignalKeyUtils.generateMorePreKeys(signalStore, PREKEY_REPLENISH_COUNT)
                    api.uploadPreKeys(keys)
                    signalStore.retireSignedPreKeys(keys.signedPreKey.keyId)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                logger.preKeyReplenishFailed(e.message ?: e.javaClass.simpleName)
            }
        }
    }

    private val drainMutex = Mutex()

    /**
     * After a push wake: connect, wait until the receive path has been idle for 500 ms or
     * [timeoutMs] passes, and return how many envelopes were processed. Stays connected.
     */
    suspend fun processPendingMessages(timeoutMs: Long): Int = drainMutex.withLock {
        val start = processedEnvelopes.value
        val deadline = System.currentTimeMillis() + timeoutMs
        val startedConnected = connectionState.value == ConnectionState.CONNECTED
        if (!startedConnected && !tryConnect()) return 0
        awaitIdle(deadline)
        // A push means the server holds something this device has not acked, so an empty drain on a
        // socket that looked connected and has been quiet means the socket is dead.
        if (startedConnected && processedEnvelopes.value == start &&
            System.currentTimeMillis() - lastProcessedAtMs > PUSH_RECENT_ACTIVITY_MS
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
            val remaining = deadline - System.currentTimeMillis()
            if (remaining <= 0) return
            seen = withTimeoutOrNull(minOf(PUSH_IDLE_MS, remaining)) { processedEnvelopes.first { it > seen } } ?: return
        }
    }

    suspend fun registerPushToken(token: String) {
        requireFreshToken()
        api.registerPushToken(token)
    }

    /**
     * Send an entry to every device of [recipientUserIds] and to this user's other devices.
     * No inbox row is written here; the app stores its own copy in [entries].
     */
    suspend fun send(
        recipientUserIds: List<String>,
        modelKey: String,
        entryId: String,
        sentAt: Long,
        payload: ByteArray,
    ): SendReport {
        val self = requireFreshToken()
        val message = clientMessage {
            setAppEntry(appEntry {
                model = modelKey
                id = entryId
                timestamp = sentAt
                data = ByteString.copyFrom(payload)
            })
        }
        val peers = recipientUserIds.distinct().filter { it != self.userId }
        val results = sender.send(peers + self.userId, message)
        val (selfSync, recipients) = results.partition { it.userId == self.userId }
        return SendReport(recipients, selfSync)
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

    suspend fun downloadDecryptedAttachment(id: String, contentKey: ByteArray, nonce: ByteArray): ByteArray {
        requireFreshToken()
        return AttachmentCrypto.decrypt(api.fetchAttachment(id), contentKey, nonce)
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

    suspend fun getFriends(): List<FriendData> = friends.getAll()

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
        ClientMessage.newBuilder().setTimestamp(System.currentTimeMillis()).apply(build).build()

    private fun log(message: String) {
        debugLog.addFirst("[${SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(Date())}] $message")
        while (debugLog.size > DEBUG_LOG_SIZE) debugLog.pollLast()
        logger.log(message)
    }

    companion object {
        /** The name a new device put in its link [code], to show before [approveLink]. No network. */
        fun linkCodeDeviceName(code: String): String = LinkCrypto.decodeCode(code).deviceName

        private const val MESSAGE_RECEIVED_CAPACITY = 100
        private const val DEBUG_LOG_SIZE = 200
        private const val PREKEY_MIN_COUNT = 20L
        private const val PREKEY_REPLENISH_COUNT = 50
        private const val PUSH_IDLE_MS = 500L
        private const val PUSH_RECENT_ACTIVITY_MS = 10_000L
        private const val LINK_POLL_MS = 250L
    }
}

/**
 * A peer's `sentAt` capped at now + 60 s so it cannot win every later conflict. `AppEntry.timestamp`
 * is a uint64 that arrives negative above 2^63; that is far future too.
 */
internal fun clampFutureTimestamp(sentAt: Long, nowMs: Long = System.currentTimeMillis()): Long {
    val cap = nowMs + 60_000L
    return if (sentAt < 0) cap else minOf(sentAt, cap)
}
