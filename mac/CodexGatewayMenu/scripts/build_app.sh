#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/../.." && pwd)"
APP_NAME="CodexGateway"
APP_DISPLAY_NAME="CodexGateway"
BUILD_DIR="$ROOT_DIR/.build/release"
OUT_DIR="$ROOT_DIR/build"
APP_DIR="$OUT_DIR/$APP_NAME.app"
DMG_PATH="$OUT_DIR/$APP_NAME.dmg"
DMG_RW_PATH="$OUT_DIR/$APP_NAME-rw.dmg"
DMG_VOLUME_NAME="$APP_NAME Installer"
EXECUTABLE="$BUILD_DIR/$APP_NAME"
ICON_SRC="$ROOT_DIR/Resources/AppIcon.icns"
MENU_ICON_SRC="$ROOT_DIR/Resources/MenuBarIcon.png"
STAGE_DIR="$ROOT_DIR/.staging"
DMG_STAGE="$STAGE_DIR/dmg-root"
GATEWAY_STAGE="$STAGE_DIR/GatewayRuntime"
NODE_STAGE="$STAGE_DIR/Node"
CACHE_DIR="$ROOT_DIR/.cache"
NODE_VERSION="${NODE_VERSION:-20.19.0}"
NODE_DIST="node-v${NODE_VERSION}-darwin-arm64"
NODE_TARBALL="$CACHE_DIR/${NODE_DIST}.tar.gz"
NODE_DOWNLOAD_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.gz"
RELEASE_MODE=0
NPM_CLI_REL="lib/node_modules/npm/bin/npm-cli.js"
NODE_GYP_REL="lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"
ENTITLEMENTS_PATH="$STAGE_DIR/codesign.entitlements"
VERSIONS_FILE="$REPO_ROOT/versions.json"
MAC_APP_VERSION="${MAC_APP_VERSION:-}"
MAC_APP_BUILD_VERSION="${MAC_APP_BUILD_VERSION:-}"

if [ "${1:-}" = "--release" ]; then
  RELEASE_MODE=1
elif [ "$#" -gt 0 ]; then
  echo "Usage: $0 [--release]"
  exit 1
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 1
  fi
}

for cmd in node python3 swift hdiutil; do
  require_cmd "$cmd"
done

if [ -z "$MAC_APP_VERSION" ]; then
  if [ ! -f "$VERSIONS_FILE" ]; then
    echo "Missing versions file: $VERSIONS_FILE"
    exit 1
  fi
  MAC_APP_VERSION="$(VERSIONS_FILE_FOR_NODE="$VERSIONS_FILE" node <<'NODE'
const fs = require("fs");

const versionsPath = process.env.VERSIONS_FILE_FOR_NODE;
if (!versionsPath) {
  throw new Error("VERSIONS_FILE_FOR_NODE is required");
}
const versions = JSON.parse(fs.readFileSync(versionsPath, "utf8"));
if (typeof versions.mac !== "string" || !/^\d+\.\d+\.\d+$/.test(versions.mac)) {
  throw new Error("versions.json must contain a semver mac field");
}
process.stdout.write(versions.mac);
NODE
)"
fi

if [ -z "$MAC_APP_BUILD_VERSION" ]; then
  MAC_APP_BUILD_VERSION="$MAC_APP_VERSION"
fi

echo "==> Using mac app version ${MAC_APP_VERSION} (${MAC_APP_BUILD_VERSION})"

run_tsc() {
  local project_file="$1"
  if [ -x "$REPO_ROOT/node_modules/.bin/tsc" ]; then
    "$REPO_ROOT/node_modules/.bin/tsc" -p "$project_file"
  else
    npx tsc -p "$project_file"
  fi
}

run_bundled_npm() {
  local cwd="$1"
  shift
  (cd "$cwd" && "$NODE_STAGE/bin/node" "$NODE_STAGE/$NPM_CLI_REL" "$@")
}

