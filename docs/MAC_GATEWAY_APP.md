# Self-Contained macOS Gateway App

This guide covers the packaged menu bar app that bundles the gateway runtime and Node.js so it can run outside this repo checkout.

Project location:
- `/Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu`

## What Is Bundled

- Swift menu bar app binary
- Gateway runtime (`dist` + production `node_modules`)
- Shared runtime package (`@codex-phone/shared`)
- Private Node runtime under app resources

The app no longer depends on local `gateway/` source paths at runtime.

## External Requirements (Not Bundled)

- Codex CLI (`codex`) installed on Mac
- Tailscale app + CLI (`tailscale`) installed and logged in

## Runtime Behavior

- Gateway runs locally on `127.0.0.1:<port>` (default `8787`).
- Pair page always opens locally: `http://127.0.0.1:<port>/pair`.
- App stores writable runtime state in:
  - `~/Library/Application Support/CodexGatewayMenu/gateway.sqlite`
  - `~/Library/Application Support/CodexGatewayMenu/logs/`
- On setup/start, app configures Tailscale route:
  - `tailscale serve --service codexgateway --bg http://127.0.0.1:<port>`
  - If this CLI rejects `--service`, app falls back to: `tailscale serve --bg http://127.0.0.1:<port>`
- On app quit, only this app-owned route is cleared:
  - `tailscale serve clear codexgateway`
  - In fallback node mode (no service support), app does not run `serve reset` to avoid removing unrelated routes.

## Settings

User-editable settings are intentionally small:
- `Magic DNS URL` (`PUBLIC_BASE_URL`)
- `Gateway Port`
- `Codex CLI Path (optional override)`
- `Auto-start`

Runtime command, args, and working directory are managed by the app.

## Build (Always Signed + Notarized)

In this project, `build` means a signed + notarized release build.
Do not use the unsigned build path for normal builds.

From repo root:

```bash
SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
NOTARYTOOL_PROFILE="codex-notary" \
/Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/scripts/build_app.sh --release
```

Outputs:
- `/Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/build/CodexGatewayMenu.app`
- `/Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/build/CodexGatewayMenu.dmg`

## Signed + Notarized Release

Set:
- `SIGN_IDENTITY` (Developer ID Application certificate name)
- `NOTARYTOOL_PROFILE` (saved keychain profile for `xcrun notarytool`)

Quick command (current project setup):

```bash
SIGN_IDENTITY="Developer ID Application: Om Shejul (M4K84L4TKR)" \
NOTARYTOOL_PROFILE="codex-gateway" \
/Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/scripts/build_app.sh --release
```

Then run:

```bash
SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
NOTARYTOOL_PROFILE="codex-notary" \
/Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/scripts/build_app.sh --release
```

This will:
1. Build bundled app
2. Codesign app
3. Build DMG
4. Submit DMG to notarization
5. Staple notarization ticket to app + DMG

## Release Runbook (Exact Steps Used)

1. Verify signing identity exists:

```bash
security find-identity -v -p codesigning
```

Expected identity format:
- `Developer ID Application: <Name> (<TEAM_ID>)`

2. Store notary credentials in keychain profile (one-time):

```bash
xcrun notarytool store-credentials codex-gateway \
  --apple-id "<APPLE_ID_EMAIL>" \
  --team-id "M4K84L4TKR" \
  --password "<APP_SPECIFIC_PASSWORD>"
```

3. Run signed + notarized build:

```bash
SIGN_IDENTITY="Developer ID Application: Om Shejul (M4K84L4TKR)" \
NOTARYTOOL_PROFILE="codex-gateway" \
/Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/scripts/build_app.sh --release
```

4. Output artifacts:
- `/Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/build/CodexGatewayMenu.app`
- `/Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/build/CodexGatewayMenu.dmg`

5. Optional validation commands:

```bash
spctl -a -t exec -vv /Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/build/CodexGatewayMenu.app
spctl -a -t open -vv /Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/build/CodexGatewayMenu.dmg
codesign --verify --deep --strict --verbose=2 /Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/build/CodexGatewayMenu.app
xcrun stapler validate /Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/build/CodexGatewayMenu.app
xcrun stapler validate /Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/build/CodexGatewayMenu.dmg
```

6. Optional notarization history check:

```bash
xcrun notarytool history --keychain-profile codex-gateway
```

Notes:
- Do not commit secrets (Apple ID password or app-specific password).
- If you need to update stored credentials later, run `notarytool store-credentials` again with the same profile name.

## First-Run Flow for End Users

1. Open app.
2. Click `Fix Setup`.
3. Confirm status is `Ready`.
4. Click `Start`.
5. Click `Open Pair Page`.

If status shows `Missing Codex CLI`, install Codex CLI and click `Fix Setup` again.  
If status shows `Missing Tailscale` or `Tailscale not authenticated`, install/sign in to Tailscale and click `Fix Setup`.
