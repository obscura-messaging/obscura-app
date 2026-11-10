package dev.barrelmaker.obscura.kit.managers

import dev.barrelmaker.obscura.kit.SignalPreKeyState
import dev.barrelmaker.obscura.kit.crypto.SignalStore
import dev.barrelmaker.obscura.kit.crypto.toBase64
import dev.barrelmaker.obscura.kit.network.DeviceKeys
import dev.barrelmaker.obscura.kit.network.KyberPreKeyJson
import dev.barrelmaker.obscura.kit.network.OneTimePreKeyJson
import dev.barrelmaker.obscura.kit.network.PreKeyCounts
import dev.barrelmaker.obscura.kit.network.PreKeyUpload
import dev.barrelmaker.obscura.kit.network.SignedPreKeyJson
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.ecc.ECKeyPair
import org.signal.libsignal.protocol.ecc.ECPrivateKey
import org.signal.libsignal.protocol.kem.KEMKeyPair
import org.signal.libsignal.protocol.kem.KEMKeyType
import org.signal.libsignal.protocol.state.KyberPreKeyRecord
import org.signal.libsignal.protocol.state.PreKeyRecord
import org.signal.libsignal.protocol.state.SignedPreKeyRecord
import org.signal.libsignal.protocol.util.KeyHelper
import org.signal.libsignal.protocol.util.Medium
import java.security.SecureRandom

/** A new device's keys, held in memory until the server has accepted the device. */
internal class ProvisioningKeys(
    val identity: IdentityKeyPair,
    val registrationId: Int,
    val signedPreKey: SignedPreKeyRecord,
    val lastResortKyberPreKey: KyberPreKeyRecord,
    val oneTimePreKeys: List<PreKeyRecord>,
    val kyberPreKeys: List<KyberPreKeyRecord>,
    /** The bookkeeping to store once the server has accepted these keys. */
    val state: SignalPreKeyState,
) {
    fun toDeviceKeys() = DeviceKeys(
        identityKey = identity.publicKey.serialize().toBase64(),
        registrationId = registrationId,
        signedPreKey = signedPreKey.toApiJson(),
        lastResortKyberPreKey = lastResortKyberPreKey.toApiJson(),
        oneTimePreKeys = oneTimePreKeys.map { it.toApiJson() },
        kyberPreKeys = kyberPreKeys.map { it.toApiJson() },
    )
}

/** The keys a sync generated and stored; what is absent is left as it is on the server. */
internal class PreKeyRefill(
    val signedPreKey: SignedPreKeyRecord?,
    val lastResortKyberPreKey: KyberPreKeyRecord?,
    val oneTimePreKeys: List<PreKeyRecord>,
    val kyberPreKeys: List<KyberPreKeyRecord>,
) {
    val isEmpty: Boolean get() = signedPreKey == null && lastResortKyberPreKey == null && oneTimePreKeys.isEmpty() && kyberPreKeys.isEmpty()

    fun toUpload() = PreKeyUpload(
        signedPreKey = signedPreKey?.toApiJson(),
        lastResortKyberPreKey = lastResortKyberPreKey?.toApiJson(),
        oneTimePreKeys = oneTimePreKeys.map { it.toApiJson() },
        kyberPreKeys = kyberPreKeys.map { it.toApiJson() },
    )
}

/**
 * Pre-key generation and rotation, following Signal-Android's `PreKeyUtil` and `PreKeysSyncJob`:
 * ids start at a random point and wrap at [Medium.MAX_VALUE]; one-time keys come in batches of
 * [BATCH_SIZE] and are refilled when the server holds fewer than [ONE_TIME_MINIMUM]; the signed and
 * last-resort keys rotate every [REFRESH_INTERVAL_MS]. One-time and last-resort Kyber keys share one
 * id counter, since libsignal looks both up by id in one store.
 */
internal object PreKeys {
    const val BATCH_SIZE = 100
    const val ONE_TIME_MINIMUM = 10
    const val REFRESH_INTERVAL_MS = 2L * 24 * 60 * 60 * 1000

    private val random = SecureRandom()

    /**
     * A registration id, signed and last-resort pre-keys and a batch of each kind of one-time key,
     * signed by [identity]: a new identity for a primary, the account identity for a linked device.
     */
    fun generateProvisioningKeys(identity: IdentityKeyPair, nowMs: Long = System.currentTimeMillis()): ProvisioningKeys {
        val signedId = random.nextInt(Medium.MAX_VALUE)
        val oneTimeStart = random.nextInt(Medium.MAX_VALUE)
        val kyberStart = random.nextInt(Medium.MAX_VALUE)
        val lastResortId = kyberStart
        val kyberIds = ids(next(lastResortId), BATCH_SIZE)
        val oneTimeIds = ids(oneTimeStart, BATCH_SIZE)
        return ProvisioningKeys(
            identity = identity,
            registrationId = KeyHelper.generateRegistrationId(false),
            signedPreKey = signedPreKey(identity.privateKey, signedId, nowMs),
            lastResortKyberPreKey = kyberPreKey(identity.privateKey, lastResortId, nowMs),
            oneTimePreKeys = oneTimeIds.map { PreKeyRecord(it, ECKeyPair.generate()) },
            kyberPreKeys = kyberIds.map { kyberPreKey(identity.privateKey, it, nowMs) },
            state = SignalPreKeyState(
                id = 1L,
                next_signed_id = next(signedId).toLong(),
                next_one_time_id = next(oneTimeIds.last()).toLong(),
                next_kyber_id = next(kyberIds.last()).toLong(),
                active_signed_id = signedId.toLong(),
                active_last_resort_id = lastResortId.toLong(),
                signed_rotated_at = nowMs,
                last_resort_rotated_at = nowMs,
                synced_at = nowMs,
            ),
        )
    }

