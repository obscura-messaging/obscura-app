# iOS status

iOS ships the same TypeScript application and bridge surface as Android
([`IOS_DISTRIBUTION.md`](IOS_DISTRIBUTION.md)). Its one gap is push.

The bridge asks for notification permission and registers for remote
notifications, but the APNs device token is never delivered to
`pushTokenReceived`, so the server has no iOS token to wake. Without it there is
no background delivery and no notification-tap routing: messages arrive when the
app is opened and reconnects, which the cold-start and foreground sync already
cover ([`BRIDGE.md`](BRIDGE.md)). Push privacy rules are in
[`PUSH_NOTIFICATIONS.md`](PUSH_NOTIFICATIONS.md).

Simulator builds cannot exercise APNs or device signing.
