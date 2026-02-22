#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function capture(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

function ensureSemver(label, value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`${label} must be semver (x.y.z). Received: ${String(value)}`);
  }
}

const platform = process.argv[2];
if (platform !== "app" && platform !== "mac") {
  console.error("Usage: node scripts/release/github-release.mjs <app|mac> [assetPath]");
  process.exit(1);
}

const optionalAssetPath = process.argv[3];
const versions = JSON.parse(fs.readFileSync(path.join(repoRoot, "versions.json"), "utf8"));
ensureSemver("versions.app", versions.app);
ensureSemver("versions.mac", versions.mac);

const releaseMeta =
  platform === "app"
    ? {
        tag: `CodexGatewayAndroid-${versions.app}`,
        title: `CodexGatewayAndroid-${versions.app}`,
        notes: [
          `Android app release ${versions.app}`,
          "",
          "Generated from versions.json.",
        ].join("\n"),
      }
    : {
        tag: `CodexGatewayMac-${versions.mac}`,
        title: `CodexGatewayMac-${versions.mac}`,
        notes: [
          `Mac app release ${versions.mac}`,
          "",
          "Generated from versions.json.",
        ].join("\n"),
      };

const releaseView = capture("gh", ["release", "view", releaseMeta.tag, "--json", "tagName"]);
if (!releaseView) {
  run("gh", [
    "release",
    "create",
    releaseMeta.tag,
    "--title",
    releaseMeta.title,
    "--notes",
    releaseMeta.notes,
  ]);
} else {
  run("gh", [
    "release",
    "edit",
    releaseMeta.tag,
    "--title",
    releaseMeta.title,
    "--notes",
    releaseMeta.notes,
  ]);
}

if (optionalAssetPath) {
  const assetPath = path.resolve(repoRoot, optionalAssetPath);
  if (!fs.existsSync(assetPath)) {
    console.error(`Asset not found: ${assetPath}`);
    process.exit(1);
  }
  run("gh", ["release", "upload", releaseMeta.tag, assetPath, "--clobber"]);
}

console.log(`release ready: ${releaseMeta.tag}`);
