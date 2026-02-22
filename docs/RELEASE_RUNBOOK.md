# Release Runbook (Build, Sign, Submit, Publish)

Use this when cutting a full release for:
- macOS app (`CodexGateway.dmg`) with signing + notarization
- Android APK via EAS
- iOS IPA via EAS + App Store Connect/TestFlight
- GitHub releases

Repo root:
- `/Users/omshejul/Code/CodexApp`

## 1) Preflight

From repo root:

```bash
cd /Users/omshejul/Code/CodexApp
bun install
bun run typecheck
```

Check auth:

```bash
gh auth status
cd /Users/omshejul/Code/CodexApp/app
npx eas-cli whoami
```

## 2) Set Versions (Single Source of Truth)

Set versions in `versions.json` and sync to Expo app config:

```bash
cd /Users/omshejul/Code/CodexApp
node scripts/versions/set.mjs app <x.y.z>
node scripts/versions/set.mjs mac <x.y.z>
```

This updates:
- `/Users/omshejul/Code/CodexApp/versions.json`
- `/Users/omshejul/Code/CodexApp/app/app.json` (`expo.version`)
- `/Users/omshejul/Code/CodexApp/app/package.json` (`version`)

## 3) Build + Sign + Notarize macOS App

Required env:
- `SIGN_IDENTITY`
- `NOTARYTOOL_PROFILE`

Command:

```bash
cd /Users/omshejul/Code/CodexApp
SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
NOTARYTOOL_PROFILE="codex-gateway" \
bun run build:mac
```

Outputs:
- `/Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/build/CodexGateway.app`
- `/Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/build/CodexGateway.dmg`

## 4) Build Android APK (EAS)

Use preview profile to produce APK:

```bash
cd /Users/omshejul/Code/CodexApp/app
npx eas-cli build --platform android --profile preview --non-interactive --wait
```

Get latest build info/artifact:

```bash
cd /Users/omshejul/Code/CodexApp/app
npx eas-cli build:list --platform android --limit 1 --non-interactive
```

Optional local download:

```bash
cd /Users/omshejul/Code/CodexApp
mkdir -p .artifacts
curl -L "<APPLICATION_ARCHIVE_URL>" -o .artifacts/codex-phone-<version>-preview.apk
```

## 5) Submit Android APK (EAS Submit)

Submit by file path:

```bash
cd /Users/omshejul/Code/CodexApp/app
npx eas-cli submit -p android --profile production --path /Users/omshejul/Code/CodexApp/.artifacts/codex-phone-<version>-preview.apk --non-interactive --wait
```

Important:
- If Google Play returns `first submission needs to be performed manually`, do one manual first upload in Play Console for this app/package, then rerun EAS submit.

## 6) Build iOS IPA (EAS)

```bash
cd /Users/omshejul/Code/CodexApp/app
npx eas-cli build --platform ios --profile production --non-interactive --wait
```

Get latest iOS build:

```bash
cd /Users/omshejul/Code/CodexApp/app
npx eas-cli build:list --platform ios --limit 1 --non-interactive
```

## 7) Submit iOS Build (App Store Connect/TestFlight)

Submit by build ID:

```bash
cd /Users/omshejul/Code/CodexApp/app
npx eas-cli submit -p ios --id <IOS_BUILD_ID> --profile production --non-interactive --wait
```

Current config already supports non-interactive submit:
- `/Users/omshejul/Code/CodexApp/app/eas.json` contains `submit.production.ios.ascAppId`.

TestFlight page:
- https://appstoreconnect.apple.com/apps/6759392933/testflight/ios

## 8) Export Compliance (iOS Encryption)

To avoid repeated App Store Connect encryption prompts, keep this in Expo config:
- `/Users/omshejul/Code/CodexApp/app/app.json`
- `expo.ios.infoPlist.ITSAppUsesNonExemptEncryption: false`

If prompted in App Store Connect UI, choose:
- `None of the algorithms mentioned above`

## 9) Publish Artifacts to GitHub Releases

App (APK) release:

```bash
cd /Users/omshejul/Code/CodexApp
node scripts/release/github-release.mjs app .artifacts/codex-phone-<version>-preview.apk
```

Mac (DMG) release:

```bash
cd /Users/omshejul/Code/CodexApp
node scripts/release/github-release.mjs mac mac/CodexGatewayMenu/build/CodexGateway.dmg
```

Tag conventions:
- App: `v<app-version>`
- Mac: `mac-v<mac-version>`

## 10) Commit + Push

```bash
cd /Users/omshejul/Code/CodexApp
git status -sb
git add -A
git commit -m "Release app <app-version> and mac <mac-version>"
git push origin main
```

## 11) Send Completion Notification

```bash
cd /Users/omshejul/Code/CodexApp
MSG_ENCODED="$(python3 - <<'PY'
import urllib.parse
msg = "Codex release complete (Om): include versions and status here"
print(urllib.parse.quote(msg, safe=''))
PY
)"
curl -sS "https://nodered.omshejul.com/notification?msg=${MSG_ENCODED}"
```

Expected response:
- `{"status":"Connected"}`

## Quick Checklist

1. `bun run typecheck` passes.
2. Versions set via `scripts/versions/set.mjs`.
3. `bun run build:mac` completes with notarization accepted.
4. Android EAS build finished and APK available.
5. Android EAS submit attempted (or manual-first-upload done if required).
6. iOS EAS build finished and submit succeeded.
7. TestFlight processing confirmed.
8. APK + DMG uploaded to GitHub releases.
9. Commit pushed to `origin/main`.
10. Node-RED notification sent.
