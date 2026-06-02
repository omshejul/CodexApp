#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${CODEXAPP_REPO_URL:-https://github.com/omshejul/CodexApp.git}"
BRANCH="${CODEXAPP_BRANCH:-main}"
INSTALL_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/codex-gateway-tui"
REPO_DIR="${INSTALL_ROOT}/CodexApp"
BIN_DIR="${HOME}/.local/bin"
LAUNCHER_PATH="${BIN_DIR}/codex-gateway-tui"
BUN_VERSION="${BUN_VERSION:-1.2.3}"
CODEX_CLI_VERSION="${CODEX_CLI_VERSION:-0.135.0}"

log() {
  echo "[codex-gateway-tui] $*"
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
    return
  fi

  if have_cmd sudo; then
    sudo "$@"
    return
  fi

  echo "[codex-gateway-tui] Need root privileges for: $*" >&2
  echo "[codex-gateway-tui] Re-run as root or install sudo." >&2
  exit 1
}

require_cmd() {
  local cmd="$1"
  if ! have_cmd "$cmd"; then
    echo "[codex-gateway-tui] Required command not found: $cmd" >&2
    exit 1
  fi
}

install_native_build_packages_if_possible() {
  if ! have_cmd npm; then
    return
  fi

  local needs_python=0
  local needs_make=0
  local needs_cxx=0
  have_cmd python3 || needs_python=1
  have_cmd make || needs_make=1
  have_cmd g++ || needs_cxx=1

  if [[ "$needs_python" -eq 0 && "$needs_make" -eq 0 && "$needs_cxx" -eq 0 ]]; then
    return
  fi

  local packages=()

  if have_cmd apt-get; then
    [[ "$needs_python" -eq 1 ]] && packages+=("python3")
    [[ "$needs_make" -eq 1 ]] && packages+=("make")
    [[ "$needs_cxx" -eq 1 ]] && packages+=("g++")
    log "Installing native module build tools: ${packages[*]}"
    as_root apt-get update
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "${packages[@]}"
  elif have_cmd dnf; then
    [[ "$needs_python" -eq 1 ]] && packages+=("python3")
    [[ "$needs_make" -eq 1 ]] && packages+=("make")
    [[ "$needs_cxx" -eq 1 ]] && packages+=("gcc-c++")
    log "Installing native module build tools: ${packages[*]}"
    as_root dnf install -y "${packages[@]}"
  elif have_cmd yum; then
    [[ "$needs_python" -eq 1 ]] && packages+=("python3")
    [[ "$needs_make" -eq 1 ]] && packages+=("make")
    [[ "$needs_cxx" -eq 1 ]] && packages+=("gcc-c++")
    log "Installing native module build tools: ${packages[*]}"
    as_root yum install -y "${packages[@]}"
  elif have_cmd zypper; then
    [[ "$needs_python" -eq 1 ]] && packages+=("python3")
    [[ "$needs_make" -eq 1 ]] && packages+=("make")
    [[ "$needs_cxx" -eq 1 ]] && packages+=("gcc-c++")
    log "Installing native module build tools: ${packages[*]}"
    as_root zypper --non-interactive install "${packages[@]}"
  elif have_cmd pacman; then
    [[ "$needs_python" -eq 1 ]] && packages+=("python")
    [[ "$needs_make" -eq 1 ]] && packages+=("make")
    [[ "$needs_cxx" -eq 1 ]] && packages+=("gcc")
    log "Installing native module build tools: ${packages[*]}"
    as_root pacman -Sy --noconfirm --needed "${packages[@]}"
  elif have_cmd apk; then
    [[ "$needs_python" -eq 1 ]] && packages+=("python3")
    [[ "$needs_make" -eq 1 ]] && packages+=("make")
    [[ "$needs_cxx" -eq 1 ]] && packages+=("g++")
    log "Installing native module build tools: ${packages[*]}"
    as_root apk add --no-cache "${packages[@]}"
  else
    log "Could not auto-install native build tools; npm rebuild may fail if they are missing."
  fi
}

