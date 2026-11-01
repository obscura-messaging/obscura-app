# iOS internal distribution

The Android release workflow also starts this one, after the same verification
([`ANDROID_DISTRIBUTION.md`](ANDROID_DISTRIBUTION.md)).
`.github/workflows/internal-ios.yml` archives the commit once for device and
exports a signed IPA. It keeps the IPA and dSYMs as a GitHub artifact for 30
days. A second job verifies the IPA and uploads it to App Store Connect for
internal TestFlight. There is no tag and no store release. The marketing
version is `1.0`, and the build number is 1000 plus the release run number. An
uploaded build cannot be replaced under the same version and build, so retry the
failed jobs or start a new run. A store release will need its own versioning
and promotion flow.

## TestFlight

- Testers can install a build only after Apple finishes processing it. Assign
  it to an internal TestFlight group, or enable automatic distribution for the
  group. Internal testers must be App Store Connect users.
- Internal builds target the `dev` environment (`dev.barrelmaker.obscura.dev`,
  display name **Obscura Dev**, pointing at `https://devscura.barrelmaker.dev`),
  and `ios/ExportOptions-TestFlight.plist` sets
  `testFlightInternalTestingOnly: true` so a `devscura` build cannot be
  submitted to external review or the public App Store. Builds expire after 90
  days.
- **Export compliance.** For the first build, the Account Holder completed
  Apple's questionnaire, and App Store Connect recorded
  `usesNonExemptEncryption: false`. `ITSAppUsesNonExemptEncryption = NO` in
  `Info.plist` carries that answer forward. Revisit it if the app's encryption
  or the rules change. The pipeline must never guess an exemption.

## Apple signing

Internal builds use bundle ID `dev.barrelmaker.obscura.dev` and App Group
`group.dev.barrelmaker.obscura.dev` (production uses `dev.barrelmaker.obscura`
and `group.dev.barrelmaker.obscura`), under team `KY4LCG34B8`. Release builds
use an Apple Distribution certificate with an App Store provisioning profile.
Development certificates cannot upload to TestFlight.

- Back up the distribution identity, encrypted, outside GitHub. Keep its export
  password in a password manager.
- Renew the certificate and profile before they expire.
- The App Store Connect API key authenticates uploads but signs nothing. Keep
  it separate from the identity.
- Never commit a private key or a profile.

With the identity and profile installed, `just ios-archive` builds a signed
device archive. It prepares the libsignal **device** FFI, whereas
`just ios-build` prepares the simulator FFI.

## GitHub `ios-testflight` environment

Deployments are allowed only from `main`.

| Variable | Value |
| --- | --- |
| `APPLE_TEAM_ID` | Signing team ID |
| `APPLE_BUNDLE_ID` | App bundle identifier |
| `APP_STORE_CONNECT_KEY_ID` | Upload API key ID |
| `APP_STORE_CONNECT_ISSUER_ID` | Upload API issuer ID |

| Secret | Value |
| --- | --- |
| `IOS_DISTRIBUTION_P12_BASE64` | Base64 of the password-protected Apple Distribution identity |
| `IOS_DISTRIBUTION_PASSWORD` | Its export password |
| `IOS_PROVISIONING_PROFILE_BASE64` | Base64 of the App Store distribution profile |
| `APP_STORE_CONNECT_API_KEY_P8` | Upload API private key |

The archive job loads the identity into a temporary keychain. It checks the
profile's team, bundle ID and App Group, and the exported IPA's bundle ID,
version and build. The upload job gets only the artifact, its checksum and the
API key. These builds run in the foreground only against the live server; push
is not implemented ([`IOS_PARITY.md`](IOS_PARITY.md)).
