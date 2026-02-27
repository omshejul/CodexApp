import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = "/Users/omshejul/Code/CodexApp";
const INSTALLER_PATH = path.join(REPO_ROOT, "scripts/install-linux-tui.sh");

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents, "utf8");
  fs.chmodSync(filePath, 0o755);
}

function createMockCommands(mockBinDir) {
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

  writeExecutable(
    path.join(mockBinDir, "bun"),
    `#!/usr/bin/env bash
set -euo pipefail
echo "bun $*" >> "$MOCK_LOG_PATH"
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
    assert.match(logText, /git -C .* checkout -B main origin\/main/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
