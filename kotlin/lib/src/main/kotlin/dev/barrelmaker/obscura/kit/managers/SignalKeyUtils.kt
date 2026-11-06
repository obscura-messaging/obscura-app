package dev.barrelmaker.obscura.kit.managers

import dev.barrelmaker.obscura.kit.crypto.SignalStore
import dev.barrelmaker.obscura.kit.managers.SignalKeyUtils.toApiJson
import dev.barrelmaker.obscura.kit.crypto.toBase64
import dev.barrelmaker.obscura.kit.network.DeviceKeys
import dev.barrelmaker.obscura.kit.network.OneTimePreKeyJson
import dev.barrelmaker.obscura.kit.network.PreKeyUpload
import dev.barrelmaker.obscura.kit.network.SignedPreKeyJson
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.ecc.Curve
import org.signal.libsignal.protocol.state.PreKeyRecord
import org.signal.libsignal.protocol.state.SignedPreKeyRecord
import org.signal.libsignal.protocol.util.KeyHelper

/** A new device's keys, held in memory until the server has accepted the device. */
internal class ProvisioningKeys(
    val identity: IdentityKeyPair,
    val registrationId: Int,
    val signedPreKey: SignedPreKeyRecord,
    val oneTimePreKeys: List<PreKeyRecord>,
) {
    fun toDeviceKeys() = DeviceKeys(
        identityKey = identity.publicKey.serialize().toBase64(),
        registrationId = registrationId,
        preKeys = PreKeyUpload(signedPreKey.toApiJson(), oneTimePreKeys.map { it.toApiJson() }),
    )
}

internal object SignalKeyUtils {
    const val SIGNED_PREKEY_ID = 1
    private const val INITIAL_PREKEY_COUNT = 100

    /**
     * A registration id, signed prekey [SIGNED_PREKEY_ID] and one-time prekeys for this device,
     * signed by [identity]: a new identity for a primary, the account identity for a linked device.
     */
    fun generateProvisioningKeys(identity: IdentityKeyPair): ProvisioningKeys = ProvisioningKeys(
        identity = identity,
        registrationId = KeyHelper.generateRegistrationId(false),
        signedPreKey = signedPreKey(identity, SIGNED_PREKEY_ID),
        oneTimePreKeys = (1..INITIAL_PREKEY_COUNT).map { PreKeyRecord(it, Curve.generateKeyPair()) },
    )

    /** Joins an enclosing transaction. */
    fun install(store: SignalStore, keys: ProvisioningKeys) = store.transaction {
        store.installIdentity(keys.identity, keys.registrationId)
        store.storeSignedPreKey(keys.signedPreKey.id, keys.signedPreKey)
        keys.oneTimePreKeys.forEach { store.storePreKey(it.id, it) }
    }

    /** A refill: a fresh signed prekey and [count] one-time prekeys, stored; earlier signed keys remain. */
    fun generateMorePreKeys(store: SignalStore, count: Int): PreKeyUpload {
        val signed = signedPreKey(store.identityKeyPair, Math.toIntExact(store.getHighestSignedPreKeyId() + 1))
            .also { store.storeSignedPreKey(it.id, it) }
        val startId = store.getHighestPreKeyId().toInt() + 1
        val oneTime = (startId until startId + count).map { id ->
            PreKeyRecord(id, Curve.generateKeyPair()).also { store.storePreKey(id, it) }
        }
        return PreKeyUpload(signed.toApiJson(), oneTime.map { it.toApiJson() })
    }

    fun signedPreKey(identity: IdentityKeyPair, id: Int): SignedPreKeyRecord {
        val keyPair = Curve.generateKeyPair()
        val signature = Curve.calculateSignature(identity.privateKey, keyPair.publicKey.serialize())
        return SignedPreKeyRecord(id, System.currentTimeMillis(), keyPair, signature)
    }

    fun SignedPreKeyRecord.toApiJson() =
        SignedPreKeyJson(id, keyPair.publicKey.serialize().toBase64(), signature.toBase64())

    fun PreKeyRecord.toApiJson() = OneTimePreKeyJson(id, keyPair.publicKey.serialize().toBase64())
}
