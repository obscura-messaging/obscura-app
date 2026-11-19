package dev.barrelmaker.obscura

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import java.io.File
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import uniffi.obscura_core.AuthState
import uniffi.obscura_core.ClientEventListener
import uniffi.obscura_core.ConnectionState
import uniffi.obscura_core.EntryModel
import uniffi.obscura_core.ObscuraClient
import uniffi.obscura_core.ObscuraClientConfig
import uniffi.obscura_core.ObscuraException
import uniffi.obscura_core.ObscuraLogger
import uniffi.obscura_core.validateUsername

/** Owns the live client, OS lifecycle and notifications. The core owns session persistence. */
object ObscuraSession : ObscuraLogger, ClientEventListener {
    private const val TAG = "ObscuraSession"
    private const val API_URL = BuildConfig.OBSCURA_API_URL
    /** This device's name on the account, shown in device lists and on the primary when linking. */
    val deviceName: String = android.os.Build.MODEL

    interface EventSink {
        fun onConnectionChanged(state: ConnectionState)
        fun onAuthStateChanged(state: AuthState)
        fun onFriendsChanged()
        fun onMessageReceived(model: EntryModel)
        fun onPeerTypingChanged(peerUserId: String, isTyping: Boolean)
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
    private var restoreJob: Job? = null

    @Volatile var client: ObscuraClient? = null
        private set
    @Volatile private var clientUsername: String? = null
    @Volatile var appInForeground =
        ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        private set
    @Volatile private var sink: EventSink? = null
    private val pushWakeCount = java.util.concurrent.atomic.AtomicInteger(0)

    val logger: ObscuraLogger = this

    override fun log(message: String) { Log.d(TAG, message) }
    override fun decryptFailed(sourceUserId: String, reason: String) { Log.w(TAG, "decrypt failed from $sourceUserId: $reason") }
    override fun ackFailed(envelopeId: String, reason: String) { Log.w(TAG, "ack failed $envelopeId: $reason") }
    override fun tokenRefreshFailed(attempt: Int, reason: String) { Log.e(TAG, "token refresh failed ($attempt): $reason") }
    override fun preKeySyncFailed(reason: String) { Log.w(TAG, "prekey sync failed: $reason") }
    override fun identityChanged(userId: String) { Log.w(TAG, "identity changed: $userId") }
    override fun sessionEstablishFailed(userId: String, reason: String) { Log.w(TAG, "session establish failed $userId: $reason") }
    override fun databaseError(store: String, operation: String, reason: String) { Log.e(TAG, "db error $store.$operation: $reason") }

    override fun onConnectionStateChanged(state: ConnectionState) {
        sink?.onConnectionChanged(state)
    }

    override fun onAuthStateChanged(state: AuthState) {
        sink?.onAuthStateChanged(state)
    }

    override fun onFriendsChanged() {
        sink?.onFriendsChanged()
    }

    override fun onFriendRequestReceived() {
        if (!appInForeground) {
            NotificationHelper.postGeneric(appContext, "New friend request")
        }
    }

    override fun onMessageReceived(model: EntryModel) {
        sink?.onMessageReceived(model)
        if (!appInForeground) {
            notificationText(model)?.let { NotificationHelper.postGeneric(appContext, it) }
        }
    }

    override fun onPeerTypingChanged(peerUserId: String, isTyping: Boolean) {
        sink?.onPeerTypingChanged(peerUserId, isTyping)
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
                        if (!appInForeground || client !== c || c.authState() != AuthState.AUTHENTICATED) return@launch
                        try { c.connect() }
                        catch (e: CancellationException) { throw e }
                        catch (e: Exception) { Log.e(TAG, "Foreground reconnect failed", e) }
                    }
                }

