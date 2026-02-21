# AGENTS.md

Guidelines for coding agents working in this repository.

## Scope

- Applies to the full monorepo at `/Users/omshejul/Code/CodexApp`.
- If a deeper `AGENTS.md` exists in a subdirectory, the deeper file takes precedence for files under that subtree.

## Repo Layout

- `gateway/`: Fastify + SQLite gateway server.
- `app/`: Expo Router mobile app.
- `shared/`: Shared Zod schemas.
- `mac/CodexGatewayMenu/`: macOS menu bar gateway app.
- `docs/`: project docs and runbooks.

## Core Rules

- Prefer `rg`/`rg --files` for search.
- Make minimal, targeted edits; do not refactor unrelated areas.
- Do not revert user changes you did not make.
- Keep secrets out of source control.

## Build And Test

- Install deps: `bun install`
- Typecheck: `bun run typecheck`
- Gateway build: `bun run build:shared && bun run build:gateway`
- Gateway dev: `bun run dev:gateway`
- App dev: `bun run dev:app`

## macOS App Build Policy

- In this repo, `build` means **signed + notarized release build**.
- Preferred command:

```bash
cd /Users/omshejul/Code/CodexApp
bun run build:mac
```

- Required env vars (set in `.env`, see `.env.example`):

```bash
SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
NOTARYTOOL_PROFILE="codex-notary"
```

- Do not use unsigned build output for normal release/distribution workflows.

## Change Hygiene

- Keep commits focused and small.
- Include only files related to the requested change.
- Run the narrowest verification that proves the change works.

## Expo App Versioning

- When changes touch the Expo app (`app/`) in a way users can notice, increment `app/app.json` `expo.version` in the same change.
- Use semantic versioning:
  - Patch (`x.y.Z`) for fixes/small UI updates.
  - Minor (`x.Y.z`) for new backward-compatible features.
  - Major (`X.y.z`) for breaking or compatibility-impacting changes.
- Keep `app/package.json` `version` aligned with `app/app.json` `expo.version`.

## Run/Restart Guidance

- For macOS app changes, keep restart guidance minimal.
- Say only: rebuild using `/Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/scripts/build_app.sh`.

- For Metro Restart say:
  `cd /Users/omshejul/Code/CodexApp/app`
  `npx expo start --dev-client --clear`
- For build/reinstall iOS app say:
  `cd /Users/omshejul/Code/CodexApp/app`
  `npx expo run:ios --device --no-bundler --configuration Debug`
- Standalone iOS build (no Metro):
  `cd /Users/omshejul/Code/CodexApp/app`
  `npx expo run:ios --device --no-bundler --configuration Debug`
  `npx expo run:ios --device --no-bundler --configuration Release `
- Standalone Android build (no Metro):
  `cd /Users/omshejul/Code/CodexApp/app`
  `npx expo run:android --variant debug --no-bundler`
- Local standalone Android APK build (no EAS, no Metro):
  `cd /Users/omshejul/Code/CodexApp/app`
  `npx expo prebuild`
  `cd android && ./gradlew assembleRelease`
  Output: `/Users/omshejul/Code/CodexApp/app/android/app/build/outputs/apk/release/app-release.apk`
  Optional install via adb:
  `adb install -r /Users/omshejul/Code/CodexApp/app/android/app/build/outputs/apk/release/app-release.apk`

If you think something is useful to be remembered for later and will save time instead of doing it again, ask user if they can make a doc about this, and make a md in docs and link it here, by mentioning the doc and how/where to use it

## Chat JSON Inspection

- For raw Codex chat/thread JSON from local Codex sessions (`~/.codex/sessions`), use `/Users/omshejul/Code/CodexApp/docs/CODEX_CHAT_JSON.md`.
- Default workflow: if user shares a screenshot/text snippet, search that snippet in `~/.codex/sessions` first to find the exact chat file.
- Use it when you need user/assistant message JSONL or to locate a session by thread ID.

## Useful Docs

- `docs/mac-gateway-reliability.md`: Use for mac menu gateway reliability issues (sleep/wake behavior, launchd supervision, port conflict diagnosis, local network prompt timing).
