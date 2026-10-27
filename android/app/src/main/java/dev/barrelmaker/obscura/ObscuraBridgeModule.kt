package dev.barrelmaker.obscura

import android.content.Context
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import dev.barrelmaker.obscura.kit.AuthState
import dev.barrelmaker.obscura.kit.ConnectionState
import dev.barrelmaker.obscura.kit.DeviceInfo
import dev.barrelmaker.obscura.kit.LinkRequest
import dev.barrelmaker.obscura.kit.ObscuraClient
import dev.barrelmaker.obscura.kit.ObscuraError
import dev.barrelmaker.obscura.kit.SendReport
import dev.barrelmaker.obscura.kit.SubmissionResult
import dev.barrelmaker.obscura.kit.TypingState
import dev.barrelmaker.obscura.kit.LoginScenario
import dev.barrelmaker.obscura.kit.stores.FriendData
import dev.barrelmaker.obscura.kit.stores.StoredEntry
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.sync.Mutex
import org.json.JSONObject

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
        override fun onAuthStateChanged(state: AuthState) = emit(BridgeEvent.AUTH_STATE_CHANGED) {
            putString("state", when (state) {
                AuthState.LOGGED_OUT -> "loggedOut"
                AuthState.AUTHENTICATED -> "authenticated"
            })
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

    /** Fired after a successful local CRUD on a model. Lets screens re-query reactively. */

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
                LoginScenario.NO_DEVICES -> "noDevices"
                LoginScenario.DEVICE_MISMATCH -> "deviceMismatch"
                LoginScenario.INVALID_CREDENTIALS -> "invalidCredentials"
            }
        }
    }

    @ReactMethod
    fun provisionPrimary(username: String, password: String, promise: Promise) {
        authenticate(promise, "PROVISION_ERROR") {
            ObscuraSession.createClient(username).provisionPrimary(username, password)
            null
        }
    }

    @ReactMethod
    fun resetAccount(username: String, password: String, promise: Promise) {
        authenticate(promise, "RESET_ERROR") {
            ObscuraSession.createClient(username).resetAccount(username, password)
            ObscuraSession.destroyClient()
            null
        }
    }

    @ReactMethod
    fun beginLink(username: String, password: String, promise: Promise) {
        pendingLink = null
        authenticate(promise, "LINK_ERROR") {
            val c = ObscuraSession.createClient(username)
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
        val state = client?.connectionState?.value ?: ConnectionState.DISCONNECTED
        promise.resolve(state.toJsString())
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

    @ReactMethod fun getUserId(promise: Promise) { promise.resolve(client?.userId) }
    @ReactMethod fun getUsername(promise: Promise) { promise.resolve(client?.username) }
    @ReactMethod fun getDeviceId(promise: Promise) { promise.resolve(client?.deviceId) }

    @ReactMethod
    fun isPrimary(promise: Promise) {
        scope.launch {
            try { promise.resolve(client?.isPrimary() ?: false) }
            catch (e: Exception) { promise.rejectKit("IS_PRIMARY_ERROR", e) }
        }
    }

    // ─── Devices ────────────────────────────────────────────────────────────

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
    //
    @ReactMethod
    fun sendTyping(recipientUserIds: ReadableArray, conversationId: String, promise: Promise) {
        scope.launch {
            try {
                requireClient().sendTyping(
                    recipientUserIds.toStringList(),
                    conversationId,
                    TypingState.STARTED,
                )
                promise.resolve(null)
            } catch (e: Exception) {
                promise.rejectKit("TYPING_ERROR", e)
            }
        }
    }

    @ReactMethod
    fun stopTyping(recipientUserIds: ReadableArray, conversationId: String, promise: Promise) {
        scope.launch {
            try {
                requireClient().sendTyping(
                    recipientUserIds.toStringList(),
                    conversationId,
                    TypingState.STOPPED,
                )
                promise.resolve(null)
            } catch (e: Exception) {
                promise.rejectKit("STOP_TYPING_ERROR", e)
            }
        }
    }

    @ReactMethod
    fun observeTyping(conversationId: String, promise: Promise) {
        if (typingJobs.containsKey(conversationId)) { promise.resolve(null); return }
        val c = try {
            requireClient()
        } catch (e: Exception) {
            promise.rejectKit("OBSERVE_TYPING_ERROR", e)
            return
        }

        typingJobs[conversationId] = scope.launch {
            c.observeTyping(conversationId).collectLatest { userIds ->
                emit(BridgeEvent.TYPING_CHANGED) {
                    putString("conversationId", conversationId)
                    putArray("userIds", Arguments.createArray().apply { userIds.forEach(::pushString) })
                }
            }
        }
        promise.resolve(null)
    }

    @ReactMethod
    fun stopObservingTyping(conversationId: String, promise: Promise) {
        typingJobs.remove(conversationId)?.cancel()
        promise.resolve(null)
    }

    // ─── Attachments (path-based) ───────────────────────────────────────────
    // Bytes never cross the bridge. JS hands us a file path; the kit encrypts and
    // uploads. On download, we decrypt to a deterministic cache path and return
    // that path so JS can use it directly as a `file://` URI.

    @ReactMethod
    fun uploadAttachment(filePath: String, promise: Promise) {
        scope.launch {
            try {
                val bytes = java.io.File(filePath).readBytes()
                // The kit encrypts + uploads and returns the reference triple.
                val ref = requireClient().uploadAttachment(bytes)
                promise.resolve(Arguments.createMap().apply {
                    putString("id", ref.id)
                    putString("contentKey", Base64.encodeToString(ref.contentKey, Base64.NO_WRAP))
                    putString("nonce", Base64.encodeToString(ref.nonce, Base64.NO_WRAP))
                })
            } catch (e: Exception) {
                promise.rejectKit("UPLOAD_ERROR", e)
            }
        }
    }

    private fun attachmentDir() = java.io.File(reactApplicationContext.cacheDir, "attachments")

    /** Cache file stem for an attachment id. Ids come from the server, so never trust them as a path. */
    private fun attachmentStem(id: String) = id.replace(Regex("[^A-Za-z0-9_-]"), "_")

    private val attachmentExtensions = listOf("jpg", "mp4", "mov")

    @ReactMethod
    fun downloadAttachment(id: String, contentKey: String, nonce: String, promise: Promise) {
        scope.launch {
            try {
                val dir = attachmentDir().apply { mkdirs() }
                val safe = attachmentStem(id)
                for (ext in attachmentExtensions) {
                    val c = java.io.File(dir, "$safe.$ext")
                    if (c.exists() && c.length() > 0L) { promise.resolve(c.absolutePath); return@launch }
                }

                val keyBytes = Base64.decode(contentKey, Base64.DEFAULT)
                val nonceBytes = Base64.decode(nonce, Base64.DEFAULT)
                val data = requireClient().downloadDecryptedAttachment(id, keyBytes, nonceBytes)

                // Pick the extension from the content so players that key off it
                // (ExoPlayer / AVPlayer) can decode. Video is ISO-BMFF with an
                // "ftyp" box at offset 4; brand "qt  " => QuickTime .mov.
                val ext = if (data.size >= 12 &&
                    data[4] == 0x66.toByte() && data[5] == 0x74.toByte() &&
                    data[6] == 0x79.toByte() && data[7] == 0x70.toByte()) {
                    if (String(data, 8, 4, Charsets.US_ASCII) == "qt  ") "mov" else "mp4"
                } else "jpg"
                val dest = java.io.File(dir, "$safe.$ext")

                // Atomic publish: write to a tmp file then rename into place so a
                // concurrent reader never sees a partially-written file.
                val tmp = java.io.File(dir, "$safe.$ext.tmp")
                try {
                    tmp.writeBytes(data)
                    if (!tmp.renameTo(dest)) {
                        // Fallback for the (unlikely) cross-mount rename failure.
                        tmp.copyTo(dest, overwrite = true)
                    }
                } finally {
                    tmp.delete()
                }
                promise.resolve(dest.absolutePath)
            } catch (t: Throwable) {
                promise.rejectKit("DOWNLOAD_ERROR", t)
            }
        }
    }

    /** Delete this device's decrypted copy of an attachment. The server's ciphertext is untouched. */
    @ReactMethod
    fun purgeAttachment(id: String, promise: Promise) {
        val dir = attachmentDir()
        val stem = attachmentStem(id)
        for (ext in attachmentExtensions) {
            java.io.File(dir, "$stem.$ext").delete()
            java.io.File(dir, "$stem.$ext.tmp").delete()
        }
        promise.resolve(null)
    }

    // ─── Image processing (native, path-in/path-out) ────────────────────────

    /**
     * Resize the image at [srcPath] so its largest side is at most [maxDim] px,
     * re-encoded as JPEG at [quality] (1-100). Honors the JPEG's EXIF
     * `Orientation` tag — the output pixels are already in display orientation
     * (front-camera selfies don't render rotated). Returns the new file path
     * plus its post-rotation dimensions. The original file is left untouched.
     *
     * Memory: uses `inSampleSize` two-pass decoding so a 12 MP source doesn't
     * allocate a 48 MB intermediate bitmap on low-memory devices.
     */
    @ReactMethod
    fun resizeImage(srcPath: String, maxDim: Int, quality: Int, promise: Promise) {
        scope.launch {
            try {
                require(maxDim > 0) { "maxDim must be positive (got $maxDim)" }

                // Pass 1: read bounds only.
                val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
                android.graphics.BitmapFactory.decodeFile(srcPath, bounds)
                if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
                    throw IllegalArgumentException("Could not decode image at $srcPath")
                }

                // Pass 2: sub-sampled decode keeps peak memory bounded.
                val srcLargest = maxOf(bounds.outWidth, bounds.outHeight)
                var sample = 1
                while (sample * 2 <= srcLargest / maxDim) sample *= 2
                val decoded = android.graphics.BitmapFactory.decodeFile(
                    srcPath,
                    android.graphics.BitmapFactory.Options().apply { inSampleSize = sample },
                ) ?: throw IllegalArgumentException("Could not decode image at $srcPath")

                // EXIF orientation — both the rotation and the flip variants used by
                // Android front cameras. We bake the transform into the bitmap so the
                // output JPEG has display-orientation pixels and no orientation tag.
                val orientation = try {
                    android.media.ExifInterface(srcPath).getAttributeInt(
                        android.media.ExifInterface.TAG_ORIENTATION,
                        android.media.ExifInterface.ORIENTATION_NORMAL,
                    )
                } catch (_: Throwable) { android.media.ExifInterface.ORIENTATION_NORMAL }

                val matrix = android.graphics.Matrix()
                when (orientation) {
                    android.media.ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
                    android.media.ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
                    android.media.ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
                    android.media.ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
                    android.media.ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
                    android.media.ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.postRotate(90f); matrix.postScale(-1f, 1f) }
                    android.media.ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.postRotate(-90f); matrix.postScale(-1f, 1f) }
                }

                // 90°/270° orientations swap apparent width/height for the scale check.
                val swap = orientation == android.media.ExifInterface.ORIENTATION_ROTATE_90 ||
                           orientation == android.media.ExifInterface.ORIENTATION_ROTATE_270 ||
                           orientation == android.media.ExifInterface.ORIENTATION_TRANSPOSE ||
                           orientation == android.media.ExifInterface.ORIENTATION_TRANSVERSE
                val rotW = if (swap) decoded.height else decoded.width
                val rotH = if (swap) decoded.width else decoded.height
                val rotLargest = maxOf(rotW, rotH)
                val scale = if (rotLargest <= maxDim) 1.0 else maxDim.toDouble() / rotLargest
                if (scale != 1.0) matrix.postScale(scale.toFloat(), scale.toFloat())

                val output = android.graphics.Bitmap.createBitmap(
                    decoded, 0, 0, decoded.width, decoded.height, matrix, true,
                )
                if (output !== decoded) decoded.recycle()

                val dir = java.io.File(reactApplicationContext.cacheDir, "resized").apply { mkdirs() }
                val dest = java.io.File(dir, "img_${System.currentTimeMillis()}.jpg")
                java.io.FileOutputStream(dest).use { out ->
                    output.compress(android.graphics.Bitmap.CompressFormat.JPEG, quality.coerceIn(1, 100), out)
                }
                val outW = output.width
                val outH = output.height
                output.recycle()

                promise.resolve(Arguments.createMap().apply {
                    putString("path", dest.absolutePath)
                    putInt("width", outW)
                    putInt("height", outH)
                })
            } catch (t: Throwable) {
                // Catch Throwable, not Exception — Bitmap allocations can throw OOM
                // (an Error, not an Exception); silently dropping that would leave
                // the JS promise hanging forever.
                Log.e(TAG, "resizeImage failed: ${t.message}")
                promise.rejectKit("RESIZE_ERROR", t)
            }
        }
    }

    /**
     * Write a solid-color JPEG of the requested size to the cache and return
     * the path. Replaces the JS-side BMP/base64 dance used by CameraScreen on
     * emulators with no camera.
     */
    @ReactMethod
    fun writeTestImage(width: Int, height: Int, promise: Promise) {
        scope.launch {
            try {
                require(width in 1..8192 && height in 1..8192) {
                    "dimensions out of range (got ${width}x${height})"
                }
                val color = android.graphics.Color.argb(
                    255,
                    (Math.random() * 256).toInt(),
                    (Math.random() * 256).toInt(),
                    (Math.random() * 256).toInt(),
                )
                val bmp = android.graphics.Bitmap.createBitmap(width, height, android.graphics.Bitmap.Config.ARGB_8888)
                bmp.eraseColor(color)
                val dest = java.io.File(reactApplicationContext.cacheDir, "test_${System.currentTimeMillis()}.jpg")
                java.io.FileOutputStream(dest).use { out ->
                    bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 85, out)
                }
                bmp.recycle()
                promise.resolve(Arguments.createMap().apply {
                    putString("path", dest.absolutePath)
                    putInt("width", width)
                    putInt("height", height)
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

    @Suppress("DEPRECATION")
    override fun onCatalystInstanceDestroy() {
        super.onCatalystInstanceDestroy()
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

    private fun friendToMap(f: FriendData, status: String): WritableMap =
        Arguments.createMap().apply {
            putString("userId", f.userId)
            putString("username", f.username)
            putString("status", status)
        }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Kit data surface.
    //
    // Drain the inbox, store application entries, and send application writes.
    // Payload data crosses as an opaque JSON string and is never re-encoded.
    // ─────────────────────────────────────────────────────────────────────────────────────────

    @ReactMethod
    fun inboxPeek(limit: Double, promise: Promise) {
        scope.launch {
            try {
                val rows = requireClient().inbox.peek(limit.toInt())
                val arr = Arguments.createArray()
                for (r in rows) arr.pushMap(inboxRowToMap(r))
                promise.resolve(arr)
            } catch (e: Exception) {
                promise.rejectKit("INBOX_PEEK_ERROR", e)
            }
        }
    }

    @ReactMethod
    fun inboxConsume(ids: ReadableArray, promise: Promise) {
        scope.launch {
            try {
                requireClient().inbox.consume(ids.toLongList())
                promise.resolve(null)
            } catch (e: Exception) {
                promise.rejectKit("INBOX_CONSUME_ERROR", e)
            }
        }
    }

    /** Permanent data loss; the kit logs `reason` as a security event, so it is required. */
    @ReactMethod
    fun inboxDiscard(ids: ReadableArray, reason: String, promise: Promise) {
        scope.launch {
            try {
                requireClient().inbox.discard(ids.toLongList(), reason)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.rejectKit("INBOX_DISCARD_ERROR", e)
            }
        }
    }

    @ReactMethod
    fun inboxDepth(promise: Promise) {
        scope.launch {
            try {
                promise.resolve(requireClient().inbox.depth().toDouble())
            } catch (e: Exception) {
                promise.rejectKit("INBOX_DEPTH_ERROR", e)
            }
        }
    }

    @ReactMethod
    fun entryPut(
        model: String,
        id: String,
        dataJson: String,
        sentAt: Double,
        authorDeviceId: String,
        localMetadataJson: String?,
        promise: Promise,
    ) {
        scope.launch {
            try {
                requireClient().entries.put(
                    model,
                    StoredEntry(
                        id = id,
                        data = dataJson,
                        sentAt = sentAt.toLong(),
                        authorDeviceId = authorDeviceId,
                        localMetadata = localMetadataJson,
                    )
                )
                promise.resolve(null)
            } catch (e: Exception) {
                promise.rejectKit("ENTRY_PUT_ERROR", e)
            }
        }
    }

    /** Securely remove local entries. The app decides when. */
    @ReactMethod
    fun entryErase(model: String, ids: ReadableArray, promise: Promise) {
        scope.launch {
            try {
                requireClient().entries.erase(model, ids.toStringList())
                promise.resolve(null)
            } catch (e: Exception) {
                promise.rejectKit("ENTRY_ERASE_ERROR", e)
            }
        }
    }

    /** The named entries that exist. */
    @ReactMethod
    fun entryGet(model: String, ids: ReadableArray, promise: Promise) {
        scope.launch {
            try {
                promise.resolve(entriesToArray(requireClient().entries.get(model, ids.toStringList())))
            } catch (e: Exception) {
                promise.rejectKit("ENTRY_GET_ERROR", e)
            }
        }
    }

    @ReactMethod
    fun entryAll(model: String, promise: Promise) {
        scope.launch {
            try {
                promise.resolve(entriesToArray(requireClient().entries.all(model)))
            } catch (e: Exception) {
                promise.rejectKit("ENTRY_ALL_ERROR", e)
            }
        }
    }

    private fun entriesToArray(entries: List<StoredEntry>): WritableArray =
        Arguments.createArray().apply {
            for (e in entries) pushMap(Arguments.createMap().apply {
                putString("id", e.id)
                putString("data", e.data)
                putDouble("sentAt", e.sentAt.toDouble())
                putString("authorDeviceId", e.authorDeviceId)
                putString("localMetadata", e.localMetadata)
            })
        }

    /** Per-device results: `{userId, deviceId, status, error}`, status `accepted|rejected|unknown`. */
    private fun sendReportToMap(report: SendReport): WritableMap {
        fun results(list: List<SubmissionResult>) = Arguments.createArray().apply {
            for (r in list) pushMap(Arguments.createMap().apply {
                putString("userId", r.userId)
                putString("deviceId", r.deviceId)
                putString("status", r.status.name.lowercase())
                putString("error", r.error)
            })
        }
        return Arguments.createMap().apply {
            putArray("recipients", results(report.recipients))
            putArray("selfSync", results(report.selfSync))
        }
    }

    /** The caller names recipients; the kit resolves no audience. */
    @ReactMethod
    fun sendEntry(
        recipientUserIds: ReadableArray,
        modelKey: String,
        entryId: String,
        sentAt: Double,
        payloadJson: String,
        promise: Promise,
    ) {
        scope.launch {
            try {
                val report = requireClient().send(
                    recipientUserIds = recipientUserIds.toStringList(),
                    modelKey = modelKey,
                    entryId = entryId,
                    sentAt = sentAt.toLong(),
                    payload = payloadJson.toByteArray(),
                    acceptedDeviceIds = emptySet(),
                )
                promise.resolve(sendReportToMap(report))
            } catch (e: Exception) {
                promise.rejectKit("SEND_ERROR", e)
            }
        }
    }

    /**
     * `payload` crosses as a UTF-8 string. For an unknown `kind` the decoding is lossy, which is safe
     * because the app discards such rows without reading the payload.
     */
    private fun inboxRowToMap(r: dev.barrelmaker.obscura.kit.stores.InboxRecord): WritableMap =
        Arguments.createMap().apply {
            putDouble("id", r.id.toDouble())
            putString("kind", r.kind)
            putString("senderUserId", r.senderUserId)
            putString("senderDeviceId", r.senderDeviceId)
            putString("modelKey", r.modelKey)
            putString("entryId", r.entryId)
            // Bound to a local first: `sentAt` is a nullable property from ANOTHER module, so
            // Kotlin refuses to smart-cast it — the kit could, in principle, change it between the
            // null check and the read.
            val sentAt = r.sentAt
            if (sentAt != null) putDouble("sentAt", sentAt.toDouble()) else putNull("sentAt")
            putString("payload", String(r.payload))
        }

    /**
     * Inbox ids are `Long`, and the RN bridge has no integer type — everything numeric arrives as a
     * double. That is exact up to 2^53, and these are per-install row counters, so the conversion is
     * safe for any inbox that could physically exist.
     */
    private fun ReadableArray.toLongList(): List<Long> =
        (0 until size()).map { getDouble(it).toLong() }

    private fun ReadableArray.toStringList(): List<String> =
        (0 until size()).mapNotNull { getString(it) }

    private fun jsonStringToMap(jsonStr: String): Map<String, Any?> {
        val map = mutableMapOf<String, Any?>()
        try {
            val json = JSONObject(jsonStr)
            for (key in json.keys()) {
                map[key] = when {
                    json.isNull(key) -> null
                    else -> {
                        val v = json.get(key)
                        when (v) {
                            is String -> v
                            is Number -> if (v.toDouble() == v.toLong().toDouble()) v.toLong() else v.toDouble()
                            is Boolean -> v
                            else -> v.toString()
                        }
                    }
                }
            }
        } catch (_: Exception) {}
        return map
    }
}
