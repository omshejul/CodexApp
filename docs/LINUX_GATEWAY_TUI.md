# Linux Gateway TUI (Headless)

Use this when you want a terminal-only gateway manager on Linux servers/headless systems.

## What it does

The Linux TUI mirrors the mac menu app flow:
- Loads/saves config at `~/.codex-gateway/config.json`
- Runs setup checks (gateway build, Codex CLI, Tailscale)
- Starts/stops gateway
- Configures Tailscale Serve route to gateway
- Shows paired devices and allows revocation
- Shows recent manager/runtime logs

## Run

From repo root:

```bash
bun run tui:linux
```

## One-line install from GitHub

```bash
curl -fsSL https://raw.githubusercontent.com/omshejul/CodexApp/main/scripts/install-linux-tui.sh | bash
```

After install:

```bash
codex-gateway-tui
```

Optional installer overrides:
- `CODEXAPP_REPO_URL` (default: `https://github.com/omshejul/CodexApp.git`)
- `CODEXAPP_BRANCH` (default: `main`)

## Default runtime paths

- SQLite DB: `${XDG_DATA_HOME:-~/.local/share}/CodexGateway/gateway.sqlite`
- Logs: `${XDG_DATA_HOME:-~/.local/share}/CodexGateway/logs/`

## Supervision mode

- Preferred: `systemd --user` unit `com.codex.gateway.service`
- Fallback: direct process mode (if `systemd --user` is unavailable)

## Common commands in TUI

- `start` / `stop` / `toggle`
- `fix` (auto-detect paths and Magic DNS URL)
- `pair` (shows local pair page URL)
- `pair-create` (creates pairing URL + one-time code)
- `devices` (refresh devices list)
- `revoke <index-or-id>`
- `set port <n>`
- `set public-base <url|clear>`
- `set codex <path|auto>`
- `set tailscale <path|auto>`
- `set autostart <on|off>`
- `quit`

## Required prerequisites

- Node.js available on PATH (for `gateway/dist/server.js`)
- Built gateway runtime:

```bash
bun run build:shared
bun run build:gateway
```

- Codex CLI installed (`codex`)
- Tailscale installed and authenticated (`tailscale status --json` works)
