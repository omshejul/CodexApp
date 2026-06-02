# Linux Gateway TUI (Headless)

Use this when you want a terminal-only gateway manager on Linux servers/headless systems.

## What it does

The Linux TUI mirrors the mac menu app flow:
- Loads/saves config at `~/.codex-gateway/config.json`
- Runs setup checks (gateway build, Codex CLI, Tailscale)
- Starts/stops gateway
- Configures Tailscale Serve route to gateway
  Linux first uses `tailscale serve --bg http://127.0.0.1:<port>` and verifies it with `tailscale serve status --json`
  If the HTTPS Magic DNS route is not usable, it falls back to a tailnet TCP route on `<port + 1>` (default `8788`) and stores `PUBLIC_BASE_URL` as `http://<tailscale-ip>:<fallback-port>`.
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

The installer bootstraps missing prerequisites where it can:
- Installs `git`, `curl`, `unzip`, and `nodejs` through the detected system package manager.
- Installs Bun when missing.
- Installs Tailscale when missing, then starts `tailscaled` when systemd is available.
- Installs Codex CLI when missing.
- Clones or updates this repo, installs dependencies, builds the shared/gateway runtime, and writes `~/.local/bin/codex-gateway-tui`.
- When Tailscale is already authenticated and `systemd --user` is available, runs a one-shot repair/start that configures routing and starts `com.codex.gateway.service`.

After install:

```bash
codex-gateway-tui
```

For non-interactive repair/start after an install or update:

```bash
codex-gateway-tui --repair-start
```

Optional installer overrides:
- `CODEXAPP_REPO_URL` (default: `https://github.com/omshejul/CodexApp.git`)
- `CODEXAPP_BRANCH` (default: `main`)
- `BUN_VERSION` (default: `1.2.3`)
- `TAILSCALE_AUTHKEY` (optional; if set, installer runs `tailscale up --auth-key`)
- `CODEX_GATEWAY_SKIP_TAILSCALE_INSTALL=1` (skip automatic Tailscale install)
- `CODEX_GATEWAY_SKIP_CODEX_INSTALL=1` (skip automatic Codex CLI install)
- `CODEX_GATEWAY_SKIP_AUTO_START=1` (install/build only; skip automatic route repair and service start)

If Tailscale is installed but not authenticated and no `TAILSCALE_AUTHKEY` is provided, run:

```bash
sudo tailscale up
```

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

- Node.js available on PATH (for `gateway/dist/server.js`; installed automatically by the installer when possible)
- Built gateway runtime (done automatically by the installer):

```bash
bun run build:shared
bun run build:gateway
```

- Codex CLI installed (`codex`; installed automatically by the installer when possible)
- Tailscale installed and authenticated (`tailscale status --json` works; install/start is automatic when possible, auth still requires an existing session or `TAILSCALE_AUTHKEY`)