install_packages_if_possible() {
  local packages=()
  have_cmd git || packages+=("git")
  have_cmd curl || packages+=("curl")
  have_cmd unzip || packages+=("unzip")
  have_cmd node || packages+=("nodejs")

  if [[ "${#packages[@]}" -eq 0 ]]; then
    return
  fi

  log "Installing missing system packages: ${packages[*]}"

  if have_cmd apt-get; then
    as_root apt-get update
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "${packages[@]}"
  elif have_cmd dnf; then
    as_root dnf install -y "${packages[@]}"
  elif have_cmd yum; then
    as_root yum install -y "${packages[@]}"
  elif have_cmd zypper; then
    as_root zypper --non-interactive install "${packages[@]}"
  elif have_cmd pacman; then
    as_root pacman -Sy --noconfirm --needed "${packages[@]}"
  elif have_cmd apk; then
    as_root apk add --no-cache "${packages[@]}"
  else
    echo "[codex-gateway-tui] Could not install missing packages automatically: ${packages[*]}" >&2
    echo "[codex-gateway-tui] Install them with your distro package manager and rerun this script." >&2
    exit 1
  fi
}

install_bun_if_needed() {
  if have_cmd bun; then
    return
  fi

  require_cmd curl
  require_cmd unzip

  log "Installing Bun ${BUN_VERSION}..."
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  curl -fsSL https://bun.com/install | bash -s "bun-v${BUN_VERSION}"
  export PATH="${BUN_INSTALL}/bin:$PATH"
  require_cmd bun
}

install_tailscale_if_needed() {
  if [[ "${CODEX_GATEWAY_SKIP_TAILSCALE_INSTALL:-0}" == "1" ]] || have_cmd tailscale; then
    return
  fi

  require_cmd curl
  log "Installing Tailscale..."
  curl -fsSL https://tailscale.com/install.sh | sh

  if have_cmd systemctl; then
    as_root systemctl enable --now tailscaled || true
  fi

  require_cmd tailscale
}

codex_version() {
  codex --version 2>/dev/null | awk '{print $2}'
}

version_at_least() {
  local current="$1"
  local minimum="$2"

  node - "$current" "$minimum" <<'NODE'
const current = process.argv[2] ?? "";
const minimum = process.argv[3] ?? "";
const parse = (value) => value.split(".").map((part) => Number.parseInt(part, 10));
const a = parse(current);
const b = parse(minimum);
if (a.length < 3 || b.length < 3 || a.some(Number.isNaN) || b.some(Number.isNaN)) {
  process.exit(1);
}
for (let index = 0; index < 3; index += 1) {
  if (a[index] > b[index]) process.exit(0);
  if (a[index] < b[index]) process.exit(1);
}
NODE
}

install_codex_cli() {
  require_cmd curl
  log "Installing Codex CLI ${CODEX_CLI_VERSION}..."

  if have_cmd npm; then
    npm install -g "@openai/codex@${CODEX_CLI_VERSION}" || as_root npm install -g "@openai/codex@${CODEX_CLI_VERSION}"
  else
    curl -fsSL https://chatgpt.com/codex/install.sh | sh
  fi

  export PATH="$HOME/.codex/bin:$HOME/.local/bin:$PATH"
}

install_codex_if_needed() {
  if [[ "${CODEX_GATEWAY_SKIP_CODEX_INSTALL:-0}" == "1" ]]; then
    return
  fi

  if have_cmd codex; then
    local current_version
    current_version="$(codex_version || true)"
    if version_at_least "$current_version" "$CODEX_CLI_VERSION"; then
      return
    fi
    log "Updating Codex CLI from ${current_version:-unknown} to ${CODEX_CLI_VERSION}..."
  fi

  install_codex_cli
  require_cmd codex

  local installed_version
  installed_version="$(codex_version || true)"
  if ! version_at_least "$installed_version" "$CODEX_CLI_VERSION"; then
    echo "[codex-gateway-tui] Codex CLI ${CODEX_CLI_VERSION}+ is required; found ${installed_version:-unknown}." >&2
    exit 1
  fi
}

