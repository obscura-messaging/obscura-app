# iOS distribution (`dev` and `prod`)

The release workflows (`release-dev.yml` and `release-prod.yml`) start this one
after the same verification ([`ANDROID_DISTRIBUTION.md`](ANDROID_DISTRIBUTION.md)).
`.github/workflows/distribute-ios.yml` archives the commit once for device and
exports a signed IPA. It keeps the IPA and dSYMs as a GitHub artifact for 30
days. A second job verifies the IPA and uploads it to App Store Connect for
TestFlight. The marketing
version comes from `package.json` (`1.0.0`), and the build number is 1010 plus
the release run number. An
uploaded build cannot be replaced under the same version and build, so retry the
failed jobs or start a new run.

| Environment | App Name | Bundle ID | App Group | Server | GitHub Environment |
| --- | --- | --- | --- | --- | --- |
| `dev` | **Obscura Dev** | `dev.barrelmaker.obscura.dev` | `group.dev.barrelmaker.obscura.dev` | `https://devscura.barrelmaker.dev` | `ios-dev` |
| `prod` | **Obscura** | `dev.barrelmaker.obscura` | `group.dev.barrelmaker.obscura` | `https://obscura.barrelmaker.dev` | `ios-prod` |

## TestFlight

- Testers can install a build only after Apple finishes processing it. Assign
  it to an internal TestFlight group, or enable automatic distribution for the
  group. Internal testers must be App Store Connect users.
- `dev` builds (`dev.barrelmaker.obscura.dev`) set
  `testFlightInternalTestingOnly: true` in `ios/Config/Dev-ExportOptions.plist` so a
  `devscura` build can never be submitted to external review or the public App
  Store. `prod` builds (`dev.barrelmaker.obscura`) set
  `testFlightInternalTestingOnly: false` in `Prod-ExportOptions.plist` so a tested release candidate can be
  promoted to the App Store. Builds expire after 90 days.
- **Export compliance.** For the first build, the Account Holder completed
  Apple's questionnaire, and App Store Connect recorded
  `usesNonExemptEncryption: false`. `ITSAppUsesNonExemptEncryption = NO` in
  `Info.plist` carries that answer forward. Revisit it if the app's encryption
  or the rules change. The pipeline must never guess an exemption.

## Apple signing

`dev` builds use bundle ID `dev.barrelmaker.obscura.dev` and App Group
`group.dev.barrelmaker.obscura.dev`; `prod` builds use `dev.barrelmaker.obscura`
and `group.dev.barrelmaker.obscura`, under team `KY4LCG34B8`. Release builds
use an Apple Distribution certificate with an App Store provisioning profile.
Development certificates cannot upload to TestFlight.

- Back up the distribution identity, encrypted, outside GitHub. Keep its export
  password in a password manager.
- Renew the certificate and profiles before they expire.
- The App Store Connect API key authenticates uploads but signs nothing. Keep
  it separate from the identity.
- Never commit a private key or a profile.

With the identity and profile installed, `just ios-archive` builds a signed
device archive. It prepares the libsignal **device** FFI, whereas
`just ios-build` prepares the simulator FFI.

## GitHub `ios-dev` and `ios-prod` environments

Deployments are allowed only from `main` and require approval from the
`obscura-maintainers` team.

| Variable | Value |
| --- | --- |
| `APPLE_TEAM_ID` | Signing team ID (`KY4LCG34B8`) |
| `APP_STORE_CONNECT_KEY_ID` | Upload API key ID |
| `APP_STORE_CONNECT_ISSUER_ID` | Upload API issuer ID |

| Secret | Value |
| --- | --- |
| `IOS_DISTRIBUTION_P12_BASE64` | Base64 of the password-protected Apple Distribution identity |
| `IOS_DISTRIBUTION_PASSWORD` | Its export password |
| `IOS_PROVISIONING_PROFILE_BASE64` | Base64 of the environment's App Store distribution profile (`Obscura Dev App Store` or `Obscura App Store`) |
| `APP_STORE_CONNECT_API_KEY_P8` | Upload API private key |

The build job loads the identity into a temporary keychain. It checks the
profile's team, bundle ID and App Group, and the exported IPA's bundle ID,
version and build. The upload job gets only the artifact, its checksum and the
API key. These builds run in the foreground only against the live server; push
is not implemented ([`IOS_PARITY.md`](IOS_PARITY.md)).
