package dev.barrelmaker.obscura.kit.stores

import dev.barrelmaker.obscura.kit.newInMemoryDatabase
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class DeviceStoreTest {
    private val devices = DeviceStore(newInMemoryDatabase())

    @Test
    fun `this device round-trips with its own directory entry and the primary`() = runTest {
        assertNull(devices.getLocal())
        devices.storeLocalInTransaction("me", LocalDevice("device-1", primaryDeviceId = "primary-1"))
        assertEquals(LocalDevice("device-1", "primary-1"), devices.getLocal())
        assertFalse(devices.getLocal()!!.isPrimary)
        assertEquals(listOf("device-1"), devices.devicesOf("me"))

        devices.storeLocalInTransaction("me", LocalDevice("device-1", primaryDeviceId = "device-1"))
        assertTrue(devices.getLocal()!!.isPrimary)
        assertEquals("device-1", devices.getIdentity())
    }

    @Test
    fun `devices are listed per user and a repeated id is stored once`() = runTest {
        devices.replace("me", listOf("d1", "d1"))
        devices.replace("peer", listOf("d2"))

        assertEquals(listOf("d1"), devices.devicesOf("me"))
        assertEquals(listOf("d2"), devices.devicesOf("peer"))
    }

    @Test
    fun `replace swaps one user's list and leaves other users alone`() = runTest {
        devices.replace("me", listOf("old"))
        devices.replace("peer", listOf("p1"))

        devices.replace("me", listOf("b", "a"))

        assertEquals(listOf("a", "b"), devices.devicesOf("me"))
        assertEquals(listOf("p1"), devices.devicesOf("peer"))
    }

    @Test
    fun `a device belongs to one user and removal is scoped to that user`() = runTest {
        devices.add("first", listOf("d1", "d2"))
        devices.add("second", listOf("d3"))
        org.junit.jupiter.api.Assertions.assertThrows(dev.barrelmaker.obscura.kit.ObscuraError.ProtocolViolation::class.java) {
            kotlinx.coroutines.runBlocking { devices.add("second", listOf("d1")) }
        }
        devices.remove("second", listOf("d1"))

        assertEquals(listOf("d1", "d2"), devices.devicesOf("first"))
        assertEquals(listOf("d3"), devices.devicesOf("second"))
        devices.remove("first", listOf("d1", "d2"))
        assertEquals(emptyList<String>(), devices.devicesOf("first"))
    }
}
