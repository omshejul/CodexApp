#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

const versionsPath = path.join(repoRoot, "versions.json");
const appPackagePath = path.join(repoRoot, "app/package.json");
const appConfigPath = path.join(repoRoot, "app/app.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureSemver(label, value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`${label} must be semver (x.y.z). Received: ${String(value)}`);
  }
}

const versions = readJson(versionsPath);
ensureSemver("versions.app", versions.app);
ensureSemver("versions.mac", versions.mac);

const appPackage = readJson(appPackagePath);
const appConfig = readJson(appConfigPath);

let changed = false;
if (appPackage.version !== versions.app) {
  appPackage.version = versions.app;
  changed = true;
}

if (!appConfig.expo || typeof appConfig.expo !== "object") {
  throw new Error("app/app.json is missing expo config");
}

if (appConfig.expo.version !== versions.app) {
  appConfig.expo.version = versions.app;
  changed = true;
}

if (changed) {
  writeJson(appPackagePath, appPackage);
  writeJson(appConfigPath, appConfig);
}

console.log(`synced versions: app=${versions.app}, mac=${versions.mac}`);
