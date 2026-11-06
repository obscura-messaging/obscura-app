package dev.barrelmaker.obscura.kit

/** [databasePath] null means an in-memory database. */
data class ObscuraConfig(
    val apiUrl: String,
    val deviceName: String,
    val databasePath: String? = null,
) {
    init {
        // Parse the host exactly: a prefix check would let "http://localhost@evil.com" send cleartext
        // to a remote host.
        val uri = runCatching { java.net.URI(apiUrl) }.getOrNull()
        val host = uri?.host
        val isLoopback = uri?.scheme == "http" && host in setOf("localhost", "127.0.0.1", "[::1]")
        if (host.isNullOrBlank() || uri?.userInfo != null || uri?.fragment != null || uri?.query != null ||
            (uri?.port != -1 && uri?.port !in 1..65535) ||
            !(uri?.scheme == "https" || isLoopback)
        ) throw ObscuraError.InvalidArgument("API URL must use HTTPS (or loopback HTTP): $apiUrl")
        if (deviceName.isBlank()) throw ObscuraError.InvalidArgument("deviceName must not be blank")
        if (databasePath?.isBlank() == true) throw ObscuraError.InvalidArgument("databasePath must not be blank")
    }
}