maybe_authenticate_tailscale() {
  if ! have_cmd tailscale; then
    return
  fi

  if tailscale status --json >/dev/null 2>&1; then
    return
  fi

  if [[ -n "${TAILSCALE_AUTHKEY:-}" ]]; then
    log "Authenticating Tailscale with TAILSCALE_AUTHKEY..."
    as_root tailscale up --auth-key "$TAILSCALE_AUTHKEY"
    return
  fi

  log "Tailscale is installed but not authenticated. Run: sudo tailscale up"
}

tailscale_authenticated() {
  have_cmd tailscale && tailscale status --json >/dev/null 2>&1
}

systemd_user_available() {
  have_cmd systemctl && systemctl --user show-environment >/dev/null 2>&1
}

rebuild_native_modules_for_node() {
  if ! have_cmd npm; then
    log "npm not found; skipping Node native module rebuild."
    return
  fi

  install_native_build_packages_if_possible

  log "Rebuilding better-sqlite3 for the active Node.js runtime..."
  if npm --prefix "$REPO_DIR/gateway" rebuild better-sqlite3 --build-from-source; then
    return
  fi

  log "Workspace rebuild failed; retrying from repository root."
  npm --prefix "$REPO_DIR" rebuild better-sqlite3 --build-from-source
}

log "Installing Codex Gateway Linux TUI..."

install_packages_if_possible
install_bun_if_needed
install_tailscale_if_needed
install_codex_if_needed
maybe_authenticate_tailscale

require_cmd git
require_cmd bun
require_cmd node
require_cmd codex
require_cmd tailscale

mkdir -p "$INSTALL_ROOT"

if [[ -d "$REPO_DIR/.git" ]]; then
  log "Updating existing checkout: $REPO_DIR"
  git -C "$REPO_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$REPO_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
else
  log "Cloning repository into: $REPO_DIR"
  rm -rf "$REPO_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi

log "Installing dependencies and building gateway runtime..."
bun install --cwd "$REPO_DIR"
rebuild_native_modules_for_node
bun run --cwd "$REPO_DIR" build:shared
bun run --cwd "$REPO_DIR" build:gateway

mkdir -p "$BIN_DIR"
cat > "$LAUNCHER_PATH" <<LAUNCHER
#!/usr/bin/env bash
set -euo pipefail
exec bun run --cwd "$REPO_DIR" tui:linux "\$@"
LAUNCHER
chmod +x "$LAUNCHER_PATH"

log "Installed launcher: $LAUNCHER_PATH"

if [[ "${CODEX_GATEWAY_SKIP_AUTO_START:-0}" == "1" ]]; then
  log "Skipping automatic gateway repair/start because CODEX_GATEWAY_SKIP_AUTO_START=1."
elif ! tailscale_authenticated; then
  log "Skipping automatic gateway repair/start because Tailscale is not authenticated."
  log "After signing in, run: codex-gateway-tui"
elif ! systemd_user_available; then
  log "Skipping automatic gateway repair/start because systemd --user is unavailable."
  log "Run manually: codex-gateway-tui"
else
  log "Repairing gateway setup, configuring Tailscale routing, and starting the service..."
  if "$LAUNCHER_PATH" --repair-start; then
    log "Gateway service is started and Tailscale routing is configured."
  else
    log "Automatic repair/start did not complete. Run: codex-gateway-tui"
  fi
fi

log "Run: codex-gateway-tui"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  log "Add this to your shell profile:"
  echo "export PATH=\"$BIN_DIR:\$PATH\""
fi
