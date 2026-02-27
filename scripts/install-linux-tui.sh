#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${CODEXAPP_REPO_URL:-https://github.com/omshejul/CodexApp.git}"
BRANCH="${CODEXAPP_BRANCH:-main}"
INSTALL_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/codex-gateway-tui"
REPO_DIR="${INSTALL_ROOT}/CodexApp"
BIN_DIR="${HOME}/.local/bin"
LAUNCHER_PATH="${BIN_DIR}/codex-gateway-tui"

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[codex-gateway-tui] Required command not found: $cmd" >&2
    exit 1
  fi
}

echo "[codex-gateway-tui] Installing Codex Gateway Linux TUI..."

require_cmd git
require_cmd bun

mkdir -p "$INSTALL_ROOT"

if [[ -d "$REPO_DIR/.git" ]]; then
  echo "[codex-gateway-tui] Updating existing checkout: $REPO_DIR"
  git -C "$REPO_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$REPO_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
else
  echo "[codex-gateway-tui] Cloning repository into: $REPO_DIR"
  rm -rf "$REPO_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi

echo "[codex-gateway-tui] Installing dependencies and building gateway runtime..."
bun install --cwd "$REPO_DIR"
bun run --cwd "$REPO_DIR" build:shared
bun run --cwd "$REPO_DIR" build:gateway

mkdir -p "$BIN_DIR"
cat > "$LAUNCHER_PATH" <<LAUNCHER
#!/usr/bin/env bash
set -euo pipefail
exec bun run --cwd "$REPO_DIR" tui:linux "\$@"
LAUNCHER
chmod +x "$LAUNCHER_PATH"

echo "[codex-gateway-tui] Installed launcher: $LAUNCHER_PATH"
echo "[codex-gateway-tui] Run: codex-gateway-tui"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo "[codex-gateway-tui] Add this to your shell profile:"
  echo "export PATH=\"$BIN_DIR:\$PATH\""
fi