                override fun onStop(owner: LifecycleOwner) {
                    appInForeground = false
                    sink?.onAppStateChanged(AppState.BACKGROUND)
                    val c = client ?: return
                    c.disconnect()
                    val pendingRestore = restoreJob
                    if (pendingRestore?.isActive == true) {
                        scope.launch {
                            pendingRestore.join()
                            if (!appInForeground && client === c && pushWakeCount.get() == 0) {
                                c.disconnect()
                            }
                        }
                    }
                }
            })
        }
        try { tryRestore() }
        catch (e: Exception) { Log.e(TAG, "Session restore failed", e) }
    }

    fun bindEventSink(s: EventSink) {
        sink = s
        s.onAppStateChanged(if (appInForeground) AppState.ACTIVE else AppState.BACKGROUND)
        s.onAuthStateChanged(client?.authState() ?: AuthState.LOGGED_OUT)
        s.onConnectionChanged(client?.connectionState() ?: ConnectionState.DISCONNECTED)
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

    suspend fun reuseOrCreateClient(username: String): ObscuraClient {
        restoreJob?.cancelAndJoin()
        restoreJob = null
        val existing = client
        if (existing != null && clientUsername == username.lowercase(Locale.ROOT) && existing.authState() == AuthState.LOGGED_OUT) {
            return existing
        }
        return createClient(username)
    }

    private fun buildClient(username: String): ObscuraClient {
        validateUsername(username)
        destroyClient(notifySink = false)
        // The server treats usernames case-insensitively; storage must identify the same account.
        val storageName = username.lowercase(Locale.ROOT)
        val dbName = "obscura_$storageName.db"
        val c = try {
            openClient(storageName, dbName)
        } catch (e: ObscuraException.DatabaseUndecryptable) {
            Log.e(TAG, "Database cannot be decrypted; discarding it", e)
            LocalKeystore.discardDatabase(appContext, storageName, dbName)
            sessionStorage.clear()
            openClient(storageName, dbName)
        } catch (e: LocalKeystore.SecretUnavailableException) {
            Log.e(TAG, "Database key unavailable; discarding it", e)
            LocalKeystore.discardDatabase(appContext, storageName, dbName)
            sessionStorage.clear()
            openClient(storageName, dbName)
        }
        client = c
        clientUsername = storageName
        return c
    }

    private fun openClient(storageName: String, dbName: String): ObscuraClient {
        val dbFile = appContext.getDatabasePath(dbName)
        dbFile.parentFile?.mkdirs()
        return ObscuraClient.open(
            ObscuraClientConfig(
                apiUrl = API_URL,
                databasePath = dbFile.absolutePath,
                databaseKey = LocalKeystore.databaseKey(appContext, storageName),
                deviceName = deviceName,
                attachmentCacheDir = File(appContext.cacheDir, "attachments").absolutePath,
            ),
            sessionStorage,
            OkHttpTransport(API_URL),
            this,
            this,
        )
    }

    fun destroyClient(notifySink: Boolean = true) {
        val old = client
        client = null
        clientUsername = null
        if (old != null) {
            runBlocking { old.shutdown() }
        }
        if (notifySink) {
            sink?.onAuthStateChanged(AuthState.LOGGED_OUT)
            sink?.onConnectionChanged(ConnectionState.DISCONNECTED)
        }
    }

    suspend fun waitForRestore() {
        restoreJob?.join()
    }

    @Synchronized
    fun tryRestore(): ObscuraClient? {
        client?.let { return it }
        val saved = sessionStorage.load() ?: return null
        val c = buildClient(saved.username)
        restoreJob = scope.launch {
            if (!c.restorePersistedSession()) {
                Log.w(TAG, "No usable stored session")
            } else if (!appInForeground && pushWakeCount.get() == 0) {
                c.disconnect()
            }
        }
        return c
    }

    private fun notificationText(model: EntryModel): String? = when (model) {
        EntryModel.PIX -> "New pix"
        EntryModel.DIRECT_MESSAGE -> "New message"
        EntryModel.STORY, EntryModel.PROFILE, EntryModel.SEEN -> null
    }

    suspend fun onPushWake(timeoutMs: Long = 25_000L) {
        pushWakeCount.incrementAndGet()
        try {
            val c = tryRestore() ?: return
            restoreJob?.join()
            if (c.authState() == AuthState.AUTHENTICATED) {
                c.processPendingMessages(timeoutMs)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "Push drain failed", e)
        } finally {
            if (pushWakeCount.decrementAndGet() == 0 && !appInForeground) {
                client?.disconnect()
            }
        }
    }

    fun deliverPushToken(token: String) { sink?.onPushToken(token) }
}
