# ObscuraKit (Kotlin)

Kotlin/JVM kit for the Android bridge. Shared behavior is defined in
[`docs/KIT_API.md`](../docs/KIT_API.md); this file covers Kotlin integration.

## Build and test

From `kotlin/`, with JDK 21:

```bash
../scripts/run-with-java-21.sh ./gradlew :lib:test :lib:koverVerify :lib:publishToMavenLocal --no-daemon
../scripts/run-with-java-21.sh ./gradlew :lib:koverHtmlReport :lib:koverXmlReport --no-daemon
OBSCURA_TEST_API=https://devscura.barrelmaker.dev \
  ../scripts/run-with-java-21.sh ./gradlew :lib:integrationTest --no-daemon
```

- Published as `dev.barrelmaker.obscura.kit:obscura-kit:0.1.0`.
- Kotlin follows the Android app's React Native compiler version
  (`gradle/libs.versions.toml`).
- Unit coverage floors are 48% lines and 40% instructions. Reports are under
  `lib/build/reports/kover/`. Integration is excluded unless
  `-Pkover.includeIntegration=true`.
- Integration defaults to `http://localhost:3000` and skips when
  `<api>/openapi.yaml` is unreachable. Check executed/skipped counts in
  `lib/build/test-results/integrationTest/`. Server setup:
  [`CONTRIBUTING.md`](../CONTRIBUTING.md#integration-tests).

## Construction

```kotlin
val client = ObscuraClient(
    config = ObscuraConfig(
        apiUrl = "https://obscura.barrelmaker.dev",
        deviceName = "Android",
        databasePath = "obscura.db",
    ),
    driver = null,
    sessionStorage = platformSessionStorage,
)
client.logger = platformLogger
```

All constructor parameters are required. `driver` may be null; then the kit
opens the configured database and creates its schema (`databasePath = null`
uses an in-memory database). An app-supplied `SqlDriver` must already have
`ObscuraDatabase.Schema` and cannot be combined with a database path.

Implement `SessionStorage.save(Map<String, String>)`, `load(): Map<String, String>?`,
and `clear()` using platform-secure storage. Save replaces the entire map;
there is no no-op fallback. Storage exceptions surface as `StorageFailed`
with the original exception as `cause`; `restorePersistedSession()` logs
failures and returns false. `logger` remains replaceable after construction.

## Kotlin surface

```kotlin
client.register(username, password)          // this device becomes the primary
when (client.login(username, password)) {
    LoginScenario.EXISTING_DEVICE -> client.connect()
    LoginScenario.LINK_REQUIRED -> {
        val request = client.beginLink(username, password, deviceName)
        showQrCode(request.code)                // the primary calls approveLink(code)
        client.completeLink(request)            // suspends until approved; connects
    }
    LoginScenario.DEVICE_MISMATCH -> client.wipeDevice() // then log in again
    LoginScenario.INVALID_CREDENTIALS -> showLoginError()
}
client.approveLink(code)        // primary only
client.devices()                // List<DeviceInfo>
client.unlinkDevice(deviceId)
client.isPrimary()              // Boolean
client.resetAccount(username, password) // resets account and provisions this device as primary
client.restorePersistedSession() // Boolean
client.connect()                // suspends until open
client.disconnect()             // non-suspending
client.logout()
client.wipeDevice()

val report = client.send(
    recipientUserIds, modelKey, entryId, sentAt, payload,
)
client.inbox.peek(50)
client.inbox.consume(ids)
client.inbox.discard(ids, reason)
client.inbox.depth()
client.entries.put(modelKey, StoredEntry(id, data, sentAt, authorUserId, authorDeviceId, localMetadata))
client.entries.get(modelKey, ids)
client.entries.all(modelKey)
client.entries.erase(modelKey, ids)
client.uploadAttachment(bytes)
client.downloadDecryptedAttachment(id, contentKey, nonce)
client.friendCode()
client.addFriendByCode(code)
client.acceptFriend(userId)
client.removeFriend(userId)
client.sendTyping(recipientUserIds, contextId, TypingState.STARTED)
client.observeTyping(contextId).collect { renderTyping(it) }
client.processPendingMessages(timeoutMs)
```

Unless noted otherwise, client/store operations above are suspending
(`friendCode` and `observeTyping` are not). `payload` is `ByteArray`;
stored entry `data` and nullable `localMetadata` are opaque strings.
`SendReport` separates `recipients` and `selfSync`, each containing
`SubmissionResult` values.

`authState` and `connectionState` are `StateFlow`s. `friendsChanged` is a
payload-free `Flow<Unit>`; collect it and call `getFriends()`. `messageReceived`
is a one-consumer `ReceiveChannel<String>` of model keys; read durable rows
from the inbox. `getDebugLog()` returns recent log lines.

The purposeful error subclasses of `ObscuraError` are `NotAuthenticated`,
`InvalidArgument`, `InvalidFriendCode`, `Http`, `ConnectionFailed`,
`SendFailed`, `ProtocolViolation`, `StorageFailed`, `NotPrimary`, and
`LinkFailed`. Use `code` for bridge mapping, rather than matching exception
messages.

## Code map and testing

| Path under `lib/src/main/kotlin/dev/barrelmaker/obscura/kit/` | Role |
|---|---|
| `ObscuraClient.kt` | Facade, receive path and push drain |
| `managers/AuthManager.kt` | Credentials, secure storage and refresh lifecycle |
| `managers/MessageSender.kt` | Serialized per-user complete-delivery fanout and session bootstrap |
| `network/` | REST and gateway; gateway owns reconnection |
| `messaging/Messenger.kt` | Confined Signal operations; HTTP runs outside confinement |
| `stores/` | SQLDelight-backed inbox, entries, friends and device directory |
| `wire/` | Wire mappings, disposition and typing |
| `crypto/` | Signal persistence, attachment and link encryption, UUID encoding |

- Use `runBlocking`, not virtual-time `runTest`, for real HTTP/WebSocket I/O.
- JUnit 5 test methods must return `Unit`; an expression ending with a
  non-Unit operation needs a trailing `Unit`.
- Integration tests drive the facade. Raw encrypted input is reserved for
  adversarial receive tests.
- `okio.ByteString` is used for WebSockets; protobuf uses
  `com.google.protobuf.ByteString`.
