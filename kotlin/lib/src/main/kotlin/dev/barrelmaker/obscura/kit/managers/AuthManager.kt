package dev.barrelmaker.obscura.kit.managers

import dev.barrelmaker.obscura.kit.AuthState
import dev.barrelmaker.obscura.kit.LoginScenario
import dev.barrelmaker.obscura.kit.ObscuraError
import dev.barrelmaker.obscura.kit.ObscuraLogger
import dev.barrelmaker.obscura.kit.crypto.SignalStore
import dev.barrelmaker.obscura.kit.network.APIClient
import dev.barrelmaker.obscura.kit.network.AuthResponse
import dev.barrelmaker.obscura.kit.network.LinkSession
import dev.barrelmaker.obscura.kit.network.isUuid
import dev.barrelmaker.obscura.kit.persistence.SessionStorage
import dev.barrelmaker.obscura.kit.stores.DeviceStore
import dev.barrelmaker.obscura.kit.stores.LocalDevice
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.signal.libsignal.protocol.IdentityKeyPair

internal enum class TokenStatus {
    FRESH,

    /** The server refused the refresh token. The session has ended. */
    REJECTED,

    /** The refresh could not complete (network or 5xx). The session is kept. */
    UNAVAILABLE,
}

internal data class Credentials(
    val token: String,
    val refreshToken: String,
    val expiresAt: Long,
    val userId: String,
    val deviceId: String,
    val username: String,
) {
    fun toMap(): Map<String, String> = mapOf(
        "token" to token,
        "refreshToken" to refreshToken,
        "expiresAt" to expiresAt.toString(),
        "userId" to userId,
        "deviceId" to deviceId,
        "username" to username,
    )

    companion object {
        fun from(map: Map<String, String>): Credentials? {
            val token = map["token"]?.takeIf { it.isNotBlank() } ?: return null
            val refreshToken = map["refreshToken"]?.takeIf { it.isNotBlank() } ?: return null
            val expiresAt = map["expiresAt"]?.toLongOrNull()?.takeIf { it > 0 } ?: return null
            val userId = map["userId"]?.takeIf(::isUuid) ?: return null
            val deviceId = map["deviceId"]?.takeIf(::isUuid) ?: return null
            val username = map["username"]?.takeIf { it.isNotBlank() } ?: return null
            return Credentials(token, refreshToken, expiresAt, userId, deviceId, username)
        }
    }
}

/**
 * The session: credentials, their persistence, and token refresh. The only writer of [state] and
 * of [SessionStorage].
 */
