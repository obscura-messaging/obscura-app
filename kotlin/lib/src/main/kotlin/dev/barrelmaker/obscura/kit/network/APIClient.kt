package dev.barrelmaker.obscura.kit.network

import dev.barrelmaker.obscura.kit.ObscuraError
import dev.barrelmaker.obscura.kit.managers.TokenStatus
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.ConnectionSpec
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * The REST API. Calls on this device's session use [token]; a missing token is
 * [ObscuraError.NotAuthenticated]. A 401 on such a call is checked with [refresh]: a rejected
 * refresh (which ends the session) is [ObscuraError.NotAuthenticated], a successful one retries the
 * request once.
 */
internal class APIClient(
    baseUrl: String,
    private val refresh: suspend () -> TokenStatus = { TokenStatus.UNAVAILABLE },
    private val token: () -> String?,
) {
    /** Who a request authenticates as. */
    private sealed interface Auth {
        data object None : Auth

        /** An explicit bearer token, such as a session being ended. */
        class Token(val value: String) : Auth

        data object Session : Auth
    }

    private val baseUrl = baseUrl.trimEnd('/')

    private val http = OkHttpClient.Builder()
        // ObscuraConfig allows http:// only for loopback.
        .connectionSpecs(
            if (baseUrl.startsWith("http://")) listOf(ConnectionSpec.MODERN_TLS, ConnectionSpec.CLEARTEXT)
            else listOf(ConnectionSpec.MODERN_TLS)
        )
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    /** Creates the account and provisions its primary device. */
    suspend fun registerUser(username: String, password: String, name: String, keys: DeviceKeys): AuthResponse = AuthResponse.from(
        json("POST", "/v1/users", keys.toJson().put("username", username).put("password", password).put("name", name), Auth.None)
    )

    /** Authenticates [deviceId] for [username]. */
    suspend fun login(username: String, password: String, deviceId: String): AuthResponse = AuthResponse.from(
        json("POST", "/v1/session", credentials(username, password).put("deviceId", deviceId), Auth.None)
    )

    /** Resets the account and provisions a new primary device. */
    suspend fun resetAccount(username: String, password: String, name: String, keys: DeviceKeys): AuthResponse = AuthResponse.from(
        json("POST", "/v1/users/reset", keys.toJson().put("username", username).put("password", password).put("name", name), Auth.None)
    )

    /** Provisions a linked device authorized by an approved [linkSessionId]. */
    suspend fun provisionDevice(name: String, keys: DeviceKeys, linkSessionId: String): AuthResponse = AuthResponse.from(
        json("POST", "/v1/devices", keys.toJson().put("name", name).put("linkSessionId", linkSessionId), Auth.None)
    )

    suspend fun refreshSession(refreshToken: String): AuthResponse = AuthResponse.from(
        json("POST", "/v1/session/refresh", JSONObject().put("refreshToken", refreshToken), Auth.None)
    )

    suspend fun logout(bearer: String) {
        send("DELETE", "/v1/session", null, Auth.Token(bearer))
    }

    suspend fun registerPushToken(pushToken: String) {
        send("PUT", "/v1/push-token", JSONObject().put("token", pushToken).body(), Auth.Session)
    }

    suspend fun uploadPreKeys(keys: PreKeyUpload) {
        send("POST", "/v1/keys", keys.toJson().body(), Auth.Session)
    }

    /** One bundle per device of [userId]; consumes a one-time prekey on each. */
    suspend fun fetchPreKeyBundles(userId: String): JSONArray =
        parse("/v1/keys") { JSONObject(String(send("GET", "/v1/keys/${enc(userId)}", null, Auth.Session))).getJSONArray("bundles") }

    /** The bundle of one device; consumes a one-time prekey on that device only. */
    suspend fun fetchPreKeyBundle(userId: String, deviceId: String): JSONObject = parse("/v1/keys") {
        JSONObject(String(send("GET", "/v1/keys/${enc(userId)}/devices/${enc(deviceId)}", null, Auth.Session)))
    }

    /** The account's devices on this device's session. */
    suspend fun fetchOwnDevices(): List<OwnDevice> = parse("/v1/devices") {
        val devices = JSONObject(String(send("GET", "/v1/devices", null, Auth.Session))).getJSONArray("devices")
        (0 until devices.length()).map { i ->
            val d = devices.getJSONObject(i)
            OwnDevice(d.getString("deviceId"), if (d.isNull("name")) null else d.getString("name"), d.optBoolean("isPrimary"))
        }
    }.also { list ->
        if (list.any { !isUuid(it.deviceId) } || list.map { it.deviceId }.distinct().size != list.size || list.count { it.isPrimary } > 1) {
            throw ObscuraError.ProtocolViolation("Invalid device list")
        }
    }

    suspend fun deleteDevice(deviceId: String) {
        send("DELETE", "/v1/devices/${enc(deviceId)}", null, Auth.Session)
    }

    suspend fun createLinkSession(username: String, password: String): LinkSession =
        json("POST", "/v1/link-sessions", credentials(username, password), Auth.None).let {
            val id = it.optString("id")
            val userId = it.optString("userId")
            val expiresAt = it.optLong("expiresAt")
            if (id.isBlank() || !isUuid(userId) || expiresAt <= 0) throw ObscuraError.ProtocolViolation("Invalid link session")
            LinkSession(id, userId, expiresAt)
        }

    suspend fun approveLinkSession(id: String, body: ByteArray) {
        send("PUT", "/v1/link-sessions/${enc(id)}", body.toRequestBody(OCTET), Auth.Session)
    }

    /** The approved body, or null when the session is not approved yet. */
    suspend fun awaitLinkSession(id: String): ByteArray? {
        val (status, bytes) = exchange("GET", "/v1/link-sessions/${enc(id)}", null, Auth.None)
        return if (status == 204) null else bytes
    }

    /** A fresh idempotency key per call; [send]'s own 429/503 retries reuse it. */
    suspend fun sendMessage(protobuf: ByteArray): ByteArray = send(
        "POST", "/v1/messages", protobuf.toRequestBody(PROTOBUF), Auth.Session,
        "Idempotency-Key" to UUID.randomUUID().toString(),
    )

    suspend fun uploadAttachment(blob: ByteArray): String =
        JSONObject(String(send("POST", "/v1/attachments", blob.toRequestBody(OCTET), Auth.Session))).getString("id")

    suspend fun fetchAttachment(id: String): ByteArray = send("GET", "/v1/attachments/${enc(id)}", null, Auth.Session)

    suspend fun fetchGatewayTicket(): String = json("POST", "/v1/gateway/ticket", JSONObject(), Auth.Session).getString("ticket")

    fun gatewayUrl(ticket: String): String =
        baseUrl.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") + "/v1/gateway?ticket=${enc(ticket)}"

    private suspend fun json(method: String, path: String, body: JSONObject, auth: Auth): JSONObject =
        parse(path) { JSONObject(String(send(method, path, body.body(), auth))) }

    private inline fun <T> parse(path: String, block: () -> T): T = try {
        block()
    } catch (e: org.json.JSONException) {
        throw ObscuraError.ProtocolViolation("Invalid JSON response for $path", e)
    }

    private fun credentials(username: String, password: String) = JSONObject().put("username", username).put("password", password)

    private suspend fun send(
        method: String,
        path: String,
        body: RequestBody?,
        auth: Auth,
        vararg headers: Pair<String, String>,
    ): ByteArray = exchange(method, path, body, auth, *headers).second

    /** Retries 429 and 503 after `Retry-After`; any other non-2xx is [ObscuraError.Http]. */
    private suspend fun exchange(
        method: String,
        path: String,
        body: RequestBody?,
        auth: Auth,
        vararg headers: Pair<String, String>,
    ): Pair<Int, ByteArray> {
        var retries = 0
        var refreshed = false
        while (true) {
            val bearer = when (auth) {
                Auth.None -> null
                is Auth.Token -> auth.value
                Auth.Session -> token() ?: throw ObscuraError.NotAuthenticated()
            }
            val request = Request.Builder().url("$baseUrl$path").method(method, body).apply {
                if (bearer != null) header("Authorization", "Bearer $bearer")
                headers.forEach { (name, value) -> header(name, value) }
            }.build()
            val (status, bytes, retryAfter) = execute(http, request)
            if (status in 200..299) return status to bytes
            if (status == 401 && auth == Auth.Session && !refreshed) {
                refreshed = true
                when (refresh()) {
                    TokenStatus.REJECTED -> throw ObscuraError.NotAuthenticated()
                    TokenStatus.FRESH -> continue
                    TokenStatus.UNAVAILABLE -> Unit
                }
            }
            if (status !in RETRYABLE || retries == MAX_RETRIES) throw ObscuraError.Http(status, String(bytes))
            retries++
            delay(retryAfterMs(retryAfter))
        }
    }

    /** Cancelling the calling coroutine cancels the call, which closes its connection. */
    private suspend fun execute(client: OkHttpClient, request: Request): Triple<Int, ByteArray, String?> =
        suspendCancellableCoroutine { continuation ->
            val call = client.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) = continuation.resumeWithException(e)

                override fun onResponse(call: Call, response: Response) {
                    val result = try {
                        response.use { Triple(it.code, it.body.bytes(), it.header("Retry-After")) }
                    } catch (e: IOException) {
                        return continuation.resumeWithException(e)
                    }
                    continuation.resume(result)
                }
            })
        }

    private fun JSONObject.body() = toString().toRequestBody(JSON)

    private fun enc(value: String): String = URLEncoder.encode(value, "UTF-8")

    companion object {
        private val JSON = "application/json".toMediaType()
        private val PROTOBUF = "application/x-protobuf".toMediaType()
        private val OCTET = "application/octet-stream".toMediaType()
        private val RETRYABLE = setOf(429, 503)
        private const val MAX_RETRIES = 2

        /** `Retry-After` seconds clamped to [1, 10]; the server sends 0 for a sub-second wait. */
        fun retryAfterMs(header: String?): Long = (header?.trim()?.toLongOrNull() ?: 1L).coerceIn(1L, 10L) * 1000
    }
}
