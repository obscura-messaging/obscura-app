package dev.barrelmaker.obscura

import android.content.Context
import android.content.SharedPreferences
import android.database.sqlite.SQLiteDatabaseCorruptException
import android.util.Log
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import dev.barrelmaker.obscura.kit.AuthState
import dev.barrelmaker.obscura.kit.ConnectionState
import dev.barrelmaker.obscura.kit.ObscuraClient
import dev.barrelmaker.obscura.kit.ObscuraConfig
import dev.barrelmaker.obscura.kit.ObscuraLogger
import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * Process-scoped owner of the [ObscuraClient] — the "who is the live client and
 * when is the app foregrounded" layer. NOT the auth-session store: token/refresh/
 * schema persistence is owned by the kit (see [ObscuraClient.persistSession] /
 * [ObscuraClient.restorePersistedSession]); this only supplies the platform
 * [SessionStorage] impl and picks the per-user SQLite DB. Responsibilities:
 *
 *   - Client lifecycle (build per-user client / restore on cold start / destroy)
 *   - Foreground/background tracking (ProcessLifecycleOwner); reconnect on resume
 *     via [ObscuraClient.ensureConnected]
 *   - The SINGLE consumer of [ObscuraClient.incomingMessages] — classifies
 *     each envelope, fans out to the bound [EventSink] (i.e. the RN bridge),
 *     and posts a generic local notification when the app is backgrounded.
 *
 * Initialized from [MainApplication.onCreate] so an FCM cold-start can
 * restore the session and start consuming messages before the RN bridge
 * is ever constructed.
 *
 * Threading: callable from any thread; internal coroutines run on
 * [Dispatchers.Default] / [Dispatchers.Main] as appropriate.
 */
object ObscuraSession {

    private const val TAG = "ObscuraSession"
    private const val PREFS_NAME = "obscura_session"
    private const val API_URL = "https://obscura.barrelmaker.dev"

    /** Listener registered by the RN bridge so kit events reach JS. */
    interface EventSink {
        fun onConnectionChanged(state: ConnectionState)
        fun onAuthStateChanged(state: AuthState)
        fun onFriendsChanged()
        fun onMessageReceived(type: String, modelName: String?)
        fun onPushToken(token: String)
        fun onAppStateChanged(state: AppState)
    }

    /** Process-wide app foreground/background. Matches the iOS-friendly minimal set. */
    enum class AppState { ACTIVE, BACKGROUND }

