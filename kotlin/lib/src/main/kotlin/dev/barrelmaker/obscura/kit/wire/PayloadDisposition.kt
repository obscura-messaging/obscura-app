package dev.barrelmaker.obscura.kit.wire

import obscura.client.v1.Client.ClientMessage.PayloadCase

internal enum class PayloadDisposition {
    /** Written to local content tables before the ack. */
    CONTENT,

    /** Changes kit-owned state before the ack. */
    KIT_INTERNAL,

    /** In memory only; acked without persistence. */
    DROPPABLE,
}

internal fun payloadDisposition(arm: PayloadCase): PayloadDisposition = when (arm) {
    PayloadCase.DIRECT_MESSAGE,
    PayloadCase.PIX,
    PayloadCase.SEEN_RECEIPT,
    PayloadCase.STORY,
    PayloadCase.PROFILE -> PayloadDisposition.CONTENT
    PayloadCase.FRIEND_REQUEST, PayloadCase.FRIEND_ACCEPT, PayloadCase.FRIEND_LIST_SYNC -> PayloadDisposition.KIT_INTERNAL
    PayloadCase.TYPING_SIGNAL, PayloadCase.PAYLOAD_NOT_SET -> PayloadDisposition.DROPPABLE
}
