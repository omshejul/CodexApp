import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER_PATH = path.join(REPO_ROOT, "scripts/install-linux-tui.sh");

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents, "utf8");
  fs.chmodSync(filePath, 0o755);
}

function createMockCommands(mockBinDir, options = {}) {
  const includeBun = options.includeBun !== false;
  const codexVersion = options.codexVersion ?? "0.135.0";

  writeExecutable(
    path.join(mockBinDir, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
echo "git $*" >> "$MOCK_LOG_PATH"
if [[ "$1" == "clone" ]]; then
  target="\${@: -1}"
  mkdir -p "$target/.git"
fi
`
  );

  if (includeBun) {
    writeExecutable(
      path.join(mockBinDir, "bun"),
      `#!/usr/bin/env bash
set -euo pipefail
echo "bun $*" >> "$MOCK_LOG_PATH"
if [[ "\${1:-}" == "install" ]]; then
  repo_dir=""
  for ((i=1; i<=$#; i++)); do
    arg="\${!i}"
    if [[ "$arg" == "--cwd" ]]; then
      next=$((i + 1))
      repo_dir="\${!next}"
    fi
  done
  if [[ -n "$repo_dir" ]]; then
    package_dir="$repo_dir/node_modules/.bun/better-sqlite3@11.10.0/node_modules/better-sqlite3"
    mkdir -p "$package_dir" "$repo_dir/gateway/node_modules"
    ln -sfn "../../node_modules/.bun/better-sqlite3@11.10.0/node_modules/better-sqlite3" "$repo_dir/gateway/node_modules/better-sqlite3"
  fi
fi
`
    );
  }

  writeExecutable(
    path.join(mockBinDir, "node"),
    `#!/usr/bin/env bash
set -euo pipefail
echo "node $*" >> "$MOCK_LOG_PATH"
if [[ "\${1:-}" == "-" ]]; then
  current="\${2:-}"
  minimum="\${3:-}"
  IFS=. read -r current_major current_minor current_patch <<< "$current"
  IFS=. read -r minimum_major minimum_minor minimum_patch <<< "$minimum"
  current_major="\${current_major:-0}"
  current_minor="\${current_minor:-0}"
  current_patch="\${current_patch:-0}"
  minimum_major="\${minimum_major:-0}"
  minimum_minor="\${minimum_minor:-0}"
  minimum_patch="\${minimum_patch:-0}"
  if (( current_major > minimum_major )); then exit 0; fi
  if (( current_major < minimum_major )); then exit 1; fi
  if (( current_minor > minimum_minor )); then exit 0; fi
  if (( current_minor < minimum_minor )); then exit 1; fi
  if (( current_patch >= minimum_patch )); then exit 0; fi
  exit 1
fi
`
  );

  writeExecutable(
    path.join(mockBinDir, "codex"),
    `#!/usr/bin/env bash
set -euo pipefail
echo "codex $*" >> "$MOCK_LOG_PATH"
if [[ "\${1:-}" == "--version" ]]; then
  echo "codex-cli ${codexVersion}"
fi
`
  );

  writeExecutable(
    path.join(mockBinDir, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
echo "npm $*" >> "$MOCK_LOG_PATH"
if [[ "$*" == *"rebuild"* ]]; then
  exit 0
fi
if [[ "$*" != *"install -g"* ]]; then
  exit 0
fi
if [[ "${options.includeNpm ? "1" : "0"}" != "1" ]]; then
  exit 0
fi
cat > "${path.join(mockBinDir, "codex")}" <<'CODEX'
#!/usr/bin/env bash
set -euo pipefail
echo "codex $*" >> "$MOCK_LOG_PATH"
if [[ "\${1:-}" == "--version" ]]; then
  echo "codex-cli 0.135.0"
fi
CODEX
chmod +x "${path.join(mockBinDir, "codex")}"
`
  );

  writeExecutable(
    path.join(mockBinDir, "tailscale"),
    `#!/usr/bin/env bash
set -euo pipefail
echo "tailscale $*" >> "$MOCK_LOG_PATH"
if [[ "$1" == "status" ]]; then
  echo '{"Self":{"DNSName":"test.tailnet.ts.net."},"BackendState":"Running"}'
fi
`
  );
}

function createMockCurlThatInstallsBun(mockBinDir) {
  writeExecutable(
    path.join(mockBinDir, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
echo "curl $*" >> "$MOCK_LOG_PATH"
cat <<'INSTALLER'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "\${BUN_INSTALL:-$HOME/.bun}/bin"
cat > "\${BUN_INSTALL:-$HOME/.bun}/bin/bun" <<'BUN'
#!/usr/bin/env bash
set -euo pipefail
echo "bun $*" >> "$MOCK_LOG_PATH"
if [[ "\${1:-}" == "install" ]]; then
  repo_dir=""
  for ((i=1; i<=$#; i++)); do
    arg="\${!i}"
    if [[ "$arg" == "--cwd" ]]; then
      next=$((i + 1))
      repo_dir="\${!next}"
    fi
  done
  if [[ -n "$repo_dir" ]]; then
    package_dir="$repo_dir/node_modules/.bun/better-sqlite3@11.10.0/node_modules/better-sqlite3"
    mkdir -p "$package_dir" "$repo_dir/gateway/node_modules"
    ln -sfn "../../node_modules/.bun/better-sqlite3@11.10.0/node_modules/better-sqlite3" "$repo_dir/gateway/node_modules/better-sqlite3"
  fi
fi
BUN
chmod +x "\${BUN_INSTALL:-$HOME/.bun}/bin/bun"
INSTALLER
`
  );
}

function runInstaller({ fakeHome, fakeXdg, mockBin, mockLog }) {
  return spawnSync("bash", [INSTALLER_PATH], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fakeHome,
      XDG_DATA_HOME: fakeXdg,
      PATH: `${mockBin}:/usr/bin:/bin`,
      MOCK_LOG_PATH: mockLog,
      BUN_INSTALL: path.join(fakeHome, ".bun"),
    },
  });
}

test("fresh install clones repo and writes launcher", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-install-test-"));
  try {
    const fakeHome = path.join(tempRoot, "home");
    const fakeXdg = path.join(tempRoot, "xdg");
    const mockBin = path.join(tempRoot, "mock-bin");
    const mockLog = path.join(tempRoot, "commands.log");

    fs.mkdirSync(fakeHome, { recursive: true });
    fs.mkdirSync(fakeXdg, { recursive: true });
    fs.mkdirSync(mockBin, { recursive: true });
    createMockCommands(mockBin);

    const result = runInstaller({ fakeHome, fakeXdg, mockBin, mockLog });
    assert.equal(
      result.status,
      0,
      `installer failed\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`
    );

    const launcherPath = path.join(fakeHome, ".local/bin/codex-gateway-tui");
    assert.equal(fs.existsSync(launcherPath), true, "launcher file was not created");
    const launcher = fs.readFileSync(launcherPath, "utf8");
    assert.match(launcher, /tui:linux/, "launcher does not call Linux TUI command");

    const logText = fs.readFileSync(mockLog, "utf8");
    assert.match(logText, /git clone --depth 1 --branch main https:\/\/github\.com\/omshejul\/CodexApp\.git/);
    assert.match(logText, /bun install --cwd/);
    assert.match(logText, /npm rebuild --build-from-source/);
    assert.match(logText, /node -e require\(process\.argv\[1\]\)/);
    assert.match(logText, /bun run --cwd .* build:shared/);
    assert.match(logText, /bun run --cwd .* build:gateway/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("existing install fetches instead of cloning", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-install-test-"));
  try {
    const fakeHome = path.join(tempRoot, "home");
    const fakeXdg = path.join(tempRoot, "xdg");
    const mockBin = path.join(tempRoot, "mock-bin");
    const mockLog = path.join(tempRoot, "commands.log");

    fs.mkdirSync(fakeHome, { recursive: true });
    fs.mkdirSync(fakeXdg, { recursive: true });
    fs.mkdirSync(mockBin, { recursive: true });
    fs.mkdirSync(path.join(fakeXdg, "codex-gateway-tui/CodexApp/.git"), { recursive: true });
    createMockCommands(mockBin);

    const result = runInstaller({ fakeHome, fakeXdg, mockBin, mockLog });
    assert.equal(
      result.status,
      0,
      `installer failed\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`
    );

    const logText = fs.readFileSync(mockLog, "utf8");
    assert.equal(logText.includes("git clone"), false, "installer cloned instead of updating existing repo");
    assert.match(logText, /git -C .* fetch --depth 1 origin main/);
    assert.match(logText, /git -C .* reset --hard FETCH_HEAD/);
    assert.match(logText, /git -C .* checkout -B main FETCH_HEAD/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("missing bun is bootstrapped before building", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-install-test-"));
  try {
    const fakeHome = path.join(tempRoot, "home");
    const fakeXdg = path.join(tempRoot, "xdg");
    const mockBin = path.join(tempRoot, "mock-bin");
    const mockLog = path.join(tempRoot, "commands.log");

    fs.mkdirSync(fakeHome, { recursive: true });
    fs.mkdirSync(fakeXdg, { recursive: true });
    fs.mkdirSync(mockBin, { recursive: true });
    createMockCommands(mockBin, { includeBun: false });
    createMockCurlThatInstallsBun(mockBin);

    const result = runInstaller({ fakeHome, fakeXdg, mockBin, mockLog });
    assert.equal(
      result.status,
      0,
      `installer failed\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`
    );

    const installedBun = path.join(fakeHome, ".bun/bin/bun");
    assert.equal(fs.existsSync(installedBun), true, "bun was not installed into BUN_INSTALL");

    const logText = fs.readFileSync(mockLog, "utf8");
    assert.match(logText, /curl -fsSL https:\/\/bun\.com\/install/);
    assert.match(logText, /bun install --cwd/);
    assert.match(logText, /bun run --cwd .* build:shared/);
    assert.match(logText, /bun run --cwd .* build:gateway/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("outdated codex is upgraded before building", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-install-test-"));
  try {
    const fakeHome = path.join(tempRoot, "home");
    const fakeXdg = path.join(tempRoot, "xdg");
    const mockBin = path.join(tempRoot, "mock-bin");
    const mockLog = path.join(tempRoot, "commands.log");

    fs.mkdirSync(fakeHome, { recursive: true });
    fs.mkdirSync(fakeXdg, { recursive: true });
    fs.mkdirSync(mockBin, { recursive: true });
    createMockCommands(mockBin, { codexVersion: "0.130.0", includeNpm: true });

    const result = runInstaller({ fakeHome, fakeXdg, mockBin, mockLog });
    assert.equal(
      result.status,
      0,
      `installer failed\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`
    );

    const logText = fs.readFileSync(mockLog, "utf8");
    assert.match(logText, /codex --version/);
    assert.match(logText, /npm install -g @openai\/codex@0\.135\.0/);
    assert.match(logText, /bun run --cwd .* build:gateway/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