    private lateinit var appContext: Context
    private val prefs: SharedPreferences by lazy {
        appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val collectorJobs = mutableListOf<Job>()

    @Volatile var client: ObscuraClient? = null
        private set

    @Volatile var appInForeground: Boolean =
        ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        private set

    @Volatile private var sink: EventSink? = null

    /** Logger that forwards everything to logcat and surfaces auth failures via the sink. */
    val logger: ObscuraLogger = object : ObscuraLogger {
        override fun log(message: String) { Log.d(TAG, message) }
        override fun decryptFailed(sourceUserId: String, reason: String) { Log.w(TAG, "decrypt failed from ${sourceUserId.take(8)}: $reason") }
        override fun ackFailed(envelopeId: String, reason: String) { Log.w(TAG, "ack failed $envelopeId: $reason") }
        // A rejected refresh token signs the kit out; the auth-state collector reports that.
        override fun tokenRefreshFailed(attempt: Int, reason: String) { Log.e(TAG, "token refresh failed (attempt $attempt): $reason") }
        override fun preKeyReplenishFailed(reason: String) { Log.w(TAG, "prekey replenish failed: $reason") }
        override fun identityChanged(address: String) { Log.w(TAG, "identity changed: $address") }
        override fun sessionEstablishFailed(userId: String, reason: String) { Log.e(TAG, "session establish failed $userId: $reason") }
        override fun databaseError(store: String, operation: String, reason: String) { Log.e(TAG, "db error $store.$operation: $reason") }
    }

    /**
     * Called once from [MainApplication.onCreate]. Wires up the lifecycle
     * observer and attempts to restore a persisted session.
     */
    fun init(app: Context) {
        appContext = app.applicationContext

        // Foreground/background tracking. ProcessLifecycleOwner requires main thread.
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) {
                    appInForeground = true
                    sink?.onAppStateChanged(AppState.ACTIVE)
                    val c = client ?: return
                    // Kit owns the reconnect decision (idempotent — no-op if already
                    // connected). This also covers the case the gateway's own
                    // auto-reconnect can't: a cold-start restore whose first connect
                    // failed, or a resume where a dead socket isn't detected yet.
                    scope.launch {
                        try { c.ensureConnected() } catch (e: Exception) {
                            Log.e(TAG, "Foreground reconnect failed: ${e.message}")
                        }
                    }
                }
                override fun onStop(owner: LifecycleOwner) {
                    appInForeground = false
                    sink?.onAppStateChanged(AppState.BACKGROUND)
                }
            })
        }

        // Try to restore persisted session (idempotent — no-op if not present).
        try {
            tryRestore()
        } catch (e: Exception) {
            Log.e(TAG, "init: restore failed: ${e.message}")
        }
    }

    // ─── EventSink registration (bridge) ────────────────────────────────────

    fun bindEventSink(s: EventSink) {
        sink = s
        // Replay current state so a freshly-bound bridge immediately sees correct UI.
        s.onAppStateChanged(if (appInForeground) AppState.ACTIVE else AppState.BACKGROUND)
        val c = client ?: return
        s.onAuthStateChanged(c.authState.value)
        s.onConnectionChanged(c.connectionState.value)
        s.onFriendsChanged()
    }

    fun unbindEventSink(s: EventSink) {
        if (sink === s) sink = null
    }

    // ─── Client lifecycle ───────────────────────────────────────────────────
    //
    // Auth-session persistence (token/refresh/schema) is kit-owned via the
    // injected [sessionStorage]; this section only owns the client instance and
    // its per-user SQLite DB. Persist happens in the kit (connect + token
    // rotation) and logout() clears sessionStorage; wipeDevice() does not.

    private val sessionStorage by lazy { SharedPreferencesSessionStorage(prefs) }

    /**
     * Build a per-user client (SQLite DB keyed by username) wired to the shared
     * logger + [sessionStorage], make it the live client, and start bridge
     * collectors. Replaces any existing client. Does NOT connect or restore —
     * callers drive auth (register / login / restorePersistedSession).
     */
    private fun buildClient(username: String): ObscuraClient {
        destroyClient()
        val dbName = "obscura_${username}.db"
        System.loadLibrary("sqlcipher")
        val driver = try {
            openDatabase(username, dbName)
        } catch (e: Exception) {
            if (!isUndecryptable(e)) throw e
            // Unreadable without its key: start over, and the next login provisions a new device.
            Log.e(TAG, "Database for $username cannot be decrypted; discarding it", e)
            LocalKeystore.discardDatabase(appContext, username, dbName)
            sessionStorage.clear()
            openDatabase(username, dbName)
        }
        val c = ObscuraClient(
            ObscuraConfig(apiUrl = API_URL),
            externalDriver = driver,
            sessionStorage = sessionStorage,
        )
        c.logger = logger
        client = c
        startCollectors(c)
        Log.d(TAG, "Client built (db=$dbName)")
        return c
    }

    /** Opens the user's SQLCipher database and reads once, so a bad key fails here. */
    private fun openDatabase(username: String, dbName: String): AndroidSqliteDriver {
        val key = LocalKeystore.databaseKey(appContext, username)
        val driver = AndroidSqliteDriver(
            ObscuraDatabase.Schema, appContext, dbName,
            factory = SupportOpenHelperFactory(key),
        )
        try {
            driver.executeQuery(null, "SELECT count(*) FROM sqlite_master", { it.next(); QueryResult.Unit }, 0)
        } catch (e: Exception) {
            driver.close()
            throw e
        }
        return driver
    }

    /** A lost key or a file SQLCipher cannot read. Transient errors (full disk, lock) are not. */
    private fun isUndecryptable(e: Throwable): Boolean =
        generateSequence(e) { it.cause }.any {
            it is LocalKeystore.SecretUnavailableException ||
                it is SQLiteDatabaseCorruptException ||
                it.message?.contains("file is not a database") == true
        }

    fun clearSession() = sessionStorage.clear()

    /** Build a fresh client for a username (register / login entry point). */
    fun createClient(username: String): ObscuraClient = buildClient(username)

    /** Tear down the current client, cancel collectors. */
    fun destroyClient() {
        collectorJobs.forEach { it.cancel() }
        collectorJobs.clear()
        try { client?.disconnect() } catch (_: Exception) {}
        client = null
    }

    /**
     * Restore a client from persisted session on cold start. The app reads only
     * the persisted username (to name the per-user DB); the kit then re-reads the
     * blob to do the restore → refresh-token → define-cached-models → connect flow
     * via [ObscuraClient.restorePersistedSession].
     *
     * Returns the client (existing or freshly built), or null if no session is
     * persisted. Idempotent — calling twice returns the same instance.
     */
    @Synchronized
    fun tryRestore(): ObscuraClient? {
        client?.let { return it }
        val saved = sessionStorage.load() ?: return null
        val username = saved["username"] as? String ?: return null
        val token = saved["token"] as? String ?: return null
        if (token.isBlank()) return null

        Log.d(TAG, "Restoring session: user=$username")
        val c = buildClient(username)
        // buildClient clears the session when it discards an undecryptable database.
        if (sessionStorage.load() == null) {
            destroyClient()
            return null
        }

        // Kit restores tokens/deviceId, refreshes, defines cached models, connects,
        // and re-persists rotated tokens. Clears storage if the refresh token is dead.
        scope.launch {
            try {
                if (!c.restorePersistedSession()) {
                    Log.w(TAG, "restore: no valid session or connect failed")
                }
            } catch (e: Exception) {
                Log.e(TAG, "restore failed: ${e.message}")
            }
        }
        return c
    }

    // ─── Collectors (single source of truth) ────────────────────────────────

    private fun startCollectors(c: ObscuraClient) {
        collectorJobs += scope.launch {
            c.connectionState.collectLatest { state ->
                Log.d(TAG, "Connection: $state")
                sink?.onConnectionChanged(state)
            }
        }
        collectorJobs += scope.launch {
            c.authState.collectLatest { state ->
                Log.d(TAG, "AuthState: $state")
                sink?.onAuthStateChanged(state)
            }
        }
        collectorJobs += scope.launch {
            c.friendsChanged.collectLatest {
                sink?.onFriendsChanged()
            }
        }
        // THE single consumer of incomingMessages. Fans out to sink + notification.
        collectorJobs += scope.launch {
            for (msg in c.incomingMessages) {
                Log.d(TAG, "Incoming: ${msg.type}")
                val modelName = msg.model
                sink?.onMessageReceived(msg.type, modelName)

                if (!appInForeground) {
                    val notifText = classifyForNotification(msg.type, modelName)
                    if (notifText != null) {
                        NotificationHelper.postGeneric(appContext, notifText)
                    }
                }
            }
        }
    }

    /**
     * Generic notification copy for an incoming message, or null for anything that must not notify.
     *
     * These model names are `src/models/schema.ts`'s, hardcoded here because a notification has to be
     * postable with no JS runtime. That makes them a copy, so **every declared model is listed** and
     * an unrecognised one falls through to a generic notification rather than to silence: a model
     * renamed in `schema.ts` would otherwise stop notifying with nothing to notice it — no type
     * error, no failing test, just a user who stops hearing about their messages.
     *
     * Over-notifying once is recoverable. Silently not notifying is what this shape is guarding.
     */
    private fun classifyForNotification(type: String, modelName: String?): String? {
        if (type == "FRIEND_REQUEST") return "New friend request"
        if (type != "APP_ENTRY") return null
        if (modelName == null) {
            Log.e(TAG, "Notification suppressed: APP_ENTRY missing model")
            return null
        }

        return when (modelName) {
            "pix" -> "New pix"
            "directMessage" -> "New message"
            // Declared, and deliberately silent.
            "story", "profile", "seen" -> null
            else -> {
                Log.w(TAG, "Notification: unrecognised model '$modelName' — is it renamed in schema.ts?")
                "New message"
            }
        }
    }

    // ─── FCM cold-start path ────────────────────────────────────────────────

    /**
     * Called by [ObscuraMessagingService.onMessageReceived]. Restores the
     * session if needed, ensures the client is connected, then waits briefly
     * for the incoming-message collector to drain whatever the server has
     * queued. The collector itself is the one posting notifications — this
     * just guarantees it gets a chance to run.
     */
    suspend fun onPushWake(timeoutMs: Long = 25_000L) {
        val c = tryRestore() ?: run {
            Log.w(TAG, "onPushWake: no persisted session, ignoring")
            return
        }
        try {
            // Ensure connected; processPendingMessages handles both cases.
            c.processPendingMessages(timeoutMs)
        } catch (e: Exception) {
            Log.e(TAG, "onPushWake drain failed: ${e.message}")
        }
        // We intentionally do NOT disconnect — if the user opens the app
        // moments later, the live WebSocket is already up.
    }

    /** Bridge surface: deliver a fresh FCM token to JS. */
    fun deliverPushToken(token: String) { sink?.onPushToken(token) }
}
