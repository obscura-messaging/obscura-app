# Obscura bridge rationale

[`src/native/ObscuraModule.ts`](../src/native/ObscuraModule.ts) and
[`src/native/__tests__/exports.test.ts`](../src/native/__tests__/exports.test.ts)
are the executable authority on bridge signatures, error codes, and event
shapes across TypeScript, Kotlin, Swift, and Objective-C. Kit semantics live in
[`KIT_API.md`][kit]. This document records only **why** the bridge boundary is
constrained as it is.

## Why these boundary rules exist

- **Paths, never bytes:** Passing media as base64 across the React Native bridge
  multiplies peak memory and stalls the JS thread on multi-megabyte videos.
  Files cross only as absolute filesystem paths, and decrypted attachments are
  written atomically (`.tmp` then rename) to a sanitized cache path so partial
  downloads are never read.
- **Bounded native image decoding:** Camera photos can exceed 4000×3000 px.
  Resizing runs natively with bounded sampling (`inSampleSize` on Android,
  ImageIO thumbnailing on iOS) and EXIF orientation applied so JS never
  allocates uncompressed full-sensor bitmaps.
- **Link secrets stay native:** During device linking, `LinkRequest` holds an
  ephemeral private key. Keeping the pending request inside the native bridge
  slot and exposing only the display string to JS prevents ephemeral key
  material from crossing into the JS heap.
- **Process-scoped session vs. bridge lifecycle:** React Native can reload or
  recreate bridge modules while the process stays alive, and Android FCM wakes
  can run before JS mounts. `ObscuraSession` owns the kit client and its
  single-consumer `messageReceived` stream at the process level so bridge
  recreation never drops the stream or races cold-start session restoration.
- **Wake-ups vs. delivery:** Bridge events (`messageReceived`, `friendsChanged`)
  are lossy wake-ups—for example, events emitted on iOS before JS attaches a
  listener are dropped, and background push drains run without JS. That is why
  the durable inbox and entry store are the source of truth, and why the app
  always drains and sweeps on cold start, reconnect, and foreground transition.

[kit]: KIT_API.md
