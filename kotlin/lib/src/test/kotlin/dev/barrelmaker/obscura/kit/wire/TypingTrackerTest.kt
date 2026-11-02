package dev.barrelmaker.obscura.kit.wire

import dev.barrelmaker.obscura.kit.TypingState
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
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
    }
}
