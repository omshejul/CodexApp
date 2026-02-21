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
- Use:

```bash
SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
NOTARYTOOL_PROFILE="codex-notary" \
/Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/scripts/build_app.sh --release
```

- Do not use unsigned build output for normal release/distribution workflows.

## Change Hygiene

- Keep commits focused and small.
- Include only files related to the requested change.
- Run the narrowest verification that proves the change works.

## Run/Restart Guidance

- For macOS app changes, keep restart guidance minimal.
- Say only: rebuild using `/Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/scripts/build_app.sh`.

- For Metro Restart say to run  `npx expo start --dev-client --clear`
- For build/reinstall iOS app say to run  `npx expo run:ios --device --no-bundler --configuration Debug`

If you think something is useful to be remembered for later and will save time instead of doing it again, ask user if they can make a doc about this, and make a md in docs and link it here, by mentioning the doc and how/where to use it