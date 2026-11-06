package dev.barrelmaker.obscura.kit

import org.junit.jupiter.api.Assertions.assertDoesNotThrow
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class ObscuraConfigTest {
    private fun config(url: String) = ObscuraConfig(apiUrl = url, deviceName = "Test")

    @Test
    fun `https is accepted`() {
        assertDoesNotThrow { config("https://obscura.example.com") }
    }

    @Test
    fun `plain http and other schemes are rejected`() {
        for (url in listOf("http://obscura.example.com", "ws://example.com", "file:///etc/passwd", "")) {
            assertThrows(ObscuraError.InvalidArgument::class.java, { config(url) }, url)
        }
    }

    @Test
    fun `loopback http is accepted`() {
        assertDoesNotThrow { config("http://localhost:3000") }
        assertDoesNotThrow { config("http://127.0.0.1:3000") }
    }

    @Test
    fun `hosts that only look like loopback are rejected`() {
        for (url in listOf(
            "http://localhost.evil.com",
            "http://localhost@evil.com",
            "http://127.0.0.1.evil.com",
            "http://127.0.0.1@evil.com/api",
        )) {
            assertThrows(ObscuraError.InvalidArgument::class.java, { config(url) }, url)
        }
    }

    @Test
    fun `a driver and a database path together are rejected`() {
        val driver = app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver(app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver.IN_MEMORY)
        assertThrows(ObscuraError.InvalidArgument::class.java) {
            ObscuraClient(ObscuraConfig("https://x.test", "Test", databasePath = "build/x.db"), driver, MemoryStorage())
        }
    }

    @Test
    fun `URI components, port bounds, blank deviceName, blank databasePath, and file databasePath are validated`() {
        assertDoesNotThrow { config("https://obscura.example.com:8443") }
        assertDoesNotThrow { config("http://[::1]:3000") }
        for (badUrl in listOf(
            "https://bad uri",
            "https://obscura.example.com#frag",
            "https://obscura.example.com?q=1",
            "https://obscura.example.com:0",
            "https://obscura.example.com:70000",
        )) {
            assertThrows(ObscuraError.InvalidArgument::class.java, { config(badUrl) }, badUrl)
        }
        assertThrows(ObscuraError.InvalidArgument::class.java) {
            ObscuraConfig(apiUrl = "https://obscura.example.com", deviceName = " ")
        }
        assertThrows(ObscuraError.InvalidArgument::class.java) {
            ObscuraConfig(apiUrl = "https://obscura.example.com", deviceName = "Test", databasePath = " ")
        }
        val dbDir = java.io.File("build/test-databases/cfg-${java.util.UUID.randomUUID()}").also { it.mkdirs() }
        try {
            val dbFile = java.io.File(dbDir, "client.db")
            val client = ObscuraClient(
                ObscuraConfig("https://obscura.example.com", "Test", databasePath = dbFile.absolutePath),
                driver = null,
                sessionStorage = MemoryStorage(),
            )
            org.junit.jupiter.api.Assertions.assertTrue(dbFile.exists())
            client.disconnect()
        } finally {
            dbDir.deleteRecursively()
        }
    }
}
