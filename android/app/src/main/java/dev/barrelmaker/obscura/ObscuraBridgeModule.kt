package dev.barrelmaker.obscura

import android.content.Context
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import dev.barrelmaker.obscura.kit.AuthState
import dev.barrelmaker.obscura.kit.ConnectionState
import dev.barrelmaker.obscura.kit.ConversationItem
import dev.barrelmaker.obscura.kit.DeviceInfo
import dev.barrelmaker.obscura.kit.LinkRequest
import dev.barrelmaker.obscura.kit.LoginScenario
import dev.barrelmaker.obscura.kit.MediaAttachment
import dev.barrelmaker.obscura.kit.ObscuraClient
import dev.barrelmaker.obscura.kit.ObscuraError
import dev.barrelmaker.obscura.kit.ProfileItem
import dev.barrelmaker.obscura.kit.StoryItem
import dev.barrelmaker.obscura.kit.TypingState
import dev.barrelmaker.obscura.kit.stores.Friend
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.sync.Mutex

private const val TAG = "ObscuraBridge"

/** Matches the event union in `src/native/ObscuraModule.ts`. */
private enum class BridgeEvent(val type: String) {
    CONNECTION_CHANGED("connectionChanged"),
    AUTH_STATE_CHANGED("authStateChanged"),
    APP_STATE_CHANGED("appStateChanged"),
    LAUNCHED_FROM("launchedFrom"),
    FRIENDS_CHANGED("friendsChanged"),
    MESSAGE_RECEIVED("messageReceived"),
    TYPING_CHANGED("typingChanged"),
    PUSH_TOKEN_RECEIVED("pushTokenReceived"),
}

/**
 * Single mapping from the kit's [ConnectionState] to the JS wire string (the
 * `ConnectionState` union in ObscuraModule.ts). Kept in one place so getState and
 * the connectionChanged event can never drift.
 */
private fun ConnectionState.toJsString(): String = when (this) {
    ConnectionState.DISCONNECTED -> "disconnected"
    ConnectionState.CONNECTING -> "connecting"
    ConnectionState.RECONNECTING -> "reconnecting"
    ConnectionState.CONNECTED -> "connected"
}

/**
 * Thin React Native bridge. Owns NO Obscura state — all client lifecycle,
 * message dispatch, foreground tracking and notification posting lives in
 * [ObscuraSession]. This class:
 *
 *   - Registers itself as the session's [ObscuraSession.EventSink] so events
 *     reach JS
 *   - Translates @ReactMethod RPCs into kit calls on `ObscuraSession.client`
 *   - Marshals between RN [WritableMap]/Promise and Kotlin types
 *
 * If you need to mutate session state (create/destroy client, save prefs),
 * call into [ObscuraSession] — do NOT keep a local copy of anything.
 */
class ObscuraBridgeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "ObscuraBridge"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val authMutex = Mutex()
    private val typingJobs = mutableMapOf<String, Job>()

    /** The link this device is waiting on. Its secrets never cross to JS, which holds only the code. */
    private class PendingLink(val client: ObscuraClient, val request: LinkRequest)
    @Volatile private var pendingLink: PendingLink? = null
    @Volatile private var linkJob: Job? = null

    private val client: ObscuraClient?
        get() = ObscuraSession.client

    private fun requireClient(): ObscuraClient =
        client ?: throw ObscuraError.NotAuthenticated()

    /**
     * Reject a promise, preferring a kit [ObscuraError]'s stable [ObscuraError.code]
     * over the per-method [fallbackCode] so JS can branch on *what* failed
     * (e.g. "NOT_FRIENDS", "OFFLINE") instead of parsing an English message.
     */
    private fun Promise.rejectKit(fallbackCode: String, t: Throwable) {
        if (t is ObscuraError) reject(t.code, t.message, t) else reject(fallbackCode, t.message, t)
    }

    private fun authenticate(promise: Promise, code: String, operation: suspend () -> Any?): Job? {
        if (!authMutex.tryLock()) {
            promise.rejectKit(code, ObscuraError.InvalidArgument("Authentication already in progress"))
            return null
        }
        return scope.launch {
            try { promise.resolve(operation()) }
            catch (e: CancellationException) { promise.reject("CANCELLED", "Cancelled", e); throw e }
            catch (e: Exception) { promise.rejectKit(code, e) }
            finally { authMutex.unlock() }
        }
    }

    // ─── EventSink: kit events → JS ─────────────────────────────────────────

    private val eventSink = object : ObscuraSession.EventSink {
        override fun onConnectionChanged(state: ConnectionState) = emit(BridgeEvent.CONNECTION_CHANGED) {
            putString("state", state.toJsString())
        }
        override fun onAuthStateChanged(state: AuthState) {
            if (state == AuthState.LOGGED_OUT) {
                typingJobs.values.forEach { it.cancel() }
                typingJobs.clear()
            }
            emit(BridgeEvent.AUTH_STATE_CHANGED) {
                putString("state", when (state) {
                    AuthState.LOGGED_OUT -> "loggedOut"
                    AuthState.AUTHENTICATED -> "authenticated"
                })
            }
        }
        override fun onFriendsChanged() = emit(BridgeEvent.FRIENDS_CHANGED)
        override fun onMessageReceived(model: String) =
            emit(BridgeEvent.MESSAGE_RECEIVED) { putString("model", model) }
        override fun onPushToken(token: String) = emit(BridgeEvent.PUSH_TOKEN_RECEIVED) { putString("token", token) }
        override fun onAppStateChanged(state: ObscuraSession.AppState) = emit(BridgeEvent.APP_STATE_CHANGED) {
            putString("state", when (state) {
                ObscuraSession.AppState.ACTIVE -> "active"
                ObscuraSession.AppState.BACKGROUND -> "background"
            })
        }
    }

    init {
        instance = this
        ObscuraSession.bindEventSink(eventSink)
    }

    companion object {
        @Volatile private var instance: ObscuraBridgeModule? = null
        const val PUSH_PERMISSION_REQUEST_CODE = 42
        /**
         * Called from [MainActivity.onNewIntent] when a deep-link intent arrives
         * while the app is already running. Cold-start deep-links go through
         * [getLaunchIntent] instead (the bridge isn't built yet at that point).
         */
        fun deliverLaunchedFrom(screen: String) {
            instance?.emit(BridgeEvent.LAUNCHED_FROM) { putString("screen", screen) }
        }

        /**
         * Called from [MainActivity.onRequestPermissionsResult] when the OS
         * delivers a permission decision. Resolves the in-flight push-permission
         * promise based on the user's choice.
         */
        fun deliverPermissionResult(requestCode: Int, grantResults: IntArray) {
            if (requestCode != PUSH_PERMISSION_REQUEST_CODE) return
            instance?.handlePushPermissionResult(grantResults)
        }
    }

    // Pending push-permission state. Guarded by `pendingPermissionLock` so
    // [requestPushPermission] and [handlePushPermissionResult] don't race.
    private val pendingPermissionLock = Any()
    @Volatile private var pendingPermissionPromise: Promise? = null

    internal fun handlePushPermissionResult(grantResults: IntArray) {
        val promise = synchronized(pendingPermissionLock) {
            val p = pendingPermissionPromise
            pendingPermissionPromise = null
            p
        } ?: return
        val granted = grantResults.isNotEmpty() &&
            grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED
        if (granted) {
            // Fetch the token now that we know the user said yes. Resolves
            // the promise with true on success / rejects on FCM failure.
            fetchAndDeliverToken(promise)
        } else {
            promise.resolve(false)
        }
    }

    /**
     * Single event emitter. All `ObscuraEvent` payloads go through here.
     *
     * The wire shape is always: `{ type: <eventType>, ...fields }`.
     * `build` populates the extra fields on top of `type`. Keeping every emission
     * routed through this one helper means the Swift bridge has exactly one
     * pattern to match.
     */
    private fun emit(event: BridgeEvent, build: WritableMap.() -> Unit = {}) {
        val params = Arguments.createMap().apply {
            putString("type", event.type)
            build()
        }
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("ObscuraEvent", params)
        } catch (e: Exception) {
            Log.w(TAG, "emit(${event.type}) failed (JS not ready?): ${e.message}")
        }
    }

    // ─── Auth ───────────────────────────────────────────────────────────────

    @ReactMethod
    fun registerUser(username: String, password: String, promise: Promise) {
        authenticate(promise, "REGISTER_ERROR") {
            ObscuraSession.createClient(username).register(username, password)
            null
        }
    }

    @ReactMethod
    fun login(username: String, password: String, promise: Promise) {
        authenticate(promise, "LOGIN_ERROR") {
            when (ObscuraSession.createClient(username).login(username, password)) {
                LoginScenario.EXISTING_DEVICE -> "existingDevice"
                LoginScenario.LINK_REQUIRED -> "linkRequired"
                LoginScenario.DEVICE_MISMATCH -> "deviceMismatch"
                LoginScenario.INVALID_CREDENTIALS -> "invalidCredentials"
            }
        }
    }

    @ReactMethod
    fun resetAccount(username: String, password: String, promise: Promise) {
        authenticate(promise, "RESET_ERROR") {
            ObscuraSession.createClient(username).resetAccount(username, password)
            null
        }
    }

    @ReactMethod
    fun beginLink(username: String, password: String, promise: Promise) {
        pendingLink = null
        linkJob = authenticate(promise, "LINK_ERROR") {
            val c = ObscuraSession.reuseOrCreateClient(username)
            val request = c.beginLink(username, password, ObscuraSession.deviceName)
            pendingLink = PendingLink(c, request)
            request.code
        }
    }

    /** Cancellable with [cancelLink]; the kit bounds the wait by the link session's expiry. */
    @ReactMethod
    fun completeLink(promise: Promise) {
        val pending = pendingLink
        pendingLink = null
        if (pending == null || pending.client !== client) {
            promise.rejectKit("LINK_ERROR", ObscuraError.InvalidArgument("No link in progress"))
            return
        }
        linkJob = authenticate(promise, "LINK_ERROR") {
            pending.client.completeLink(pending.request)
            null
        }
    }

    /** Resolves once a waiting [completeLink] has settled, so the next auth call does not race it. */
    @ReactMethod
    fun cancelLink(promise: Promise) {
        pendingLink = null
        val job = linkJob
        linkJob = null
        scope.launch {
            job?.cancelAndJoin()
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun connect(promise: Promise) {
        scope.launch {
            try {
                Log.d(TAG, "connect")
                // Kit's connect() refreshes the token and persists the rotated
                // session itself — no app-side pre/post steps needed.
                requireClient().connect()
                promise.resolve(null)
            } catch (e: Exception) {
                Log.e(TAG, "connect failed: ${e.message}")
                promise.rejectKit("CONNECT_ERROR", e)
            }
        }
    }

    @ReactMethod
    fun logout(promise: Promise) {
        authenticate(promise, "LOGOUT_ERROR") {
            ObscuraSession.waitForRestore()
            client?.logout()
            ObscuraSession.destroyClient()
            null
        }
    }

    @ReactMethod
    fun wipeDevice(promise: Promise) {
        authenticate(promise, "WIPE_ERROR") {
            ObscuraSession.waitForRestore()
            requireClient().wipeDevice()
            ObscuraSession.destroyClient()
            null
        }
    }

    // ─── State ──────────────────────────────────────────────────────────────

    @ReactMethod
    fun getConnectionState(promise: Promise) {
        scope.launch {
            ObscuraSession.waitForRestore()
            val state = client?.connectionState?.value ?: ConnectionState.DISCONNECTED
            promise.resolve(state.toJsString())
        }
    }

    @ReactMethod
    fun getFriends(promise: Promise) {
        scope.launch {
            try {
                val arr = Arguments.createArray()
                for (f in client?.getFriends().orEmpty()) arr.pushMap(friendToMap(f, f.status.value))
                promise.resolve(arr)
            } catch (e: Exception) {
                promise.rejectKit("GET_FRIENDS_ERROR", e)
            }
        }
    }

    @ReactMethod
    fun getAuthState(promise: Promise) {
        scope.launch {
            ObscuraSession.waitForRestore()
            promise.resolve(when (client?.authState?.value ?: AuthState.LOGGED_OUT) {
                AuthState.LOGGED_OUT -> "loggedOut"
                AuthState.AUTHENTICATED -> "authenticated"
            })
        }
    }

    @ReactMethod
    fun getUserId(promise: Promise) {
        scope.launch {
            ObscuraSession.waitForRestore()
            promise.resolve(client?.userId)
        }
    }

    @ReactMethod
    fun getUsername(promise: Promise) {
        scope.launch {
            ObscuraSession.waitForRestore()
            promise.resolve(client?.username)
        }
    }

    @ReactMethod
    fun getDeviceId(promise: Promise) {
        scope.launch {
            ObscuraSession.waitForRestore()
            promise.resolve(client?.deviceId)
        }
    }

    @ReactMethod
    fun isPrimary(promise: Promise) {
        scope.launch {
            ObscuraSession.waitForRestore()
            try { promise.resolve(client?.isPrimary() ?: false) }
            catch (e: Exception) { promise.rejectKit("IS_PRIMARY_ERROR", e) }
        }
    }

    // ─── Devices ────────────────────────────────────────────────────────────

    @ReactMethod
    fun linkCodeDeviceName(code: String, promise: Promise) {
        try { promise.resolve(ObscuraClient.linkCodeDeviceName(code)) }
        catch (e: Exception) { promise.rejectKit("LINK_CODE_ERROR", e) }
    }

    @ReactMethod
    fun approveLink(code: String, promise: Promise) {
        scope.launch {
            try {
                requireClient().approveLink(code)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.rejectKit("APPROVE_LINK_ERROR", e)
            }
        }
    }

    @ReactMethod
    fun getDevices(promise: Promise) {
        scope.launch {
            try {
                val arr = Arguments.createArray()
                for (d in requireClient().devices()) arr.pushMap(deviceToMap(d))
                promise.resolve(arr)
            } catch (e: Exception) {
                promise.rejectKit("GET_DEVICES_ERROR", e)
            }
        }
    }

    /** Unlinking this device wipes it, so the host releases the client as [wipeDevice] does. */
    @ReactMethod
    fun unlinkDevice(deviceId: String, promise: Promise) {
        authenticate(promise, "UNLINK_ERROR") {
            val c = requireClient()
            val self = deviceId == c.deviceId
            c.unlinkDevice(deviceId)
            if (self) ObscuraSession.destroyClient()
            null
        }
    }

    // ─── Friends ────────────────────────────────────────────────────────────

    /** Forget a friend: the friendship and their devices. Nothing is sent to them. */
    @ReactMethod
    fun removeFriend(userId: String, promise: Promise) {
        scope.launch {
            try {
                requireClient().removeFriend(userId)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.rejectKit("REMOVE_FRIEND_ERROR", e)
            }
        }
    }

    @ReactMethod
    fun acceptFriend(userId: String, promise: Promise) {
        scope.launch {
            try {
                Log.d(TAG, "acceptFriend: $userId")
                requireClient().acceptFriend(userId)
                promise.resolve(null)
            } catch (e: Exception) {
                Log.e(TAG, "acceptFriend failed: ${e.message}")
                promise.rejectKit("ACCEPT_ERROR", e)
            }
        }
    }

    @ReactMethod
    fun getFriendCode(promise: Promise) {
        // Delegates rather than re-encoding. The format is the kit's (`FriendCode`), it is what
        // `addFriendByCode` decodes on the other side, and it is covered by the kit's tests — a
        // second copy here was one edit away from producing codes this app could not read back.
        scope.launch {
            try {
                val code = requireClient().friendCode()
                Log.d(TAG, "getFriendCode: ${code.take(20)}...")
                promise.resolve(code)
            } catch (e: Exception) {
                promise.rejectKit("NOT_AUTHED", e)
            }
        }
    }

    @ReactMethod
    fun addFriendByCode(code: String, promise: Promise) {
        scope.launch {
            try {
                Log.d(TAG, "addFriendByCode: ${code.take(20)}...")
                // Delegates rather than re-decoding, and this direction was the strictly worse copy:
                // the kit additionally normalises url-safe base64 and rejects a code whose fields are
                // present but empty. Both halves of the format now live in `FriendCode`, where the
                // tests are.
                requireClient().addFriendByCode(code)
                promise.resolve(null)
            } catch (e: Exception) {
                Log.e(TAG, "addFriendByCode failed: ${e.message}")
                promise.rejectKit("ADD_FRIEND_ERROR", e)
            }
        }
    }

    // ─── Signals ────────────────────────────────────────────────────────────

    @ReactMethod
    fun sendTyping(peerUserId: String, promise: Promise) {
        scope.launch {
            try {
                requireClient().sendTyping(peerUserId, TypingState.STARTED)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.rejectKit("TYPING_ERROR", e)
            }
        }
    }

    @ReactMethod
    fun stopTyping(peerUserId: String, promise: Promise) {
        scope.launch {
            try {
                requireClient().sendTyping(peerUserId, TypingState.STOPPED)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.rejectKit("STOP_TYPING_ERROR", e)
            }
        }
    }

    @ReactMethod
    fun observeTyping(peerUserId: String, promise: Promise) {
        if (typingJobs.containsKey(peerUserId)) { promise.resolve(null); return }
        val flow = try {
            requireClient().observePeerTyping(peerUserId)
        } catch (e: Exception) {
            promise.rejectKit("OBSERVE_TYPING_ERROR", e)
            return
        }

        typingJobs[peerUserId] = scope.launch {
            flow.collectLatest { isTyping ->
                emit(BridgeEvent.TYPING_CHANGED) {
                    putString("peerUserId", peerUserId)
                    putBoolean("typing", isTyping)
                }
            }
        }
        promise.resolve(null)
    }

    @ReactMethod
    fun stopObservingTyping(peerUserId: String, promise: Promise) {
        typingJobs.remove(peerUserId)?.cancel()
        promise.resolve(null)
    }

    // ─── Attachments (path-based) ───────────────────────────────────────────
    // Bytes and key material never cross the bridge. JS hands us a file path; the kit encrypts,
    // uploads and keeps the keys. On download, JS names the entry and gets back a decrypted
    // cache path it can use directly as a `file://` URI.

    @ReactMethod
    fun sendCapture(capture: ReadableMap, promise: Promise) {
        scope.launch {
            try {
                val recipients = capture.getArray("recipientUserIds")?.toArrayList()?.map { it as String }.orEmpty()
                val result = requireClient().sendCapture(
                    file = java.io.File(capture.getString("path") ?: ""),
                    mediaType = capture.getString("mediaType") ?: "photo",
                    caption = capture.getString("caption") ?: "",
                    captionMeta = if (capture.isNull("captionMeta")) null else capture.getString("captionMeta"),
                    displayDuration = capture.getDouble("displayDuration").toInt(),
                    peerUserIds = recipients,
                    toStory = capture.getBoolean("toStory"),
                )
                promise.resolve(Arguments.createMap().apply {
                    putArray("undeliveredUserIds", Arguments.fromList(result.undeliveredPeerUserIds))
                    putBoolean("storyUndelivered", result.storyUndelivered)
                })
            } catch (e: Exception) {
                promise.rejectKit("SEND_CAPTURE_ERROR", e)
            }
        }
    }

    @ReactMethod
    fun downloadAttachment(entryId: String, promise: Promise) {
        scope.launch {
            try {
                promise.resolve(requireClient().downloadAttachmentToCache(entryId).absolutePath)
            } catch (t: Throwable) {
                promise.rejectKit("DOWNLOAD_ERROR", t)
            }
        }
    }

    // ─── Image processing (native, path-in/path-out) ────────────────────────

    @ReactMethod
    fun resizeImage(srcPath: String, maxDim: Int, quality: Int, promise: Promise) {
        scope.launch {
            try {
                val res = ImageProcessor.resize(reactApplicationContext.cacheDir, srcPath, maxDim, quality)
                promise.resolve(Arguments.createMap().apply {
                    putString("path", res.path)
                    putInt("width", res.width)
                    putInt("height", res.height)
                })
            } catch (t: Throwable) {
                Log.e(TAG, "resizeImage failed: ${t.message}")
                promise.rejectKit("RESIZE_ERROR", t)
            }
        }
    }

    @ReactMethod
    fun writeTestImage(width: Int, height: Int, promise: Promise) {
        scope.launch {
            try {
                val res = ImageProcessor.writeTestImage(reactApplicationContext.cacheDir, width, height)
                promise.resolve(Arguments.createMap().apply {
                    putString("path", res.path)
                    putInt("width", res.width)
                    putInt("height", res.height)
                })
            } catch (t: Throwable) {
                promise.rejectKit("TEST_IMAGE_ERROR", t)
            }
        }
    }

    // ─── Debug ──────────────────────────────────────────────────────────────

    @ReactMethod
    fun getDebugLog(promise: Promise) {
        val log = client?.getDebugLog().orEmpty()
        val arr = Arguments.createArray()
        for (line in log) arr.pushString(line)
        promise.resolve(arr)
    }

    // ─── Deep linking ───────────────────────────────────────────────────────

    /**
     * Returns the cold-start deep-link target (currently just a "screen"
     * extra set by [NotificationHelper]) and consumes the extra so subsequent
     * calls return null. JS should call this once on app mount; warm-start
     * deep-links arrive via the `launchedFrom` event instead.
     */
    @ReactMethod
    fun getLaunchIntent(promise: Promise) {
        val activity = reactApplicationContext.currentActivity
        val intent = activity?.intent
        val screen = intent?.getStringExtra("screen")
        // Consume the extra so a config change / re-call doesn't re-trigger.
        intent?.removeExtra("screen")
        if (screen == null) {
            promise.resolve(null)
        } else {
            promise.resolve(Arguments.createMap().apply { putString("screen", screen) })
        }
    }

    // ─── Push Notifications ─────────────────────────────────────────────────

    /**
     * Permission flow:
     *   1. If POST_NOTIFICATIONS is already granted (or pre-Tiramisu where it
     *      doesn't exist), skip straight to token fetch.
     *   2. Otherwise, request via the activity. Result arrives via the
     *      activity's onRequestPermissionsResult, which forwards to
     *      [deliverPermissionResult] below.
     *   3. On grant → fetch FCM token and deliver via the `pushTokenReceived`
     *      event, then resolve the promise with `true`.
     *      On deny → resolve `false` immediately, never fetch the token.
     *
     * We DO NOT register the token with our server here — that's a separate
     * `registerPushToken` call from JS after the `pushTokenReceived` event.
     * This guarantee applies only to this explicit request; Firebase
     * `onNewToken` may emit independently and JS currently registers it.
     */
    @ReactMethod
    fun requestPushPermission(promise: Promise) {
        // Pre-Tiramisu: notifications are always allowed at the OS level.
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU) {
            fetchAndDeliverToken(promise)
            return
        }
        val activity = reactApplicationContext.currentActivity
        if (activity == null) {
            // No activity (process backgrounded?) — defer the decision; reject
            // so JS knows to retry rather than assume granted.
            promise.reject("NO_ACTIVITY", "Cannot request permission without a foreground activity")
            return
        }
        val granted = androidx.core.content.ContextCompat.checkSelfPermission(
            activity, android.Manifest.permission.POST_NOTIFICATIONS,
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
        if (granted) {
            fetchAndDeliverToken(promise)
            return
        }
        // Stash the promise; resolve it when the activity hands us the result.
        synchronized(pendingPermissionLock) {
            // Reject any previous in-flight request — only one user-facing
            // prompt can be on screen at a time anyway.
            pendingPermissionPromise?.reject("SUPERSEDED", "Replaced by a newer permission request")
            pendingPermissionPromise = promise
        }
        androidx.core.app.ActivityCompat.requestPermissions(
            activity,
            arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),
            PUSH_PERMISSION_REQUEST_CODE,
        )
    }

    @Suppress("DEPRECATION")
    private fun fetchAndDeliverToken(promise: Promise) {
        try {
            com.google.firebase.messaging.FirebaseMessaging.getInstance().token
                .addOnCompleteListener { task ->
                    if (task.isSuccessful) {
                        val token = task.result
                        Log.d(TAG, "FCM token: ${token.take(20)}...")
                        ObscuraSession.deliverPushToken(token)
                        promise.resolve(true)
                    } else {
                        Log.e(TAG, "FCM token fetch failed: ${task.exception?.message}")
                        promise.reject("TOKEN_ERROR", task.exception?.message ?: "Token fetch failed")
                    }
                }
        } catch (e: Exception) {
            promise.rejectKit("FCM_INIT_ERROR", e)
        }
    }

    @ReactMethod
    fun registerPushToken(token: String, promise: Promise) {
        scope.launch {
            try {
                requireClient().registerPushToken(token)
                Log.d(TAG, "registerPushToken OK")
                promise.resolve(null)
            } catch (e: Exception) {
                Log.e(TAG, "registerPushToken failed: ${e.message}")
                promise.rejectKit("REGISTER_TOKEN_ERROR", e)
            }
        }
    }

    // ─── RN plumbing ────────────────────────────────────────────────────────

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    // ─── File helpers ───────────────────────────────────────────────────────
    // Just enough to let JS clean up temp files (e.g. vision-camera's capture path).

    @ReactMethod
    fun deleteFile(path: String, promise: Promise) {
        try {
            java.io.File(path).delete()
            promise.resolve(null)
        } catch (e: Throwable) {
            promise.rejectKit("DELETE_FAILED", e)
        }
    }

    // Parity with iOS `prewarmAudioSession`. Android's MediaRecorder audio init
    // is fast (no slow AVAudioSession-style HAL negotiation), so this is a no-op;
    // it exists so the JS bridge contract is identical on both platforms.
    @ReactMethod
    fun prewarmAudioSession(promise: Promise) {
        promise.resolve(null)
    }

    // ─── Clipboard ──────────────────────────────────────────────────────────
    // Native-side clipboard so we don't depend on RN core's deprecated
    // Clipboard module or pull in @react-native-clipboard/clipboard for a
    // single setString use case.

    @ReactMethod
    fun setClipboard(text: String, promise: Promise) {
        UiThreadUtil.runOnUiThread {
            try {
                val cm = reactApplicationContext.getSystemService(Context.CLIPBOARD_SERVICE)
                    as android.content.ClipboardManager
                cm.setPrimaryClip(android.content.ClipData.newPlainText("text", text))
                promise.resolve(null)
            } catch (e: Throwable) {
                promise.rejectKit("CLIPBOARD_FAILED", e)
            }
        }
    }

    override fun invalidate() {
        super.invalidate()
        ObscuraSession.unbindEventSink(eventSink)
        typingJobs.values.forEach { it.cancel() }
        typingJobs.clear()
        scope.cancel()
        instance = null
    }

    // ─── Marshallers ────────────────────────────────────────────────────────

    private fun deviceToMap(d: DeviceInfo): WritableMap =
        Arguments.createMap().apply {
            putString("deviceId", d.deviceId)
            putString("name", d.name)
            putBoolean("isPrimary", d.isPrimary)
            putBoolean("isThisDevice", d.isThisDevice)
        }

    private fun friendToMap(f: Friend, status: String): WritableMap =
        Arguments.createMap().apply {
            putString("userId", f.userId)
            putString("username", f.username)
            putString("status", status)
        }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Typed content surface.
    // ─────────────────────────────────────────────────────────────────────────────────────────

    @ReactMethod
    fun getMessages(promise: Promise) {
        scope.launch {
            try {
                val arr = Arguments.createArray()
                for (m in requireClient().getMessages()) arr.pushMap(messageToMap(m))
                promise.resolve(arr)
            } catch (e: Exception) {
                promise.rejectKit("GET_MESSAGES_ERROR", e)
            }
        }
    }

    @ReactMethod
    fun sendMessage(peerUserId: String, content: String, promise: Promise) {
        scope.launch {
            try {
                promise.resolve(requireClient().sendMessage(peerUserId, content))
            } catch (e: Exception) {
                promise.rejectKit("SEND_MESSAGE_ERROR", e)
            }
        }
    }

    @ReactMethod
    fun markSeen(entryId: String, promise: Promise) {
        scope.launch {
            try {
                requireClient().markSeen(entryId)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.rejectKit("MARK_SEEN_ERROR", e)
            }
        }
    }

    @ReactMethod
    fun getStories(promise: Promise) {
        scope.launch {
            try {
                val arr = Arguments.createArray()
                for (s in requireClient().getStories()) arr.pushMap(storyToMap(s))
                promise.resolve(arr)
            } catch (e: Exception) {
                promise.rejectKit("GET_STORIES_ERROR", e)
            }
        }
    }

    @ReactMethod
    fun getProfiles(promise: Promise) {
        scope.launch {
            try {
                val arr = Arguments.createArray()
                for (p in requireClient().getProfiles()) arr.pushMap(profileToMap(p))
                promise.resolve(arr)
            } catch (e: Exception) {
                promise.rejectKit("GET_PROFILES_ERROR", e)
            }
        }
    }

    @ReactMethod
    fun updateProfile(displayName: String, bio: String, promise: Promise) {
        scope.launch {
            try {
                requireClient().updateProfile(displayName, bio)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.rejectKit("UPDATE_PROFILE_ERROR", e)
            }
        }
    }

    @ReactMethod
    fun flushOutbox(promise: Promise) {
        scope.launch {
            try {
                promise.resolve(requireClient().flushOutbox())
            } catch (e: Exception) {
                promise.rejectKit("FLUSH_OUTBOX_ERROR", e)
            }
        }
    }

    @ReactMethod
    fun sweepExpired(promise: Promise) {
        scope.launch {
            try {
                val touched = requireClient().sweepExpired()
                val arr = Arguments.createArray()
                for (model in touched) arr.pushString(model)
                promise.resolve(arr)
            } catch (e: Exception) {
                promise.rejectKit("SWEEP_EXPIRED_ERROR", e)
            }
        }
    }

    private fun attachmentToMap(att: MediaAttachment): WritableMap =
        Arguments.createMap().apply {
            putString("id", att.id)
            putString("mediaType", att.mediaType)
        }

    private fun messageToMap(m: ConversationItem): WritableMap =
        Arguments.createMap().apply {
            putString("id", m.id)
            putString("peerUserId", m.peerUserId)
            putString("kind", m.kind)
            putString("authorUserId", m.authorUserId)
            putDouble("sentAt", m.sentAt.toDouble())
            val viewedAt = m.viewedAt
            if (viewedAt != null) putDouble("viewedAt", viewedAt.toDouble()) else putNull("viewedAt")
            if (m.kind == "pix") {
                val att = m.attachment
                if (att != null) putMap("attachment", attachmentToMap(att)) else putNull("attachment")
                putString("caption", m.caption)
                putString("captionMeta", m.captionMeta)
                putInt("displayDuration", m.displayDuration)
            } else {
                putString("content", m.content)
            }
        }

    private fun storyToMap(s: StoryItem): WritableMap =
        Arguments.createMap().apply {
            putString("id", s.id)
            putString("authorUserId", s.authorUserId)
            putDouble("sentAt", s.sentAt.toDouble())
            putString("content", s.content)
            putString("captionMeta", s.captionMeta)
            val att = s.attachment
            if (att != null) putMap("attachment", attachmentToMap(att)) else putNull("attachment")
        }

    private fun profileToMap(p: ProfileItem): WritableMap =
        Arguments.createMap().apply {
            putString("userId", p.userId)
            putString("authorDeviceId", p.authorDeviceId)
            putDouble("updatedAt", p.updatedAt.toDouble())
            putString("displayName", p.displayName)
            putString("bio", p.bio)
        }
}
