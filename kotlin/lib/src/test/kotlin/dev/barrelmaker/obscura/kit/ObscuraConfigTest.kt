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
}
