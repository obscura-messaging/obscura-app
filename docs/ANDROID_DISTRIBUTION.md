# Android internal distribution

PR and `main` CI never distribute, and PRs never see distribution credentials
(they use the Firebase stub and debug signing). To ship, an owner
(`barrelmaker97` or `rhelsing`) runs **Actions → Release / Internal → Run
workflow** on `main`. `scripts/verify-internal-build.sh` checks the starting
and rerunning actor. It also requires the commit to be the current `main` tip
with a successful `main` CI run. Android and iOS then run independently.

Internal builds use the `dev` environment (`dev.barrelmaker.obscura.dev`,
display name **Obscura Dev**, pointing at `https://devscura.barrelmaker.dev`),
so **Obscura Dev** can be installed side-by-side with the production
`dev.barrelmaker.obscura` app (`https://obscura.barrelmaker.dev`).

`.github/workflows/internal-android.yml` builds that commit once as a signed,
minified Android App Bundle (`.aab`). It keeps the `.aab` and release notes as
a GitHub artifact for 30 days. A second job verifies the bundle's checksum and
commit, then uploads it to the Google Play Console **Internal testing** track.
The version name comes from `package.json` (`1.0.0`), and the version code is
1000 plus the release run number. Never rerun a release
that has already uploaded; retry the failed jobs or start a new run.

## Google Play Console & Firebase (FCM)

1. **Google Play Console:** Create the internal app entry for
   `dev.barrelmaker.obscura.dev` (**Obscura Dev**), upload the first `.aab`
   once manually to initialize the app in Play Console, add testers to the
   **Internal testing** track, and grant your Google Cloud Workload Identity
   service account **Release to testing tracks** permission under **Users and
   permissions**.
2. **Firebase (FCM push only):** Register `dev.barrelmaker.obscura.dev` (and
   `dev.barrelmaker.obscura` for production) in the Firebase project so
   `google-services.json` contains both package names. For local push testing,
   place the real config at `android/app/google-services.json`
   ([CONTRIBUTING](../CONTRIBUTING.md#setup-and-builds)).

## Signing key

Create one long-lived upload key. Keep an encrypted backup outside the
repository. Every distributed bundle must use this key. PKCS12 uses the same
password for the store and the key.

```bash
mkdir -p ~/.config/obscura
keytool -genkeypair -v \
  -keystore ~/.config/obscura/android-release.p12 \
  -storetype PKCS12 \
  -alias obscura-release \
  -keyalg RSA -keysize 4096 -validity 10000
```

For a local signed bundle, create the gitignored `android/keystore.properties`.
The matching `ANDROID_RELEASE_STORE_FILE`, `ANDROID_RELEASE_STORE_PASSWORD`,
`ANDROID_RELEASE_KEY_ALIAS` and `ANDROID_RELEASE_KEY_PASSWORD` environment
variables override it. Then run `just android-distribution 1 1.0.0-dev.1 dev`.
Unlike `just android-release`, it fails if signing, version metadata or the
real Firebase config is missing.

```properties
storeFile=/absolute/path/to/android-release.p12
storePassword=...
keyAlias=obscura-release
keyPassword=...
```

## GitHub `android-internal` environment

Deployments are allowed only from `main`.

| Variable | Value |
| --- | --- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Full workload identity provider resource name |
| `GCP_SERVICE_ACCOUNT` | Distribution service-account email (granted Play Console access) |

| Secret | Value |
| --- | --- |
| `GOOGLE_SERVICES_JSON_BASE64` | Base64 of the real `google-services.json` |
| `ANDROID_RELEASE_KEYSTORE_BASE64` | Base64 of the PKCS12 key |
| `ANDROID_RELEASE_STORE_PASSWORD` | PKCS12 password |
| `ANDROID_RELEASE_KEY_ALIAS` | Normally `obscura-release` |
| `ANDROID_RELEASE_KEY_PASSWORD` | PKCS12 password |

Before building, the build job checks that `google-services.json` includes
`dev.barrelmaker.obscura.dev`. It writes credentials only to runner-temporary
or gitignored paths. The delivery job receives only the `.aab` and the release
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
   assertion.workflow_ref == 'obscura-messaging/obscura-app/.github/workflows/release-internal.yml@refs/heads/main' &&
   assertion.job_workflow_ref == 'obscura-messaging/obscura-app/.github/workflows/internal-android.yml@refs/heads/main'
   ```

2. Map `attribute.repository` to `assertion.repository`, and grant the
   `principalSet://iam.googleapis.com/projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/<POOL_ID>/attribute.repository/obscura-messaging/obscura-app`
   principal `roles/iam.workloadIdentityUser` on a dedicated service account.
3. Grant that service account `roles/firebaseappdistro.admin` in the Firebase
   project.

On a repository rename, update both the provider condition and the
service-account principal; GitHub redirects do not apply to OIDC claims.
The provider resource ID is independent of the repository name and can stay
unchanged. Keep workflow paths pinned even when using immutable subject claims.

## Installing

Firebase emails each new tester an invitation. Once they accept it, they can
install from the Firebase App Tester page. Later builds signed with the same
key update in place. The run's GitHub artifact is a fallback. These APKs are
not Play-ready AABs; Google Play needs its own versioned release process.
