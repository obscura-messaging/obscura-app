package dev.barrelmaker.obscura.kit

enum class TypingState { STARTED, STOPPED }

enum class AuthState { LOGGED_OUT, AUTHENTICATED }

enum class ConnectionState { DISCONNECTED, CONNECTING, CONNECTED, RECONNECTING }

enum class LoginScenario {
    /** Authenticated as the stored local device. */
    EXISTING_DEVICE,

    /** No local device: link this device with `beginLink`. */
    LINK_REQUIRED,

    /** The stored device no longer belongs to the account (unlinked or reset): `wipeDevice`, then log in again. */
    DEVICE_MISMATCH,
    INVALID_CREDENTIALS,
}

/** One device of the signed-in account. */
data class DeviceInfo(val deviceId: String, val name: String?, val isPrimary: Boolean, val isThisDevice: Boolean)

/** A pending link of this device. Show [code] as a QR code for the primary, then call `completeLink`. */
class LinkRequest internal constructor(
    val code: String,
    internal val sessionId: String,
    internal val userId: String,
    internal val expiresAt: Long,
    internal val ephemeral: org.signal.libsignal.protocol.ecc.ECKeyPair,
    internal val username: String,
    internal val deviceName: String,
)

enum class SubmissionStatus { ACCEPTED, REJECTED, UNKNOWN }

data class SubmissionResult(
    val userId: String,
    val deviceId: String?,
    val status: SubmissionStatus,
    val error: String? = null,
)

data class SendReport(val recipients: List<SubmissionResult>, val selfSync: List<SubmissionResult>)

/** An uploaded attachment: its server id and the key material that decrypts it. */
class AttachmentUpload(val id: String, val contentKey: ByteArray, val nonce: ByteArray) {
    override fun equals(other: Any?): Boolean =
        this === other || (other is AttachmentUpload &&
            id == other.id &&
            contentKey.contentEquals(other.contentKey) &&
            nonce.contentEquals(other.nonce))

    override fun hashCode(): Int {
        var result = id.hashCode()
        result = 31 * result + contentKey.contentHashCode()
        result = 31 * result + nonce.contentHashCode()
        return result
    }

    fun media(mediaType: String): MediaAttachment = MediaAttachment(id, contentKey, nonce, mediaType)
}

/** What `sendCapture` could not deliver; those entries are stored and retried by `flushOutbox`. */
data class CaptureResult(val undeliveredPeerUserIds: List<String>, val storyUndelivered: Boolean)

typealias MediaAttachment = dev.barrelmaker.obscura.kit.stores.MediaAttachment
typealias ConversationItem = dev.barrelmaker.obscura.kit.stores.ConversationItem
typealias StoryItem = dev.barrelmaker.obscura.kit.stores.StoryItem
typealias ProfileItem = dev.barrelmaker.obscura.kit.stores.ProfileItem
typealias SweepOutcome = dev.barrelmaker.obscura.kit.stores.SweepOutcome

