# Notification Service Extension prerequisites

No NSE exists, and iOS push is not active. The server sends a content-free
background notification (`content-available: 1`), which cannot launch an NSE.
`obscura-app` does not yet forward the APNs token or handle the background
wake.

## Already in place (unverified on device)

- `obscura-app` `SharedContainer` prefers the App Group container for the
  SQLCipher database and falls back, with a log line, to private storage.
- `ObscuraClient(apiURL:dataDirectory:userId:keychainAccessGroup:deviceName:sessionStorage:logger:)`
  stores the database key in a shared keychain group.
- `obscura-app` `KeychainSession` stores the access and refresh tokens,
  `expiresAt`, user ID, device ID and username in that group.

## To enable push with the app's background handler

1. Enable Push Notifications and Background Modes → Remote notifications.
2. Forward the APNs token through `pushTokenReceived` to `registerPushToken`.
3. On the wake, restore the shared session and connect within the host's
   background execution budget. Drain the durable inbox and let the host
   determine notification policy and copy.

## To add an NSE

1. Replace the background payload with a privacy-reviewed NSE-compatible one
   (server change).
2. Add the NSE target with the same App Group entitlement and provisioning.
3. Migrate existing private-container databases and keychain items, or require
   a wipe when shared storage first becomes available.
4. Support concurrent database access from two processes (WAL, pooling).
5. Ensure only one process drains the gateway at a time.
6. In the NSE: restore the shared session, connect within the extension budget, set
   generic copy on the incoming notification, and complete it through the
   content handler. Do not post a second notification.

Before calling it supported, verify on physical hardware: App Group
provisioning, keychain access while locked, token refresh, database
concurrency and delivery.