internal class AuthManager(
    private val api: APIClient,
    private val signalStore: SignalStore,
    private val devices: DeviceStore,
    private val storage: SessionStorage,
    private val deviceName: String,
    private val scope: CoroutineScope,
    private val logger: () -> ObscuraLogger,
    /** Ends the session after the server refused the refresh token. */
    private val onRejected: suspend (Credentials, Long) -> Unit,
) {
    private val _state = MutableStateFlow(AuthState.LOGGED_OUT)
    val state: StateFlow<AuthState> = _state.asStateFlow()

    @Volatile var credentials: Credentials? = null
        private set

    private data class CachedLinkSession(val username: String, val password: String, val session: LinkSession)

    private val lock = Any()
    private var refreshInFlight: Deferred<TokenStatus>? = null
    private var refreshLoop: Job? = null
    private var generation = 0L
    private var pendingLinkSession: CachedLinkSession? = null
    // Written only inside the single in-flight refresh.
    @Volatile private var refreshFailures = 0

    fun requireCredentials(): Credentials = credentials ?: throw ObscuraError.NotAuthenticated()

    /** Creates the account and provisions this device as its primary, with a new identity. */
    suspend fun register(username: String, password: String) {
        validateLogin(username, password)
        requireUnprovisioned()
        val keys = newIdentityKeys()
        install(api.registerUser(username, password, deviceName, keys.toDeviceKeys()), username, keys)
    }

    /**
     * Resets the account and provisions this device as its new primary on the server. The caller
     * wipes old local data via [beforeInstall] once the server has accepted the reset, before the
     * new primary keys and session are installed.
     */
    suspend fun resetAccount(username: String, password: String, beforeInstall: suspend () -> Unit) {
        validateLogin(username, password)
        val keys = newIdentityKeys()
        val response = api.resetAccount(username, password, deviceName, keys.toDeviceKeys())
        beforeInstall()
        install(response, username, keys)
    }

    /** Consumes the link session cached by [login], or creates a new one if none is cached. */
    suspend fun takeOrCreateLinkSession(username: String, password: String): LinkSession {
        validateLogin(username, password)
        requireUnprovisioned()
        val now = System.currentTimeMillis() / 1000
        synchronized(lock) {
            val cached = pendingLinkSession
            pendingLinkSession = null
            if (cached != null && cached.username == username && cached.password == password && cached.session.expiresAt > now + 30) {
                return cached.session
            }
        }
        return api.createLinkSession(username, password)
    }

    /** Without a stored device, creates a link session to verify credentials and prepare for [beginLink]. */
    suspend fun login(username: String, password: String): LoginScenario {
        validateLogin(username, password)
        val localDeviceId = devices.getIdentity()
        if (localDeviceId == null) {
            val session = try {
                api.createLinkSession(username, password)
            } catch (e: ObscuraError.Http) {
                if (e.status in REJECTION_STATUSES) return LoginScenario.INVALID_CREDENTIALS
                throw e
            }
            synchronized(lock) { pendingLinkSession = CachedLinkSession(username, password, session) }
            return LoginScenario.LINK_REQUIRED
        }
        val response = try {
            api.login(username, password, localDeviceId)
        } catch (e: ObscuraError.Http) {
            if (e.status in REJECTION_STATUSES) return LoginScenario.INVALID_CREDENTIALS
            if (e.status == 409) return LoginScenario.DEVICE_MISMATCH
            throw e
        }
        if (response.deviceId != localDeviceId || !signalStore.hasIdentity()) return LoginScenario.DEVICE_MISMATCH
        start(Credentials(response.token, response.refreshToken, response.expiresAt, response.userId, localDeviceId, username))
        return LoginScenario.EXISTING_DEVICE
    }

    /**
     * Create this linked device on the server, then store its keys, identity, own directory entry
     * and [persist]'s writes in one transaction and start the session. A failure before the server
     * accepts the device stores nothing.
     */
    suspend fun provisionLinked(
        expectedUserId: String,
        primaryDeviceId: String,
        username: String,
        name: String,
        keys: ProvisioningKeys,
        linkSessionId: String,
        persist: () -> Unit = {},
    ) {
        val response = api.provisionDevice(name, keys.toDeviceKeys(), linkSessionId)
        install(response, username, keys, primaryDeviceId = primaryDeviceId, expectedUserId = expectedUserId, publishAuth = false, persist = persist)
    }

    fun publishAuthenticated() = synchronized(lock) {
        if (credentials != null) _state.value = AuthState.AUTHENTICATED
    }

    private suspend fun install(
        response: AuthResponse,
        username: String,
        keys: ProvisioningKeys,
        primaryDeviceId: String = response.deviceId,
        expectedUserId: String? = null,
        publishAuth: Boolean = true,
        persist: () -> Unit = {},
    ) {
        if (expectedUserId != null && response.userId != expectedUserId) {
            throw ObscuraError.ProtocolViolation("Provisioning returned another account")
        }
        withContext(Dispatchers.IO) {
            signalStore.transaction {
                SignalKeyUtils.install(signalStore, keys)
                devices.storeLocalInTransaction(response.userId, LocalDevice(response.deviceId, primaryDeviceId = primaryDeviceId))
                persist()
            }
        }
        start(Credentials(response.token, response.refreshToken, response.expiresAt, response.userId, response.deviceId, username), publishAuth = publishAuth)
    }

    private fun newIdentityKeys() = SignalKeyUtils.generateProvisioningKeys(IdentityKeyPair.generate())

    /** Restore stored credentials. False when nothing usable is stored or the refresh token is refused. */
    suspend fun restore(): Boolean {
        val stored = synchronized(lock) { stored("load") { storage.load() } }?.let(Credentials::from)
        if (stored == null || !signalStore.hasIdentity() || devices.getIdentity() != stored.deviceId) {
            synchronized(lock) { stored("clear") { storage.clear() } }
            return false
        }
        start(stored)
        return ensureFreshToken() != TokenStatus.REJECTED
    }

    /** Revoke the refresh token on the server. Best effort. */
    suspend fun revoke(current: Credentials) {
        try {
            api.logout(current.token)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            logger().log("logout: refresh token not revoked: ${e.message}")
        }
    }

    fun end(expected: Credentials? = null, expectedGeneration: Long? = null): Credentials? = synchronized(lock) {
        if ((expected != null && credentials != expected) ||
            (expectedGeneration != null && generation != expectedGeneration)
        ) return null
        val previous = credentials
        generation++
        pendingLinkSession = null
        refreshLoop?.cancel()
        refreshLoop = null
        if (expected == null) refreshInFlight?.cancel()
        refreshInFlight = null
        credentials = null
        _state.value = AuthState.LOGGED_OUT
        stored("clear") { storage.clear() }
        previous
    }

    suspend fun ensureFreshToken(): TokenStatus = refreshIfNeeded(force = false)

    /** Concurrent callers share one refresh: the refresh token is single-use. */
    suspend fun refresh(): TokenStatus = refreshIfNeeded(force = true)

    private suspend fun refreshIfNeeded(force: Boolean): TokenStatus {
        val attempt = synchronized(lock) {
            val current = credentials ?: return TokenStatus.REJECTED
            refreshInFlight?.takeIf { it.isActive }?.let { return@synchronized it }
            if (!force && secondsUntilExpiry(current.expiresAt) > FRESHNESS_MARGIN_S) return TokenStatus.FRESH
            val version = generation
            scope.async { performRefresh(current, version) }.also { refreshInFlight = it }
        }
        return attempt.await()
    }

    private suspend fun performRefresh(current: Credentials, version: Long): TokenStatus {
        val response = try {
            api.refreshSession(current.refreshToken)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val failureCount = synchronized(lock) {
                if (generation != version || credentials != current) {
                    return if (credentials == null) TokenStatus.REJECTED else TokenStatus.FRESH
                }
                ++refreshFailures
            }
            if (e !is java.io.IOException && e !is ObscuraError.Http) throw e
            logger().tokenRefreshFailed(failureCount, e.message ?: e.javaClass.simpleName)
            if (e is ObscuraError.Http && e.status in REJECTION_STATUSES) {
                onRejected(current, version)
                return if (credentials == null) TokenStatus.REJECTED else TokenStatus.FRESH
            } else {
                return TokenStatus.UNAVAILABLE
            }
        }
        return synchronized(lock) {
            if (generation != version || credentials != current) {
                return@synchronized if (credentials == null) TokenStatus.REJECTED else TokenStatus.FRESH
            }
            if (response.userId != current.userId || response.deviceId != current.deviceId) {
                throw ObscuraError.ProtocolViolation("Refresh returned credentials for another session")
            }
            val refreshed = current.copy(token = response.token, refreshToken = response.refreshToken, expiresAt = response.expiresAt)
            stored("save") { storage.save(refreshed.toMap()) }
            credentials = refreshed
            refreshFailures = 0
            TokenStatus.FRESH
        }
    }

    private fun start(new: Credentials, publishAuth: Boolean = true) {
        synchronized(lock) {
            stored("save") { storage.save(new.toMap()) }
            generation++
            pendingLinkSession = null
            refreshInFlight?.cancel()
            refreshInFlight = null
            credentials = new
            refreshFailures = 0
            refreshLoop?.cancel()
            refreshLoop = scope.launch { refreshAheadOfExpiry() }
            if (publishAuth) _state.value = AuthState.AUTHENTICATED
        }
    }

    private suspend fun refreshAheadOfExpiry() {
        while (true) {
            delay(if (refreshFailures == 0) refreshDelayMs() else retryDelayMs(refreshFailures))
            try {
                if (refresh() == TokenStatus.REJECTED) return
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                logger().log("SESSION automatic refresh stopped: ${e.message}")
                return
            }
        }
    }

    /** 80% of the token's remaining lifetime, at least 5 s. */
    private fun refreshDelayMs(): Long {
        val expiresAt = credentials?.expiresAt ?: return MIN_REFRESH_DELAY_MS
        return (secondsUntilExpiry(expiresAt) * 800).coerceAtLeast(MIN_REFRESH_DELAY_MS)
    }

    private fun secondsUntilExpiry(expiresAt: Long): Long =
        expiresAt - System.currentTimeMillis() / 1000

    private fun validateLogin(username: String, password: String) {
        if (username.isBlank() || password.isBlank()) throw ObscuraError.InvalidArgument("Username and password must not be blank")
    }

    private suspend fun requireUnprovisioned() {
        if (devices.getIdentity() != null || signalStore.hasIdentity()) {
            throw ObscuraError.InvalidArgument("Wipe the local device before provisioning another")
        }
    }

    private inline fun <T> stored(operation: String, block: () -> T): T = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        throw ObscuraError.StorageFailed("Session storage $operation failed: ${e.message}", e)
    }

    private companion object {
        val REJECTION_STATUSES = setOf(401, 403)
        const val FRESHNESS_MARGIN_S = 60L
        const val MIN_REFRESH_DELAY_MS = 5_000L

        /** 5 s doubling to 5 min. */
        fun retryDelayMs(failures: Int): Long = (5_000L shl (failures - 1).coerceAtMost(6)).coerceAtMost(300_000L)
    }
}
