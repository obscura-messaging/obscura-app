package dev.barrelmaker.obscura.kit

/** Every error the kit throws on purpose. [code] is the stable contract; the message is for humans. */
sealed class ObscuraError(val code: String, message: String, cause: Throwable? = null) : Exception(message, cause) {
    class NotAuthenticated : ObscuraError("NOT_AUTHENTICATED", "Not authenticated")

    class InvalidArgument(val reason: String) : ObscuraError("INVALID_ARGUMENT", reason)
    class InvalidFriendCode : ObscuraError("INVALID_FRIEND_CODE", "Invalid friend code")
    class ConnectionFailed(val reason: String, cause: Throwable? = null) : ObscuraError("CONNECTION_FAILED", reason, cause)
    class ProtocolViolation(val reason: String, cause: Throwable? = null) : ObscuraError("PROTOCOL_VIOLATION", reason, cause)
    class StorageFailed(val reason: String, cause: Throwable? = null) : ObscuraError("STORAGE_ERROR", reason, cause)

    /** A message that must reach a user was accepted by none of their devices. */
    class SendFailed(val reason: String) : ObscuraError("SEND_FAILED", reason)

    /** Only the account's primary device may do this. */
    class NotPrimary : ObscuraError("NOT_PRIMARY", "Only the primary device can do this")

    /** The link session expired or is unknown, or its envelope does not decrypt. */
    class LinkFailed(val reason: String, cause: Throwable? = null) : ObscuraError("LINK_FAILED", reason, cause)

    /** The server answered with a non-2xx status. */
    class Http(val status: Int, val body: String) : ObscuraError("HTTP_ERROR", "HTTP $status")
}
