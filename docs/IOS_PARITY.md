# iOS status

iOS runs the same TypeScript app and [bridge contract](BRIDGE.md) as Android.
It is not production-ready.

## Working

- Every bridge method and event, except the push and notification-tap paths
  below. Sessions persist in the Keychain.
- Foreground interoperability with Android on physical devices: auth restore,
  friends, entries, typing, attachments, pix, offline queues,
  cold starts and reconnects.
- Internal TestFlight builds ([`IOS_DISTRIBUTION.md`](IOS_DISTRIBUTION.md)),
  smoke-tested for launch, login and foreground messaging.

## Push delivery

Push delivery is not wired. `requestPushPermission` registers for remote
notifications, but nothing past that point exists. The remaining work:

1. Add the Firebase Messaging and Firebase Core dependencies.
2. Add the APNs entitlement and provision a real device.
3. Set up `FirebaseApp` and `MessagingDelegate`.
4. Forward the APNs token to FCM, and the FCM token to JS as
   `pushTokenReceived`.
5. On a silent wake, restore the session and drain pending messages.
6. Post generic local notifications, only while the app is backgrounded.
7. Route notification taps through `getLaunchIntent` (by setting
   `ObscuraBridge.pendingLaunchScreen`) and `launchedFrom` (by calling
   `ObscuraBridge.deliverLaunchedFrom`).

The rules are in [`PUSH_NOTIFICATIONS.md`](PUSH_NOTIFICATIONS.md). Push cannot
be validated on the simulator.

## Other gaps

- The Swift kit cannot receive device-link approval, so a new iOS device cannot
  be linked. See Known gaps in
  [`KIT_API.md`](https://github.com/obscura-messaging/obscura-native/blob/be2b96538647164c9ba60675f3836b063b4fcf80/docs/KIT_API.md#known-gaps).
- Background and foreground transitions are not tested automatically on a
  device.
