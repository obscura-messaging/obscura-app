package dev.barrelmaker.obscura.kit.wire

import dev.barrelmaker.obscura.kit.ObscuraError
import dev.barrelmaker.obscura.kit.SELF_USER_ID
import dev.barrelmaker.obscura.kit.TypingState
import dev.barrelmaker.obscura.kit.authenticatedClient
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import obscura.client.v1.Client
import obscura.client.v1.Client.ClientMessage
import obscura.client.v1.typingSignal
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class TypingTrackerTest {
    @Test
    fun `a started signal expires 5 s after the latest one`() = runTest {
        val tracker = TypingTracker(backgroundScope)
        tracker.started("ctx", "alice", "phone")
        advanceTimeBy(4_000)
        tracker.started("ctx", "alice", "phone")
        advanceTimeBy(4_000)
        runCurrent()
        assertEquals(listOf("alice"), tracker.observe("ctx").first())

        advanceTimeBy(1_001)
        runCurrent()
        assertEquals(emptyList<String>(), tracker.observe("ctx").first())
    }

    @Test
    fun `sends are throttled per context and state for 2 s`() = runTest {
        val tracker = TypingTracker(backgroundScope)
        assertTrue(tracker.shouldSend("ctx", TypingState.STARTED, nowMs = 0))
        assertFalse(tracker.shouldSend("ctx", TypingState.STARTED, nowMs = 1_999))
        assertTrue(tracker.shouldSend("ctx", TypingState.STOPPED, nowMs = 1_999))
        assertTrue(tracker.shouldSend("other", TypingState.STARTED, nowMs = 1_999))
        assertTrue(tracker.shouldSend("ctx", TypingState.STARTED, nowMs = 2_000))
    }

    @Test
    fun `clear forgets typers and the throttle`() = runTest {
        val tracker = TypingTracker(backgroundScope)
        tracker.started("ctx", "alice", "phone")
        assertTrue(tracker.shouldSend("ctx", TypingState.STARTED, nowMs = 0))

        tracker.clear()

        assertEquals(emptyList<String>(), tracker.observe("ctx").first())
        assertTrue(tracker.shouldSend("ctx", TypingState.STARTED, nowMs = 1))

        // Stopping an unknown device/context is a safe no-op
        tracker.stopped("unknown-ctx", "unknown-device")
        assertEquals(emptyList<String>(), tracker.observe("unknown-ctx").first())
    }

    @Test
    fun `observePeerTyping emits true when peer starts typing and false when stopped`() = runBlocking {
        val c = authenticatedClient()
        val peer = "019f025a-0000-7de6-84b6-000000000002"
        val peerDevice = "019f025a-0000-7de6-84b6-0000000000d2"
        val convId = if (SELF_USER_ID <= peer) "${SELF_USER_ID}_$peer" else "${peer}_$SELF_USER_ID"

        assertFalse(c.observePeerTyping(peer).first())

        c.route(
            ClientMessage.newBuilder().setTypingSignal(
                typingSignal {
                    contextId = convId
                    state = Client.TypingState.TYPING_STATE_STARTED
                },
            ).build(),
            peer,
            peerDevice,
            "env-typing-1",
        )
        assertTrue(c.observePeerTyping(peer).first())

        c.route(
            ClientMessage.newBuilder().setTypingSignal(
                typingSignal {
                    contextId = convId
                    state = Client.TypingState.TYPING_STATE_STOPPED
                },
            ).build(),
            peer,
            peerDevice,
            "env-typing-2",
        )
        assertFalse(c.observePeerTyping(peer).first())

        assertThrows(ObscuraError.InvalidArgument::class.java) { c.observePeerTyping(" ") }
        assertThrows(ObscuraError.InvalidArgument::class.java) { c.observeTyping(" ") }
        assertThrows(ObscuraError.InvalidArgument::class.java) { runBlocking { c.sendTyping(" ", TypingState.STARTED) } }
        Unit
    }
}
