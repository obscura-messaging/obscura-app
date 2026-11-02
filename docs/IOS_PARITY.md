# iOS status

iOS runs the same TypeScript application and bridge surface as Android for
internal TestFlight testing ([`IOS_DISTRIBUTION.md`](IOS_DISTRIBUTION.md)), but
it is not a production release target because APNs/FCM background push delivery
and notification-tap routing are not yet wired on iOS
([`PUSH_NOTIFICATIONS.md`](PUSH_NOTIFICATIONS.md)). Simulator builds also cannot
exercise APNs or device signing.
