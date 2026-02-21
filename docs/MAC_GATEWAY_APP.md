# Configurable macOS Gateway App

This guide explains how to run and package a simple macOS menu bar app that manages the Codex gateway process.

Project location:
- `/Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu`

## What This App Does

- Runs as a menu bar app (`LSUIElement` app).
- Starts and stops the gateway process.
- Fixes common setup issues with one click (`Fix Setup`).
- Opens the pairing URL.
- Shows recent process logs.
- Provides a Settings window to edit runtime configuration.
- Persists config in JSON.

## Configuration

The app stores config at:
- `~/.codex-gateway-menu/config.json`

Config fields:
- `command`: executable name or absolute path (example: `bun`)
- `args`: command arguments array (example: `[
  "run", "start"
]`)
- `workingDirectory`: where process runs from (set to gateway folder)
- `environment`: key/value env vars
- `pairURL`: URL opened by "Open Pair Page"
- `autoStart`: start process automatically when app launches

Example config:

```json
{
  "command": "bun",
  "args": ["run", "start"],
  "workingDirectory": "/Users/omshejul/Code/CodexApp/gateway",
  "environment": {
    "HOST": "127.0.0.1",
    "PORT": "8787",
    "PUBLIC_BASE_URL": "https://your-machine.tailnet.ts.net"
  },
  "pairURL": "http://127.0.0.1:8787/pair",
  "autoStart": false
}
```

## Prerequisites

- macOS 13+
- Xcode command line tools (`xcode-select --install`)
- Swift 5.9+
- Bun installed and available in PATH (if using `command: bun`)

## Build And Run (Dev)

From repo root:

```bash
cd /Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu
swift run
```

You should see a "Codex Gateway" menu bar icon.

## Build .app Bundle

From repo root:

```bash
/Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/scripts/build_app.sh
```

Output app path:
- `/Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/build/CodexGatewayMenu.app`

To run:

```bash
open /Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/build/CodexGatewayMenu.app
```

## First-Time Setup

Recommended for non-technical users:

1. Open the menu bar app.
2. Click `Fix Setup`.
3. Wait for `Setup complete. Click Start.`
4. Click `Start`.
5. Click `Open Pair Page`.

You only need Settings if your project is in a non-standard location.

## Troubleshooting

- "Start failed" with command not found:
  - Click `Fix Setup` first.
  - If needed, set absolute command path in Settings (for example `/opt/homebrew/bin/bun`).
- Gateway starts but app cannot pair:
  - Verify `PORT` and `pairURL` match.
  - Ensure Tailscale serve is configured if pairing remotely.
- Config changes not applied to running process:
  - Save config, then Stop and Start.
- `ERR_DLOPEN_FAILED` / `better-sqlite3`:
  - Click `Fix Setup` (it reinstalls dependencies and rebuilds gateway).

## Source Files

- `Package.swift`
- `Sources/CodexGatewayMenu/CodexGatewayMenuApp.swift`
- `Sources/CodexGatewayMenu/GatewayManager.swift`
- `Sources/CodexGatewayMenu/SettingsView.swift`
- `Sources/CodexGatewayMenu/StatusMenuView.swift`
- `scripts/build_app.sh`