normalize_resource_bundle() {
  local bundle_path="$1"
  local bundle_name
  local bundle_base
  local bundle_id_suffix
  local contents_dir
  local resources_dir
  local root_info
  local contents_info

  bundle_name="$(basename "$bundle_path")"
  bundle_base="${bundle_name%.bundle}"
  bundle_id_suffix="$(printf '%s' "$bundle_base" | tr -c 'A-Za-z0-9.-' '-')"
  contents_dir="$bundle_path/Contents"
  resources_dir="$contents_dir/Resources"
  root_info="$bundle_path/Info.plist"
  contents_info="$contents_dir/Info.plist"

  mkdir -p "$resources_dir"

  if [ -f "$root_info" ] && [ ! -f "$contents_info" ]; then
    mv "$root_info" "$contents_info"
  fi

  while IFS= read -r entry; do
    local entry_name
    entry_name="$(basename "$entry")"
    if [ "$entry_name" = "Contents" ]; then
      continue
    fi
    mv "$entry" "$resources_dir/"
  done < <(find "$bundle_path" -mindepth 1 -maxdepth 1)

  if [ ! -f "$contents_info" ]; then
    cat > "$contents_info" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleIdentifier</key>
  <string>com.codex.gateway.resources.${bundle_id_suffix}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${bundle_base}</string>
  <key>CFBundlePackageType</key>
  <string>BNDL</string>
</dict>
</plist>
PLIST
  fi
}

echo "==> Building shared + gateway with Node toolchain"
run_tsc "$REPO_ROOT/shared/tsconfig.json"
run_tsc "$REPO_ROOT/gateway/tsconfig.json"

echo "==> Preparing staging directories"
rm -rf "$STAGE_DIR" "$APP_DIR" "$DMG_PATH"
mkdir -p "$STAGE_DIR" "$OUT_DIR" "$CACHE_DIR" "$GATEWAY_STAGE" "$DMG_STAGE"

echo "==> Downloading Node runtime (${NODE_VERSION}) if needed"
if [ ! -f "$NODE_TARBALL" ]; then
  curl -fsSL "$NODE_DOWNLOAD_URL" -o "$NODE_TARBALL"
fi

tar -xzf "$NODE_TARBALL" -C "$STAGE_DIR"
mv "$STAGE_DIR/$NODE_DIST" "$NODE_STAGE"

echo "==> Staging bundled gateway runtime"
cp -R "$REPO_ROOT/gateway/dist" "$GATEWAY_STAGE/dist"

REPO_ROOT_FOR_NODE="$REPO_ROOT" GATEWAY_STAGE_FOR_NODE="$GATEWAY_STAGE" "$NODE_STAGE/bin/node" <<'NODE'
const fs = require("fs");
const path = require("path");

const repoRoot = process.env.REPO_ROOT_FOR_NODE;
const stage = process.env.GATEWAY_STAGE_FOR_NODE;
if (!repoRoot || !stage) {
  throw new Error("Missing environment for staging script.");
}

const gatewayPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "gateway/package.json"), "utf8"));
const sharedPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "shared/package.json"), "utf8"));

const deps = { ...(gatewayPkg.dependencies || {}) };
delete deps["@codex-phone/shared"];
Object.assign(deps, sharedPkg.dependencies || {});

const runtimePkg = {
  name: "codex-gateway-runtime",
  private: true,
  version: gatewayPkg.version || "0.1.0",
  type: "commonjs",
  dependencies: deps,
};

fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(runtimePkg, null, 2));
NODE

run_bundled_npm "$GATEWAY_STAGE" install --omit=dev --no-audit --no-fund
(
  cd "$GATEWAY_STAGE/node_modules/better-sqlite3"
  rm -rf build
  "$NODE_STAGE/bin/node" "$NODE_STAGE/$NODE_GYP_REL" rebuild --release
)
(
  cd "$GATEWAY_STAGE"
  "$NODE_STAGE/bin/node" -e "const Better=require('better-sqlite3'); const db=new Better(':memory:'); db.prepare('select 1').get(); db.close(); console.log('node-modules=' + process.versions.modules); console.log('better-sqlite3-validated')"
)

mkdir -p "$GATEWAY_STAGE/node_modules/@codex-phone/shared"
cp -R "$REPO_ROOT/shared/dist" "$GATEWAY_STAGE/node_modules/@codex-phone/shared/dist"
cat > "$GATEWAY_STAGE/node_modules/@codex-phone/shared/package.json" <<'JSON'
{
  "name": "@codex-phone/shared",
  "version": "0.1.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts"
}
JSON

