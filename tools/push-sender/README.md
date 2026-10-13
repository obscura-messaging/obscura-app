# push-sender

A command-line Obscura user for testing push end to end. It sends real
encrypted `directMessage` entries to your account, exercising the path from
server to FCM to device.

## Build

```bash
just push-sender-build   # from the repo root; requires JDK 21
alias push-sender="$PWD/tools/push-sender/build/install/push-sender/bin/push-sender"
```

The sender's identity and Signal database live in
`~/.cache/obscura-push-tester/`. Delete that directory to start over. The tool
targets `OBSCURA_API_URL`, which defaults to `https://obscura.barrelmaker.dev`.

## Test a background wake on Android

1. Install a build with the real Firebase config, log in, and grant
   notifications. See [`PUSH_NOTIFICATIONS.md`](../../docs/PUSH_NOTIFICATIONS.md#android).
2. Create a sender and send it a friend request:

   ```bash
   push-sender init
   echo '<your friend code>' | base64 -d   # gives {"u":"<userId>","n":"<username>"}
   push-sender befriend <userId> <username>
   ```

   `befriend` takes your raw user ID, not the app's friend code.
3. Accept the request in the app.
4. Press Home or swipe the app out of recents. Do not force-stop it: Android
   withholds FCM from a force-stopped app until it is opened again.
5. Run `push-sender send <username> "hello"` or
   `push-sender ping <username> [count]`. Each send prints every target
   device's outcome and exits non-zero when none accepted. `accepted` means
   the server queued it, not that it was delivered.
6. Check for a generic `New message` notification. Follow
   `adb logcat -s ObscuraSession ObscuraMessagingService ObscuraBridge`.
   `NotificationHelper` logs as `ObscuraBridge`. `./logcat.sh` (`-c` clears,
   `--dump` prints once) omits `ObscuraSession`.

Other commands: `whoami`, `accept-pending` and `friends`. Run the tool with no
arguments for usage.

## Notes

- **Kit build.** The kit is a Gradle composite build of the pinned
  `obscura-native/kotlin`, so there is no publish step. `OBSCURA_KIT_PATH`
  points it at another checkout. The `dependencySubstitution` in
  `settings.gradle.kts` must stay. The kit sets its `groupId` only inside its
  `publishing` block, so a bare `includeBuild` silently resolves `mavenLocal`
  instead.
- **Payload.** Messages are `{ conversationId, content }`, matching
  `directMessage` in `src/models/schema.ts`. `conversationId` must be the
  canonical sorted form, or the app discards the entry. `_authorUserId` is never
  sent.
- **Expiry.** Received messages disappear like any other `directMessage`.
