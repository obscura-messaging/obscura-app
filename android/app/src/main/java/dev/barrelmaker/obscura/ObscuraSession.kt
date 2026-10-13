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
import dev.barrelmaker.obscura.kit.ObscuraError
import dev.barrelmaker.obscura.kit.ObscuraLogger
import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import dev.barrelmaker.obscura.kit.stores.FriendStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory
import java.util.Locale

/** Owns the live client, OS lifecycle and notifications. The kit owns session persistence. */
object ObscuraSession {
    private const val TAG = "ObscuraSession"
    private const val API_URL = "https://obscura.barrelmaker.dev"

    interface EventSink {
        fun onConnectionChanged(state: ConnectionState)
        fun onAuthStateChanged(state: AuthState)
        fun onFriendsChanged()
        fun onMessageReceived(model: String)
        fun onPushToken(token: String)
        fun onAppStateChanged(state: AppState)
    }

    enum class AppState { ACTIVE, BACKGROUND }

    private lateinit var appContext: Context
    private val prefs: SharedPreferences by lazy {
        appContext.getSharedPreferences("obscura_session", Context.MODE_PRIVATE)
    }
    private val sessionStorage by lazy { SharedPreferencesSessionStorage(prefs) }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val collectorJobs = mutableListOf<Job>()
    private var restoreJob: Job? = null

    @Volatile var client: ObscuraClient? = null
        private set
    @Volatile var appInForeground =
        ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        private set
    @Volatile private var sink: EventSink? = null

    val logger: ObscuraLogger = object : ObscuraLogger {
        override fun log(message: String) { Log.d(TAG, message) }
        override fun decryptFailed(sourceUserId: String, reason: String) { Log.w(TAG, "decrypt failed from $sourceUserId: $reason") }
        override fun ackFailed(envelopeId: String, reason: String) { Log.w(TAG, "ack failed $envelopeId: $reason") }
        override fun tokenRefreshFailed(attempt: Int, reason: String) { Log.e(TAG, "token refresh failed ($attempt): $reason") }
        override fun preKeyReplenishFailed(reason: String) { Log.w(TAG, "prekey replenish failed: $reason") }
        override fun identityChanged(address: String) { Log.w(TAG, "identity changed: $address") }
        override fun sessionEstablishFailed(userId: String, reason: String) { Log.e(TAG, "session establish failed $userId: $reason") }
        override fun databaseError(store: String, operation: String, reason: String) { Log.e(TAG, "db error $store.$operation: $reason") }
    }

    fun init(app: Context) {
        appContext = app.applicationContext
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) {
                    appInForeground = true
                    sink?.onAppStateChanged(AppState.ACTIVE)
                    val c = client ?: return
                    scope.launch {
                        restoreJob?.join()
                        if (c.authState.value != AuthState.AUTHENTICATED) return@launch
                        try { c.connect() }
                        catch (e: CancellationException) { throw e }
                        catch (e: Exception) { Log.e(TAG, "Foreground reconnect failed", e) }
                    }
                }

