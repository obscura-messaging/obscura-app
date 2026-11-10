package dev.barrelmaker.obscura.kit.crypto

import dev.barrelmaker.obscura.kit.SignalPreKeyState
import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import org.signal.libsignal.protocol.IdentityKey
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.InvalidKeyIdException
import org.signal.libsignal.protocol.NoSessionException
import org.signal.libsignal.protocol.ReusedBaseKeyException
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.ecc.ECPublicKey
import org.signal.libsignal.protocol.groups.state.SenderKeyRecord
import org.signal.libsignal.protocol.state.IdentityKeyStore
import org.signal.libsignal.protocol.state.KyberPreKeyRecord
import org.signal.libsignal.protocol.state.PreKeyRecord
import org.signal.libsignal.protocol.state.SessionRecord
import org.signal.libsignal.protocol.state.SignalProtocolStore
import org.signal.libsignal.protocol.state.SignedPreKeyRecord
import java.security.MessageDigest
import java.util.UUID

/**
 * All libsignal store interfaces over SQLite. Peer identities are trusted per account: an address
 * `<deviceUuid>.1` resolves to its user through the device directory.
 *
 * Pre-keys are kept and cleaned up as Signal-Android keeps them: one-time keys go stale when a newer
 * batch replaces them on the server, and old signed and last-resort keys are kept a while for
 * messages already in flight.
 */
internal class SignalStore(private val db: ObscuraDatabase) : SignalProtocolStore {
    private val queries = db.signalKeyQueries

    @Volatile private var localIdentity: Pair<IdentityKeyPair, Int>? =
        queries.selectLocalIdentity().executeAsOneOrNull()?.let { IdentityKeyPair(it.identity_key_pair) to it.registration_id.toInt() }

    /** Called with the user whose account identity key changed (an account reset). */
    var onIdentityChanged: (String) -> Unit = {}

    fun hasIdentity(): Boolean = localIdentity != null && queries.selectLocalIdentity().executeAsOneOrNull() != null

    /** Keep ratchet changes and the corresponding durable receive writes in the same transaction. */
    internal fun <T> transaction(block: () -> T): T = db.transactionWithResult { block() }

    /** Joins an enclosing transaction; the identity is in use only once that commits. */
    fun installIdentity(identity: IdentityKeyPair, registrationId: Int) = db.transaction {
        queries.insertLocalIdentity(identity.serialize(), registrationId.toLong())
        afterCommit { localIdentity = identity to registrationId }
    }

    /** Delete every key, session and identity, this device's included. */
    fun clear() {
        db.transaction {
            queries.deleteLocalIdentity()
            queries.deleteAllIdentities()
            queries.deleteAllPreKeys()
            queries.deleteAllSignedPreKeys()
            queries.deleteAllKyberPreKeys()
            queries.deleteAllLastResortKeyUses()
            queries.deletePreKeyState()
            queries.deleteAllSessions()
        }
        localIdentity = null
    }

    override fun getIdentityKeyPair(): IdentityKeyPair = checkNotNull(localIdentity) { "Identity not initialized" }.first
    override fun getLocalRegistrationId(): Int = checkNotNull(localIdentity) { "Identity not initialized" }.second

    /**
     * A key that differs from the account's stored one replaces it for the whole account: every
     * session with the user's devices is dropped, as after an account reset.
     */
    override fun saveIdentity(address: SignalProtocolAddress, identityKey: IdentityKey): IdentityKeyStore.IdentityChange {
        val userId = userOf(address)
        val changed = db.transactionWithResult {
            val existing = queries.selectIdentityByUser(userId).executeAsOneOrNull()
            if (existing != null && MessageDigest.isEqual(existing, identityKey.serialize())) return@transactionWithResult false
            queries.insertIdentity(userId, identityKey.serialize())
            if (existing != null) {
                queries.deleteSessionsOfUser(userId)
                db.deviceQueries.deleteOtherDevicesOfUser(userId, address.name)
            }
            existing != null
        }
        if (!changed) return IdentityKeyStore.IdentityChange.NEW_OR_UNCHANGED
        onIdentityChanged(userId)
        return IdentityKeyStore.IdentityChange.REPLACED_EXISTING
    }

    // An unverified contact's changed identity is accepted and reported; refusing it would leave the
    // peer unreachable with no way to recover.
    override fun isTrustedIdentity(
        address: SignalProtocolAddress,
        identityKey: IdentityKey,
        direction: IdentityKeyStore.Direction,
    ): Boolean = true

    override fun getIdentity(address: SignalProtocolAddress): IdentityKey? =
        db.deviceQueries.selectUser(address.name).executeAsOneOrNull()
            ?.let { queries.selectIdentityByUser(it).executeAsOneOrNull() }?.let(::IdentityKey)

