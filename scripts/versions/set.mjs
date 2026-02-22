#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const versionsPath = path.join(repoRoot, "versions.json");

const target = process.argv[2];
const nextVersion = process.argv[3];

if ((target !== "app" && target !== "mac") || !nextVersion) {
  console.error("Usage: node scripts/versions/set.mjs <app|mac> <x.y.z>");
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+$/.test(nextVersion)) {
  console.error(`Invalid version: ${nextVersion}. Expected semver x.y.z`);
  process.exit(1);
}

const versions = JSON.parse(fs.readFileSync(versionsPath, "utf8"));
versions[target] = nextVersion;
fs.writeFileSync(versionsPath, `${JSON.stringify(versions, null, 2)}\n`, "utf8");

const syncResult = spawnSync("node", ["scripts/versions/sync.mjs"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (syncResult.status !== 0) {
  process.exit(syncResult.status ?? 1);
}

console.log(`updated ${target} version to ${nextVersion}`);
