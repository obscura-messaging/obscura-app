package dev.barrelmaker.obscura.kit.wire

import dev.barrelmaker.obscura.kit.TypingState
import dev.barrelmaker.obscura.kit.stores.Friend
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

    fun encodeFriend(friend: Friend): Client.FriendRecord = friend.toProto()

    /** Null for a record without a user id or with an unspecified status. */
    fun decodeFriend(record: Client.FriendRecord): Friend? = Friend.fromProto(record)
}