    private fun userOf(address: SignalProtocolAddress): String =
        db.deviceQueries.selectUser(address.name).executeAsOneOrNull()
            ?: throw IllegalStateException("Device ${address.name} is not in the directory")

    // ── One-time EC pre-keys ────────────────────────────────────────────

    override fun loadPreKey(preKeyId: Int): PreKeyRecord =
        queries.selectPreKey(preKeyId.toLong()).executeAsOneOrNull()?.let(::PreKeyRecord)
            ?: throw InvalidKeyIdException("No prekey with id: $preKeyId")

    override fun storePreKey(preKeyId: Int, record: PreKeyRecord) = queries.insertPreKey(preKeyId.toLong(), record.serialize())
    override fun containsPreKey(preKeyId: Int): Boolean = queries.selectPreKey(preKeyId.toLong()).executeAsOneOrNull() != null
    override fun removePreKey(preKeyId: Int) = queries.deletePreKey(preKeyId.toLong())

    // ── Signed EC pre-keys ──────────────────────────────────────────────

    override fun loadSignedPreKey(signedPreKeyId: Int): SignedPreKeyRecord =
        queries.selectSignedPreKey(signedPreKeyId.toLong()).executeAsOneOrNull()?.let(::SignedPreKeyRecord)
            ?: throw InvalidKeyIdException("No signed prekey with id: $signedPreKeyId")

    override fun loadSignedPreKeys(): List<SignedPreKeyRecord> =
        queries.selectAllSignedPreKeys().executeAsList().map(::SignedPreKeyRecord)

    override fun storeSignedPreKey(signedPreKeyId: Int, record: SignedPreKeyRecord) =
        queries.insertSignedPreKey(signedPreKeyId.toLong(), record.serialize())

    override fun containsSignedPreKey(signedPreKeyId: Int): Boolean =
        queries.selectSignedPreKey(signedPreKeyId.toLong()).executeAsOneOrNull() != null

    override fun removeSignedPreKey(signedPreKeyId: Int) = queries.deleteSignedPreKey(signedPreKeyId.toLong())

    // ── Kyber pre-keys ──────────────────────────────────────────────────

    override fun loadKyberPreKey(kyberPreKeyId: Int): KyberPreKeyRecord =
        queries.selectKyberPreKey(kyberPreKeyId.toLong()).executeAsOneOrNull()?.let(::KyberPreKeyRecord)
            ?: throw InvalidKeyIdException("No Kyber prekey with id: $kyberPreKeyId")

    override fun loadKyberPreKeys(): List<KyberPreKeyRecord> =
        queries.selectAllKyberPreKeys().executeAsList().map(::KyberPreKeyRecord)

    fun loadLastResortKyberPreKeys(): List<KyberPreKeyRecord> =
        queries.selectLastResortKyberPreKeys().executeAsList().map(::KyberPreKeyRecord)

    /** Stores a one-time Kyber pre-key. Last-resort keys go through [storeLastResortKyberPreKey]. */
    override fun storeKyberPreKey(kyberPreKeyId: Int, record: KyberPreKeyRecord) =
        queries.insertKyberPreKey(kyberPreKeyId.toLong(), record.serialize(), 0)

    fun storeLastResortKyberPreKey(kyberPreKeyId: Int, record: KyberPreKeyRecord) =
        queries.insertKyberPreKey(kyberPreKeyId.toLong(), record.serialize(), 1)

    override fun containsKyberPreKey(kyberPreKeyId: Int): Boolean =
        queries.selectKyberPreKey(kyberPreKeyId.toLong()).executeAsOneOrNull() != null

    /**
     * A one-time key is deleted. A last-resort key stays, so each session started with it is
     * recorded instead, and one started again with the same keys and base key is a replay.
     */
    override fun markKyberPreKeyUsed(kyberPreKeyId: Int, signedPreKeyId: Int, baseKey: ECPublicKey) = db.transaction {
        val id = kyberPreKeyId.toLong()
        if (queries.isLastResortKyberPreKey(id).executeAsOneOrNull() != 1L) {
            queries.deleteOneTimeKyberPreKey(id)
            return@transaction
        }
        val base = baseKey.serialize()
        if (queries.hasLastResortKeyUse(id, signedPreKeyId.toLong(), base).executeAsOne()) {
            throw ReusedBaseKeyException("Base key reused with last-resort Kyber prekey $kyberPreKeyId")
        }
        queries.insertLastResortKeyUse(id, signedPreKeyId.toLong(), base)
    }

