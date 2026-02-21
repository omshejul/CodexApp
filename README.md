# Codex Phone Monorepo

Monorepo for pairing a phone with a user-owned laptop running Codex app-server.

## Packages

- `gateway/`: Fastify + SQLite gateway on `127.0.0.1:8787`, JWT auth, pairing, Codex JSON-RPC bridge, SSE stream.
- `app/`: Expo Router app for QR pairing, threads list, thread reading, sending messages, and live updates.
- `shared/`: Zod request/response schemas used by both app and gateway.

## Requirements

- [Bun](https://bun.sh/)
- Node.js (runtime for gateway, due native `better-sqlite3`)
- Codex CLI with app-server command
- [Tailscale](https://tailscale.com/) installed on laptop and phone

## Install

```bash
bun install
```

## Teammate Setup

1. Build the gateway:

```bash
bun run build:shared
bun run build:gateway
```

2. Configure gateway env:

```bash
cp gateway/.env.example gateway/.env
```

Set `PUBLIC_BASE_URL` to your Tailscale hostname (example: `https://oms-laptop.skate-liberty.ts.net`).

3. Run gateway (localhost only):

```bash
cd gateway
bun run start
```

By default, gateway auto-starts Codex app-server when missing:

```bash
codex app-server --listen ws://127.0.0.1:4500
```

Optional env vars:
- `PORT` (default `8787`)
- `HOST` (default `127.0.0.1`)
- `CODEX_WS_URL` (default `ws://127.0.0.1:4500`)
- `AUTO_START_CODEX_APP_SERVER` (default `1`; set `0` to disable auto-start)
- `CODEX_APP_SERVER_BIN` (default `codex`)
- `CODEX_APP_SERVER_LISTEN` (default same as `CODEX_WS_URL`)
- `PUBLIC_BASE_URL` (recommended; e.g. `https://laptopname.tailnet.ts.net`)
- `TOKEN_HASH_SECRET` (defaults to `JWT_SECRET`)
- `DB_PATH` (default `gateway/data/gateway.sqlite`)

4. Expose gateway through Tailscale Serve:

```bash
tailscale serve --bg http://127.0.0.1:8787
tailscale serve status
```

5. On laptop, open the local pairing page:

```text
http://127.0.0.1:8787/pair
```

6. On phone, run Expo app and scan QR.

## Development Commands

- Gateway dev:

```bash
bun run dev:gateway
```

- App dev:

```bash
bun run dev:app
```

- Full typecheck:

```bash
bun run typecheck
```

## iOS Device Build

Build and run on a connected iPhone (Debug/dev build, requires Metro):

```bash
cd app
bun run ios --device
```

Build and run a standalone local Release app on a connected iPhone (no Metro required):

```bash
cd app
bunx expo run:ios --device --configuration Release
```

Notes:
- This repo uses Bun (`bun.lock` + root `packageManager`), so prefer Bun over npm for app commands.
- `react-native-reanimated@4` requires React Native New Architecture. Keep `app/ios/Podfile.properties.json` with `"newArchEnabled": "true"` or iOS `pod install` will fail.
- If CocoaPods gets out of sync, run:

```bash
cd app/ios
pod install --repo-update
```

## Security Model

- Codex app-server is local-only (`127.0.0.1`).
- Gateway is local-only (`127.0.0.1`) and externally reachable only through Tailscale Serve HTTPS.
- Pairing session code is one-time and expires after 10 minutes.
- Access token is JWT HS256 and short-lived (15 minutes).
- Refresh token lifetime is 30 days and stored hashed server-side.
- Pairing claim endpoint is rate-limited.

## macOS Gateway App

- Self-contained menu bar app guide: `/Users/omshejul/Code/CodexApp/docs/MAC_GATEWAY_APP.md`
- Build local app + DMG:
```bash
/Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/scripts/build_app.sh
```
- Signed/notarized release build:
```bash
SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
NOTARYTOOL_PROFILE="codex-notary" \
/Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/scripts/build_app.sh --release
```
