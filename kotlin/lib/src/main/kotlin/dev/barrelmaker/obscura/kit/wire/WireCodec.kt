package dev.barrelmaker.obscura.kit.wire

import dev.barrelmaker.obscura.kit.TypingState
import dev.barrelmaker.obscura.kit.stores.FriendData
import dev.barrelmaker.obscura.kit.stores.FriendStatus
import obscura.client.v1.Client

/** Payload arm, typing state and friend records <-> app-facing forms. Pinned by `protocol/conformance/wire.json`. */
internal object WireCodec {
    /** The inbox `kind`: the arm's upper-snake name, `UNKNOWN` for an unset or unknown arm. */
    fun kind(case: Client.ClientMessage.PayloadCase): String =
        if (case == Client.ClientMessage.PayloadCase.PAYLOAD_NOT_SET) "UNKNOWN" else case.name

    fun decodeTypingState(state: Client.TypingState): TypingState? = when (state) {
        Client.TypingState.TYPING_STATE_STARTED -> TypingState.STARTED
        Client.TypingState.TYPING_STATE_STOPPED -> TypingState.STOPPED
        Client.TypingState.TYPING_STATE_UNSPECIFIED, Client.TypingState.UNRECOGNIZED -> null
    }

    fun encodeTypingState(state: TypingState): Client.TypingState = when (state) {
        TypingState.STARTED -> Client.TypingState.TYPING_STATE_STARTED
        TypingState.STOPPED -> Client.TypingState.TYPING_STATE_STOPPED
    }

    fun encodeFriend(friend: FriendData): Client.FriendRecord = Client.FriendRecord.newBuilder()
        .setUserId(friend.userId)
        .setUsername(friend.username)
        .setStatus(when (friend.status) {
            FriendStatus.PENDING_SENT -> Client.FriendStatus.FRIEND_STATUS_PENDING_SENT
            FriendStatus.PENDING_RECEIVED -> Client.FriendStatus.FRIEND_STATUS_PENDING_RECEIVED
            FriendStatus.ACCEPTED -> Client.FriendStatus.FRIEND_STATUS_ACCEPTED
        })
        .build()

    /** Null for a record without a user id or with an unspecified status. */
    fun decodeFriend(record: Client.FriendRecord): FriendData? {
        val status = when (record.status) {
            Client.FriendStatus.FRIEND_STATUS_PENDING_SENT -> FriendStatus.PENDING_SENT
            Client.FriendStatus.FRIEND_STATUS_PENDING_RECEIVED -> FriendStatus.PENDING_RECEIVED
            Client.FriendStatus.FRIEND_STATUS_ACCEPTED -> FriendStatus.ACCEPTED
            Client.FriendStatus.FRIEND_STATUS_UNSPECIFIED, Client.FriendStatus.UNRECOGNIZED -> return null
        }
        return if (record.userId.isBlank()) null else FriendData(record.userId, record.username, status)
    }
}