    fun removeKyberPreKey(kyberPreKeyId: Int) = db.transaction {
        queries.deleteKyberPreKey(kyberPreKeyId.toLong())
        queries.deleteLastResortKeyUses(kyberPreKeyId.toLong())
    }

    // ── Pre-key bookkeeping ─────────────────────────────────────────────

    fun preKeyState(): SignalPreKeyState? = queries.selectPreKeyState().executeAsOneOrNull()

    fun savePreKeyState(state: SignalPreKeyState) = queries.insertPreKeyState(
        state.next_signed_id, state.next_one_time_id, state.next_kyber_id, state.active_signed_id,
        state.active_last_resort_id, state.signed_rotated_at, state.last_resort_rotated_at, state.synced_at,
    )

    /** The one-time EC keys stored so far, about to be replaced on the server by a new batch. */
    fun markOneTimeEcPreKeysStale(nowMs: Long) = queries.markPreKeysStale(nowMs)

    /** The one-time Kyber keys stored so far, about to be replaced on the server by a new batch. */
    fun markOneTimeKyberPreKeysStale(nowMs: Long) = queries.markKyberPreKeysStale(nowMs)

    /**
     * Signal-Android's cleanup. Signed and last-resort keys other than the active one are deleted
     * once older than [ARCHIVE_AGE_MS], except the youngest of those, which may still be named by a
     * message in flight. One-time keys stale for longer than [STALE_ONE_TIME_AGE_MS] are deleted,
     * keeping at least [MIN_ONE_TIME_KEPT] of each kind.
     */
    fun cleanPreKeys(nowMs: Long) = db.transaction {
        val state = preKeyState()
        state?.active_signed_id?.let { active ->
            archived(loadSignedPreKeys(), active, nowMs, { it.id }, { it.timestamp }).forEach { removeSignedPreKey(it.id) }
        }
        state?.active_last_resort_id?.let { active ->
            archived(loadLastResortKyberPreKeys(), active, nowMs, { it.id }, { it.timestamp }).forEach { removeKyberPreKey(it.id) }
        }
        val cutoff = nowMs - STALE_ONE_TIME_AGE_MS
        queries.deleteStalePreKeys(cutoff, MIN_ONE_TIME_KEPT)
        queries.deleteStaleKyberPreKeys(cutoff, MIN_ONE_TIME_KEPT)
    }

    private fun <T> archived(records: List<T>, activeId: Long, nowMs: Long, id: (T) -> Int, createdAt: (T) -> Long): List<T> =
        records.filter { id(it).toLong() != activeId && nowMs - createdAt(it) > ARCHIVE_AGE_MS }
            .sortedByDescending(createdAt)
            .drop(1)

    // ── Sessions ────────────────────────────────────────────────────────

    override fun loadSession(address: SignalProtocolAddress): SessionRecord =
        queries.selectSession(address.key()).executeAsOneOrNull()?.let(::SessionRecord) ?: SessionRecord()

    override fun loadExistingSessions(addresses: List<SignalProtocolAddress>): List<SessionRecord> = addresses.map {
        queries.selectSession(it.key()).executeAsOneOrNull()?.let(::SessionRecord)
            ?: throw NoSessionException("No session for: ${it.key()}")
    }

    // Every address is `<deviceUuid>.1`, so there are no sub-device sessions.
    override fun getSubDeviceSessions(name: String): List<Int> = emptyList()

    override fun storeSession(address: SignalProtocolAddress, record: SessionRecord) =
        queries.insertSession(address.key(), record.serialize())

    override fun containsSession(address: SignalProtocolAddress): Boolean =
        queries.selectSession(address.key()).executeAsOneOrNull() != null

    override fun deleteSession(address: SignalProtocolAddress) = queries.deleteSession(address.key())

    fun deleteAllSessions() = queries.deleteAllSessions()

    override fun deleteAllSessions(name: String) = queries.deleteSessionsByPrefix("$name.%")

    override fun storeSenderKey(sender: SignalProtocolAddress, distributionId: UUID, record: SenderKeyRecord) =
        throw UnsupportedOperationException("No sender keys")

    override fun loadSenderKey(sender: SignalProtocolAddress, distributionId: UUID): SenderKeyRecord? =
        throw UnsupportedOperationException("No sender keys")

    private fun SignalProtocolAddress.key() = "$name.$deviceId"

    companion object {
        /** How long a replaced signed or last-resort key is kept: the server's queued-message TTL. */
        const val ARCHIVE_AGE_MS = 30L * 24 * 60 * 60 * 1000

        /** How long a replaced one-time key is kept, as in Signal-Android. */
        const val STALE_ONE_TIME_AGE_MS = 90L * 24 * 60 * 60 * 1000

        const val MIN_ONE_TIME_KEPT = 200L
    }
}
