package dev.barrelmaker.obscura.kit.wire

import obscura.client.v1.Client.ClientMessage.PayloadCase

internal enum class PayloadDisposition {
    /** Written to the inbox before the ack. */
    INBOXED,

    /** Changes kit-owned state before the ack. */
    KIT_INTERNAL,

    /** In memory only; acked without persistence. */
    DROPPABLE,
}

internal fun payloadDisposition(arm: PayloadCase): PayloadDisposition = when (arm) {
    PayloadCase.APP_ENTRY -> PayloadDisposition.INBOXED
    PayloadCase.FRIEND_REQUEST, PayloadCase.FRIEND_ACCEPT, PayloadCase.FRIEND_LIST_SYNC -> PayloadDisposition.KIT_INTERNAL
    PayloadCase.TYPING_SIGNAL, PayloadCase.PAYLOAD_NOT_SET -> PayloadDisposition.DROPPABLE
}