    /** Joins an enclosing transaction. */
    fun install(store: SignalStore, keys: ProvisioningKeys) = store.transaction {
        store.installIdentity(keys.identity, keys.registrationId)
        store.storeSignedPreKey(keys.signedPreKey.id, keys.signedPreKey)
        store.storeLastResortKyberPreKey(keys.lastResortKyberPreKey.id, keys.lastResortKyberPreKey)
        keys.oneTimePreKeys.forEach { store.storePreKey(it.id, it) }
        keys.kyberPreKeys.forEach { store.storeKyberPreKey(it.id, it) }
        store.savePreKeyState(keys.state)
    }

    /** Whether a sync is due without a reason from the server: nothing published yet, or the last one is old. */
    fun isSyncDue(store: SignalStore, nowMs: Long): Boolean {
        val state = store.preKeyState() ?: return false
        return state.active_signed_id == null || state.active_last_resort_id == null || isDue(state.synced_at, nowMs)
    }

    /**
     * Generates and stores what the server needs given its [counts]: new one-time keys of a kind it
     * is short of, and a new signed or last-resort key once the current one is due for rotation.
     * Earlier one-time keys of a refilled kind are marked stale, since the upload replaces them.
     */
    fun prepareRefill(store: SignalStore, counts: PreKeyCounts, nowMs: Long): PreKeyRefill = store.transaction {
        var state = checkNotNull(store.preKeyState()) { "Pre-keys not provisioned" }
        val identity = store.identityKeyPair.privateKey

        val signed = if (state.active_signed_id == null || isDue(state.signed_rotated_at, nowMs)) {
            val id = state.next_signed_id.toInt()
            state = state.copy(next_signed_id = next(id).toLong())
            signedPreKey(identity, id, nowMs).also { store.storeSignedPreKey(it.id, it) }
        } else {
            null
        }

        val lastResort = if (state.active_last_resort_id == null || isDue(state.last_resort_rotated_at, nowMs)) {
            val id = state.next_kyber_id.toInt()
            state = state.copy(next_kyber_id = next(id).toLong())
            kyberPreKey(identity, id, nowMs).also { store.storeLastResortKyberPreKey(it.id, it) }
        } else {
            null
        }

        val oneTime = if (counts.oneTime < ONE_TIME_MINIMUM) {
            store.markOneTimeEcPreKeysStale(nowMs)
            val ids = ids(state.next_one_time_id.toInt(), BATCH_SIZE)
            state = state.copy(next_one_time_id = next(ids.last()).toLong())
            ids.map { id -> PreKeyRecord(id, ECKeyPair.generate()).also { store.storePreKey(id, it) } }
        } else {
            emptyList()
        }

        val kyber = if (counts.kyber < ONE_TIME_MINIMUM) {
            store.markOneTimeKyberPreKeysStale(nowMs)
            val ids = ids(state.next_kyber_id.toInt(), BATCH_SIZE)
            state = state.copy(next_kyber_id = next(ids.last()).toLong())
            ids.map { id -> kyberPreKey(identity, id, nowMs).also { store.storeKyberPreKey(id, it) } }
        } else {
            emptyList()
        }

        store.savePreKeyState(state)
        PreKeyRefill(signed, lastResort, oneTime, kyber)
    }

    /** After the server accepted [refill] (or nothing needed uploading): the new keys are the active ones. */
    fun confirmRefill(store: SignalStore, refill: PreKeyRefill, nowMs: Long) = store.transaction {
        var state = checkNotNull(store.preKeyState()) { "Pre-keys not provisioned" }
        refill.signedPreKey?.let { state = state.copy(active_signed_id = it.id.toLong(), signed_rotated_at = nowMs) }
        refill.lastResortKyberPreKey?.let { state = state.copy(active_last_resort_id = it.id.toLong(), last_resort_rotated_at = nowMs) }
        store.savePreKeyState(state.copy(synced_at = nowMs))
        store.cleanPreKeys(nowMs)
    }

    // A clock set back makes the elapsed time negative; rotate rather than wait for it to catch up.
    private fun isDue(sinceMs: Long, nowMs: Long): Boolean = nowMs - sinceMs >= REFRESH_INTERVAL_MS || nowMs < sinceMs

    private fun next(id: Int): Int = (id + 1) % Medium.MAX_VALUE

    private fun ids(start: Int, count: Int): List<Int> = (0 until count).map { (start + it) % Medium.MAX_VALUE }

    private fun signedPreKey(identity: ECPrivateKey, id: Int, nowMs: Long): SignedPreKeyRecord {
        val keyPair = ECKeyPair.generate()
        return SignedPreKeyRecord(id, nowMs, keyPair, identity.calculateSignature(keyPair.publicKey.serialize()))
    }

    private fun kyberPreKey(identity: ECPrivateKey, id: Int, nowMs: Long): KyberPreKeyRecord {
        val keyPair = KEMKeyPair.generate(KEMKeyType.KYBER_1024)
        return KyberPreKeyRecord(id, nowMs, keyPair, identity.calculateSignature(keyPair.publicKey.serialize()))
    }
}

private fun SignedPreKeyRecord.toApiJson() = SignedPreKeyJson(id, keyPair.publicKey.serialize().toBase64(), signature.toBase64())

private fun KyberPreKeyRecord.toApiJson() = KyberPreKeyJson(id, keyPair.publicKey.serialize().toBase64(), signature.toBase64())

private fun PreKeyRecord.toApiJson() = OneTimePreKeyJson(id, keyPair.publicKey.serialize().toBase64())
