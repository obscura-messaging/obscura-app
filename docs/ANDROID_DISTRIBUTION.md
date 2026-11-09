# Android distribution (`dev` and `prod`)

PR and `main` CI never distribute, and PRs never see distribution credentials
(they use the Firebase stub and debug signing). To ship, an owner
(`barrelmaker97` or `rhelsing`) runs `just release-dev` (**Actions → Release
Dev**) or `just release-prod` (**Actions → Release Prod**) on `main`.
`scripts/verify-release-build.sh` checks the starting and rerunning actor,
requires the commit to be the current `main` tip with a successful `main` CI
run, and reads the `X.Y.Z` version from `package.json`. Android and iOS then run
independently via `.github/workflows/distribute-android.yml` and
`.github/workflows/distribute-ios.yml`.

| Environment | App Name | Package Name | Server | GitHub Environment |
| --- | --- | --- | --- | --- |
| `dev` | **Obscura Dev** | `dev.barrelmaker.obscura.dev` | `https://devscura.barrelmaker.dev` | `android-dev` |
| `prod` | **Obscura** | `dev.barrelmaker.obscura` | `https://obscura.barrelmaker.dev` | `android-prod` (requires review) |

`.github/workflows/distribute-android.yml` builds that commit once as a signed,
minified Android App Bundle (`.aab`). It keeps the `.aab` and release notes as
a GitHub artifact for 30 days. A second job verifies the bundle's checksum and
commit, then uploads it to the app's Google Play Console **Internal testing**
track (`Obscura Dev` stays permanently on Internal testing; `Obscura` can be
promoted from Internal testing to Production in Play Console). The version name
comes from `package.json` (`1.0.0`), and the version code is 1010 plus the
release run number. Never rerun a release that has already uploaded; retry the
failed jobs or start a new run.

## Google Play Console & Firebase (FCM)

1. **Google Play Console:** Create separate app entries for
   `dev.barrelmaker.obscura.dev` (**Obscura Dev**) and `dev.barrelmaker.obscura`
   (**Obscura**). Upload the first `.aab` for each app once manually to
   initialize it in Play Console, add testers to the **Internal testing** track,
   and grant your Google Cloud Workload Identity service account **View app
   information** and **Release to testing tracks** permission under **Users and
   permissions** (scoped per app when using separate `dev` and `prod` service
   accounts).
2. **Firebase (FCM push only):** Register `dev.barrelmaker.obscura.dev` and
   `dev.barrelmaker.obscura` in Firebase so each environment's
   `google-services.json` contains its package name. For local push testing,
   place the real config at `android/app/google-services.json`
   ([CONTRIBUTING](../CONTRIBUTING.md#setup-and-builds)).

## Signing keys

Keep separate upload keys for `dev` (`android-dev.p12`) and `prod`
(`android-prod.p12`), backed up encrypted outside the repository. PKCS12 uses
the same password for the store and the key.

```bash
mkdir -p ~/.config/obscura
keytool -genkeypair -v \
  -keystore ~/.config/obscura/android-dev.p12 \
  -storetype PKCS12 \
  -alias obscura-release \
  -keyalg RSA -keysize 4096 -validity 10000
```

For a local signed bundle, create the gitignored `android/keystore.properties`.
The matching `ANDROID_RELEASE_STORE_FILE`, `ANDROID_RELEASE_STORE_PASSWORD`,
`ANDROID_RELEASE_KEY_ALIAS` and `ANDROID_RELEASE_KEY_PASSWORD` environment
variables override it. Then run `just android-bundle 1 1.0.0 dev` (or `prod`).
Unlike `just android-build`, it fails if signing, version metadata or the real
Firebase config is missing.

```properties
storeFile=/absolute/path/to/android-dev.p12
storePassword=...
keyAlias=obscura-release
keyPassword=...
```

## GitHub `android-dev` and `android-prod` environments

Deployments are allowed only from `main`, and `android-prod` requires reviewer
approval.

| Variable | Value |
| --- | --- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Full workload identity provider resource name |
| `GCP_SERVICE_ACCOUNT` | Distribution service-account email (granted Play Console access) |

| Secret | Value |
| --- | --- |
| `GOOGLE_SERVICES_JSON_BASE64` | Base64 of the environment's `google-services.json` |
| `ANDROID_RELEASE_KEYSTORE_BASE64` | Base64 of the environment's PKCS12 upload key (`android-dev.p12` or `android-prod.p12`) |
| `ANDROID_RELEASE_STORE_PASSWORD` | PKCS12 password |
| `ANDROID_RELEASE_KEY_ALIAS` | Normally `obscura-release` |

Before building, the build job checks that `google-services.json` includes the
environment's package name. It writes credentials only to runner-temporary or
gitignored paths. The delivery job receives only the `.aab` and the release
notes, authenticates to Google Cloud via OIDC after verifying them, and commits
the bundle to the `internal` track via the Google Play Android Developer API.

## Google authentication

Use GitHub OIDC with Google Workload Identity Federation. Never create a
service-account JSON key.

1. Restrict the provider to `obscura-messaging/obscura-app`. Its attribute
   condition must also pin the calling and reusable workflows; a
   repository-only condition is too broad:

   ```text
   assertion.repository == 'obscura-messaging/obscura-app' &&
   assertion.ref == 'refs/heads/main' &&
   assertion.event_name == 'workflow_dispatch' &&
   (assertion.workflow_ref == 'obscura-messaging/obscura-app/.github/workflows/release-dev.yml@refs/heads/main' ||
    assertion.workflow_ref == 'obscura-messaging/obscura-app/.github/workflows/release-prod.yml@refs/heads/main') &&
   assertion.job_workflow_ref == 'obscura-messaging/obscura-app/.github/workflows/distribute-android.yml@refs/heads/main'
   ```

2. Map `attribute.repository` to `assertion.repository`, and grant the
   `principalSet://iam.googleapis.com/projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/<POOL_ID>/attribute.repository/obscura-messaging/obscura-app`
   principal `roles/iam.workloadIdentityUser` on the service account.
3. Enable `androidpublisher.googleapis.com` in the Google Cloud project and
   grant that service account **View app information** and **Release to testing
   tracks** in Google Play Console (**Users and permissions**).

On a repository rename, update both the provider condition and the
service-account principal; GitHub redirects do not apply to OIDC claims.
The provider resource ID is independent of the repository name and can stay
unchanged. Keep workflow paths pinned even when using immutable subject claims.

## Installing

Testers join once via the **Internal testing** opt-in link in Google Play
Console (**Testing → Internal testing → Testers → Copy link**). Updates then
install and auto-update directly through the Google Play Store app.
