package dev.barrelmaker.obscura.kit.wire

import obscura.client.v1.Client.ClientMessage.PayloadCase
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class PayloadDispositionTest {
    /** Every arm, written out. A new arm in `client.proto` fails here until it is given a class. */
    private val expected = mapOf(
        PayloadCase.APP_ENTRY to PayloadDisposition.INBOXED,
        PayloadCase.FRIEND_REQUEST to PayloadDisposition.KIT_INTERNAL,
        PayloadCase.FRIEND_ACCEPT to PayloadDisposition.KIT_INTERNAL,
        PayloadCase.TYPING_SIGNAL to PayloadDisposition.DROPPABLE,
        PayloadCase.FRIEND_LIST_SYNC to PayloadDisposition.KIT_INTERNAL,
        PayloadCase.PAYLOAD_NOT_SET to PayloadDisposition.DROPPABLE,
    )

    @Test
    fun `every arm has its expected class`() {
        assertEquals(PayloadCase.entries.toSet(), expected.keys)
        expected.forEach { (arm, disposition) -> assertEquals(disposition, payloadDisposition(arm), arm.name) }
    }

    @Test
    fun `an unset arm is stored as UNKNOWN`() {
        assertEquals("UNKNOWN", WireCodec.kind(PayloadCase.PAYLOAD_NOT_SET))
    }
}