echo "==> Building Swift app"
swift build -c release --package-path "$ROOT_DIR"

mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

cp "$EXECUTABLE" "$APP_DIR/Contents/MacOS/$APP_NAME"
chmod +x "$APP_DIR/Contents/MacOS/$APP_NAME"
if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$APP_DIR/Contents/Resources/AppIcon.icns"
fi
if [ -f "$MENU_ICON_SRC" ]; then
  cp "$MENU_ICON_SRC" "$APP_DIR/Contents/Resources/MenuBarIcon.png"
fi

for bundle in "$BUILD_DIR"/*.bundle; do
  if [ -d "$bundle" ]; then
    bundle_dest="$APP_DIR/Contents/Resources/$(basename "$bundle")"
    cp -R "$bundle" "$bundle_dest"
    normalize_resource_bundle "$bundle_dest"
  fi
done

cp -R "$GATEWAY_STAGE" "$APP_DIR/Contents/Resources/GatewayRuntime"
cp -R "$NODE_STAGE" "$APP_DIR/Contents/Resources/Node"
chmod +x "$APP_DIR/Contents/Resources/Node/bin/node"

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>$APP_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>com.codex.gateway</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleName</key>
  <string>$APP_DISPLAY_NAME</string>
  <key>CFBundleDisplayName</key>
  <string>$APP_DISPLAY_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${MAC_APP_VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${MAC_APP_BUILD_VERSION}</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

if [ -n "${SIGN_IDENTITY:-}" ]; then
  echo "==> Codesigning app with identity: ${SIGN_IDENTITY}"
  cat > "$ENTITLEMENTS_PATH" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
PLIST

  while IFS= read -r -d '' sign_target; do
    if [ "$(basename "$sign_target")" = "node" ]; then
      codesign --force --sign "$SIGN_IDENTITY" --options runtime --timestamp --entitlements "$ENTITLEMENTS_PATH" "$sign_target"
    else
      codesign --force --sign "$SIGN_IDENTITY" --options runtime --timestamp "$sign_target"
    fi
  done < <(find "$APP_DIR/Contents" -type f \( -name "*.dylib" -o -name "*.node" -o -name "node" \) -print0)

  codesign --force --deep --sign "$SIGN_IDENTITY" --options runtime --timestamp --entitlements "$ENTITLEMENTS_PATH" "$APP_DIR"
else
  echo "==> SIGN_IDENTITY not set. Building unsigned app bundle."
fi

echo "==> Building DMG"
cp -R "$APP_DIR" "$DMG_STAGE/$APP_NAME.app"

mkdir -p "$DMG_STAGE/.background"
BG_PATH="$DMG_STAGE/.background/background.png"
BG_PATH="$BG_PATH" python3 - <<'PY'
import os
from PIL import Image, ImageDraw

ICON_LEFT_X = 165
ICON_RIGHT_X = 545


SCALE = 2


def s(value):
    return int(round(value * SCALE))


bg_path = os.environ["BG_PATH"]
img = Image.new("RGBA", (s(720), s(420)), "white")
draw = ImageDraw.Draw(img, "RGBA")

# Center directional arrow inspired by common DMG layouts: short, subtle, and crisp.
arrow_mid_x = s((ICON_LEFT_X + ICON_RIGHT_X) / 2)
arrow_mid_y = s(205)
chevron_size = s(20)
shadow_offset = s(2)

draw.line(
    (
        arrow_mid_x - chevron_size // 2 + shadow_offset,
        arrow_mid_y - chevron_size + shadow_offset,
        arrow_mid_x + chevron_size // 2 + shadow_offset,
        arrow_mid_y + shadow_offset,
        arrow_mid_x - chevron_size // 2 + shadow_offset,
        arrow_mid_y + chevron_size + shadow_offset,
    ),
    fill=(255, 255, 255, 140),
    width=s(5),
    joint="curve",
)
draw.line(
    (
        arrow_mid_x - chevron_size // 2,
        arrow_mid_y - chevron_size,
        arrow_mid_x + chevron_size // 2,
        arrow_mid_y,
        arrow_mid_x - chevron_size // 2,
        arrow_mid_y + chevron_size,
    ),
    fill=(35, 43, 58, 255),
    width=s(5),
    joint="curve",
)

img = img.resize((720, 420), Image.Resampling.LANCZOS)
img.convert("RGB").save(bg_path)
PY

hdiutil create -volname "$DMG_VOLUME_NAME" -srcfolder "$DMG_STAGE" -ov -format UDRW -fs HFS+ "$DMG_RW_PATH"
ATTACH_OUTPUT="$(hdiutil attach -readwrite -noverify -noautoopen "$DMG_RW_PATH")"
DMG_DEVICE="$(printf '%s\n' "$ATTACH_OUTPUT" | awk '/\/Volumes\// {print $1; exit}')"
DMG_MOUNT_DIR="$(printf '%s\n' "$ATTACH_OUTPUT" | awk '/\/Volumes\// {idx=index($0, "/Volumes/"); print substr($0, idx); exit}')"
DMG_BG_POSIX="$DMG_MOUNT_DIR/.background/background.png"

# Create the Applications drop target inside the mounted DMG.
# Prefer a Finder alias for better icon fidelity on recent macOS releases.
rm -rf "$DMG_MOUNT_DIR/Applications"
if ! osascript <<EOF >/dev/null 2>&1
tell application "Finder"
  set dmgFolder to POSIX file "$DMG_MOUNT_DIR" as alias
  set appAlias to make new alias file at dmgFolder to POSIX file "/Applications"
  set name of appAlias to "Applications"
end tell
EOF
then
  # Fallback in case Finder alias creation is unavailable.
  ln -s /Applications "$DMG_MOUNT_DIR/Applications"
fi

osascript \
  -e 'tell application "Finder"' \
  -e "tell disk (POSIX file \"$DMG_MOUNT_DIR\" as alias)" \
  -e 'open' \
  -e 'set current view of container window to icon view' \
  -e 'set toolbar visible of container window to false' \
  -e 'set statusbar visible of container window to false' \
  -e 'set bounds of container window to {120, 120, 840, 540}' \
  -e 'set viewOptions to the icon view options of container window' \
  -e 'set arrangement of viewOptions to not arranged' \
  -e 'set icon size of viewOptions to 128' \
  -e 'set text size of viewOptions to 14' \
  -e 'set shows icon preview of viewOptions to false' \
  -e "set background picture of viewOptions to POSIX file \"$DMG_BG_POSIX\"" \
  -e "set position of item \"$APP_NAME.app\" of container window to {165, 205}" \
  -e 'set position of item "Applications" of container window to {545, 205}' \
  -e 'close' \
  -e 'open' \
  -e 'update without registering applications' \
  -e 'delay 1' \
  -e 'end tell' \
  -e 'end tell'

sync
DETACH_TARGET="${DMG_DEVICE:-$DMG_MOUNT_DIR}"
hdiutil detach "$DETACH_TARGET" || hdiutil detach -force "$DETACH_TARGET"
hdiutil convert "$DMG_RW_PATH" -format UDZO -o "$DMG_PATH"
rm -f "$DMG_RW_PATH"

if [ "$RELEASE_MODE" -eq 1 ]; then
  if [ -z "${SIGN_IDENTITY:-}" ]; then
    echo "Release mode requires SIGN_IDENTITY."
    exit 1
  fi
  if [ -z "${NOTARYTOOL_PROFILE:-}" ]; then
    echo "Release mode requires NOTARYTOOL_PROFILE."
    exit 1
  fi
  require_cmd xcrun

  echo "==> Submitting DMG for notarization with profile: ${NOTARYTOOL_PROFILE}"
  xcrun notarytool submit "$DMG_PATH" --keychain-profile "$NOTARYTOOL_PROFILE" --wait
  xcrun stapler staple "$APP_DIR"
  xcrun stapler staple "$DMG_PATH"
fi

echo "Built app: $APP_DIR"
echo "Built DMG: $DMG_PATH"
