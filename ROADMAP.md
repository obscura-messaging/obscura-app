# Roadmap

## Done

- Auth: register, login and session restore. A `deviceMismatch` login wipes
  the device and re-provisions it.
- Friends: codes, QR scan, requests and acceptance.
- Encrypted 1:1 chat with typing indicators.
- Stories (post and feed). They are erased 24 hours after posting.
- Profiles: display name and bio, synced to friends.
- Encrypted photo and video attachments.
- Camera capture, preview, captions and a recipient picker for pix.
- View-once pix with a display timer and opened status.
- Disappearing messages and pix. They are erased on every device 15 minutes
  after the recipient sees them, or 30 days after sending if never seen.
- Screen capture blocked on Android and iOS.
- Android push: silent FCM wakes, generic local notifications, and a chat-list
  destination on tap.
- In-app debug log on the Profile tab.

## Gaps

- iOS push and production readiness ([`IOS_PARITY.md`](docs/IOS_PARITY.md)).

## Next

- **Pix:** a sender-chosen 1x or 2x view.
- **Chat:** inline photos and voice notes.
- **Stories:** several snaps per story, view counts and viewers, replies that
  open a chat, and close-friends audiences.
- **Streaks:** a daily exchange counter per friend, a fire-and-count display, an
  expiry warning, and push reminders.

## Not planned

Device linking or history/key transfer, AR lenses, drawing on photos, video calls, maps or location, saved memories,
Bitmoji, snap score, chat wallpapers.