                override fun onStop(owner: LifecycleOwner) {
                    appInForeground = false
                    sink?.onAppStateChanged(AppState.BACKGROUND)
                }
            })
        }
        try { tryRestore() }
        catch (e: Exception) { Log.e(TAG, "Session restore failed", e) }
    }

    fun bindEventSink(s: EventSink) {
        sink = s
        s.onAppStateChanged(if (appInForeground) AppState.ACTIVE else AppState.BACKGROUND)
        s.onAuthStateChanged(client?.authState?.value ?: AuthState.LOGGED_OUT)
        s.onConnectionChanged(client?.connectionState?.value ?: ConnectionState.DISCONNECTED)
        s.onFriendsChanged()
    }

    fun unbindEventSink(s: EventSink) {
        if (sink === s) sink = null
    }

    suspend fun createClient(username: String): ObscuraClient {
        restoreJob?.cancelAndJoin()
        restoreJob = null
        client?.logout()
        return buildClient(username)
    }

    private fun buildClient(username: String): ObscuraClient {
        if (!Regex("^[a-zA-Z0-9_]{3,50}$").matches(username)) {
            throw ObscuraError.InvalidArgument("Invalid username")
        }
        destroyClient()
        // The server treats usernames case-insensitively; storage must identify the same account.
        val storageName = username.lowercase(Locale.ROOT)
        val dbName = "obscura_$storageName.db"
        System.loadLibrary("sqlcipher")
        val driver = try {
            openDatabase(storageName, dbName)
        } catch (e: Exception) {
            if (!isUndecryptable(e)) throw e
            Log.e(TAG, "Database cannot be decrypted; discarding it", e)
            LocalKeystore.discardDatabase(appContext, storageName, dbName)
            sessionStorage.clear()
            openDatabase(storageName, dbName)
        }
        return ObscuraClient(
            ObscuraConfig(apiUrl = API_URL, deviceName = android.os.Build.MODEL),
            driver = driver,
            sessionStorage = sessionStorage,
        ).also {
            it.logger = logger
            client = it
            startCollectors(it)
        }
    }

    private fun openDatabase(username: String, dbName: String): AndroidSqliteDriver {
        val driver = AndroidSqliteDriver(
            ObscuraDatabase.Schema, appContext, dbName,
            factory = SupportOpenHelperFactory(LocalKeystore.databaseKey(appContext, username)),
        )
        try {
            driver.executeQuery(null, "SELECT count(*) FROM sqlite_master", { it.next(); QueryResult.Unit }, 0)
        } catch (e: Exception) {
            driver.close()
            throw e
        }
        return driver
    }

    private fun isUndecryptable(e: Throwable): Boolean =
        generateSequence(e) { it.cause }.any {
            it is LocalKeystore.SecretUnavailableException ||
                it is SQLiteDatabaseCorruptException ||
                it.message?.contains("file is not a database") == true
        }

    fun destroyClient() {
        collectorJobs.forEach { it.cancel() }
        collectorJobs.clear()
        client?.disconnect()
        client = null
    }

    suspend fun waitForRestore() {
        restoreJob?.join()
    }

    @Synchronized
    fun tryRestore(): ObscuraClient? {
        client?.let { return it }
        val saved = sessionStorage.load() ?: return null
        val username = saved["username"] ?: return null
        val c = buildClient(username)
        restoreJob = scope.launch {
            if (!c.restorePersistedSession()) Log.w(TAG, "No usable stored session")
        }
        return c
    }

    private fun startCollectors(c: ObscuraClient) {
        collectorJobs += scope.launch { c.connectionState.collect { sink?.onConnectionChanged(it) } }
        collectorJobs += scope.launch { c.authState.collect { sink?.onAuthStateChanged(it) } }
        collectorJobs += scope.launch {
            var previousPending: Set<String>? = null
            c.friendsChanged.collect {
                sink?.onFriendsChanged()
                try {
                    val pending = c.getFriends().filter { it.status == FriendStatus.PENDING_RECEIVED }
                        .map { it.userId }.toSet()
                    if (!appInForeground && previousPending?.let { (pending - it).isNotEmpty() } == true) {
                        NotificationHelper.postGeneric(appContext, "New friend request")
                    }
                    previousPending = pending
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    logger.databaseError("friends", "notification", e.message ?: e.javaClass.simpleName)
                }
            }
        }
        collectorJobs += scope.launch {
            for (model in c.messageReceived) {
                sink?.onMessageReceived(model)
                if (!appInForeground) {
                    notificationText(model)?.let { NotificationHelper.postGeneric(appContext, it) }
                }
            }
        }
    }

    private fun notificationText(model: String): String? = when (model) {
        "pix" -> "New pix"
        "directMessage" -> "New message"
        "story", "profile", "seen" -> null
        else -> {
            Log.w(TAG, "Unknown notification model: $model")
            "New message"
        }
    }

    suspend fun onPushWake(timeoutMs: Long = 25_000L) {
        try {
            val c = tryRestore() ?: return
            restoreJob?.join()
            if (c.authState.value == AuthState.AUTHENTICATED) c.processPendingMessages(timeoutMs)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "Push drain failed", e)
        }
    }

    fun deliverPushToken(token: String) { sink?.onPushToken(token) }
}
