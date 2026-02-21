# Official OpenAI Codex App Server: Deep Reference

This document explains the **official OpenAI Codex App Server** protocol and integration model in depth.

It intentionally does **not** describe this repository's gateway/mobile architecture.

---

## 1) Canonical Sources (Read These First)

Primary docs:
- [Codex App Server docs](https://developers.openai.com/codex/app-server)
- [Codex CLI docs](https://developers.openai.com/codex/cli/)
- [Codex SDK docs](https://developers.openai.com/codex/sdk/)
- [Codex advanced config](https://developers.openai.com/codex/config-advanced/)

Architecture context from OpenAI:
- [Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/)

Most precise source for your exact installed binary version:
- `codex app-server generate-ts --out <dir>`
- `codex app-server generate-json-schema --out <dir>`

Those generated artifacts are version-pinned and are the best source for exact request/response contracts.

---

## 2) What App Server Is

Codex App Server is a **bidirectional JSON-RPC 2.0** interface over local transports that exposes Codex thread/turn lifecycle, events, approvals, auth/account flows, tools, and config surfaces.

Think of it as:
- a local protocol boundary around Codex core/harness,
- used by first-party clients (Desktop, IDE integrations, CLI/TUI migration path),
- and available for custom client integrations.

What it is not:
- not a public internet API endpoint,
- not a hosted multi-tenant service,
- not a replacement for Codex SDK in automation/CI workflows.

---

## 3) Transports and Runtime Model

From the official docs and CLI help:
- `stdio://` (default): newline-delimited JSON (JSONL).
- `ws://IP:PORT` (experimental): one JSON-RPC message per WS text frame.

Examples:
```bash
# stdio mode (default)
codex app-server

# websocket mode
codex app-server --listen ws://127.0.0.1:4500
```

Important WebSocket behavior (official docs):
- Request ingress is queue-bounded.
- When overloaded, server returns JSON-RPC error code `-32001` with message `Server overloaded; retry later.`
- Client should retry with exponential backoff + jitter.

---

## 4) JSON-RPC Semantics (Critical)

App Server uses three message directions:

1. Client -> Server requests (`id`, `method`, `params`)
2. Server -> Client responses (`id`, `result` or `error`)
3. Server -> Client notifications (`method`, `params`, no `id`)

Plus one often-missed path:

4. **Server -> Client requests** (`id`, `method`, `params`) for approvals / user input / tool handling.  
   The client must send matching responses.

If your client only handles notifications + normal responses, approval-gated turns can hang/fail.

---

## 5) Connection Lifecycle and Handshake

Official handshake requirements:

1. Connect transport.
2. Send one `initialize` request.
3. Wait for `initialize` response.
4. Send `initialized` notification.
5. Start normal requests (`thread/*`, `turn/*`, etc.).

Server behavior documented by OpenAI:
- Requests before initialize are rejected (`Not initialized`).
- Repeated initialize on same connection is rejected (`Already initialized`).

`initialize.params` includes:
- `clientInfo` (name/title/version; identify your integration)
- optional `capabilities`:
  - `experimentalApi: boolean`
  - `optOutNotificationMethods: string[] | null` (exact method-name matching)

---

## 6) Data Model: Thread, Turn, Item

### Thread
Durable session container with metadata (id, preview, cwd, source, model provider, created/updated times, etc.).

### Turn
One unit of user-initiated work in a thread (`inProgress`, `completed`, `failed`, `interrupted`).

### Item
Granular streamed units within a turn (agent deltas, tool progress, command output, plan updates, etc.).

---

## 7) Modern Core API (`thread/*`, `turn/*`)

### Thread lifecycle
- `thread/start`: create a new thread session.
- `thread/resume`: reopen existing thread by id.
- `thread/fork`: branch history into a new thread id.
- `thread/read`: read persisted thread without resuming/subscribing.
- `thread/list`: list persisted threads with cursor filters.
- `thread/loaded/list`: list currently loaded in-memory thread ids.
- `thread/archive`: archive persisted thread log.
- `thread/unarchive`: restore archived thread.
- `thread/compact/start`: trigger context compaction.
- `thread/rollback`: rollback thread state.
- `thread/name/set`: set thread name.

### Turn lifecycle
- `turn/start`: begin generation for user input.
- `turn/steer`: append input to active in-flight turn.
- `turn/interrupt`: cancel in-flight turn.

### Practical request/response shapes

`thread/list` response:
- `result.data: Thread[]`
- `result.nextCursor: string | null`

`thread/read` response:
- `result.thread: Thread`

`turn/start` response:
- `result.turn: Turn`

`thread/read` vs `thread/resume`:
- `thread/read` reads stored data and does not resume/subscribe.
- `thread/resume` loads the thread into active session state for continued turns.

---

## 8) Turn Input and Overrides

Turn input supports a list of typed inputs. Official docs/examples show:
- `text`
- `image`
- `localImage`
- `skill`
- `mention`

Turn-level overrides may include model/effort/personality/cwd/sandbox/approval policy/output schema.

Documented behavior:
- Turn-level overrides can become defaults for later turns on that thread.
- `outputSchema` applies only to current turn.

`turn/steer` constraints (official docs):
- must include `expectedTurnId`
- fails when no active turn exists
- does not emit a new `turn/started`
- does not accept turn-level overrides like model/cwd/sandbox/outputSchema

---

## 9) Event Stream (Server Notifications)

Common event flow for a turn:
- `turn/started`
- `item/started`
- streaming deltas/progress (`item/agentMessage/delta`, tool output/progress, plan deltas)
- `item/completed`
- `turn/completed`

The generated protocol for `codex-cli 0.104.0` includes notifications such as:
- `thread/started`, `thread/archived`, `thread/unarchived`, `thread/name/updated`, `thread/tokenUsage/updated`, `thread/compacted`
- `turn/started`, `turn/completed`, `turn/diff/updated`, `turn/plan/updated`
- `item/started`, `item/completed`, `rawResponseItem/completed`
- `item/agentMessage/delta`, `item/plan/delta`
- `item/commandExecution/outputDelta`, `item/commandExecution/terminalInteraction`
- `item/fileChange/outputDelta`, `item/mcpToolCall/progress`
- account/app/config/fuzzy-search warnings and updates

---

## 10) Approvals and Server-Initiated Requests

Depending on user policy/settings, App Server can request client approval before continuing command/file/tool actions.

Officially documented command/file approval behavior:
- command decisions: `accept`, `acceptForSession`, `decline`, `cancel`, or amendment object
- file-change decisions: `accept`, `acceptForSession`, `decline`, `cancel`

Generated server-request methods (`codex-cli 0.104.0`):
- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/tool/requestUserInput`
- `item/tool/call`
- `account/chatgptAuthTokens/refresh`
- `applyPatchApproval`
- `execCommandApproval`

Implementation requirement:
- Correlate by `id`.
- Respond with result or error.
- Scope UI state using `threadId` + `turnId` fields where provided.

---

## 11) Error Model and Reliability

From official docs:
- Turn failures emit `error` notification payload and complete turn with `status: "failed"`.
- Error metadata may include codex categories (`ContextWindowExceeded`, `UsageLimitExceeded`, `Unauthorized`, `SandboxError`, etc.) and upstream HTTP status where available.

Client guidance:
- Treat transport drop as recoverable: reconnect and re-handshake.
- Backoff retries for transient errors (especially WS `-32001` overload).
- Make operations idempotent at app layer where possible.
- Handle out-of-order notifications defensively.

---

## 12) Auth/Account Surface in App Server

Official docs expose auth/account methods and notifications for local client login state:
- `account/read`
- `account/login/start`
- `account/login/cancel`
- `account/logout`
- `account/rateLimits/read`
- notifications like `account/login/completed`, `account/updated`, `account/rateLimits/updated`

Authentication modes documented:
- `apikey`
- `chatgpt`
- `chatgptAuthTokens`

---

## 13) Legacy Conversation APIs (Compatibility)

Generated protocol still includes older conversation methods in many versions:
- `newConversation`, `resumeConversation`, `listConversations`, `sendUserMessage`, `sendUserTurn`, etc.

Modern integrations should prefer `thread/*` + `turn/*` unless you explicitly target legacy client behavior.

---

## 14) Full Method Inventory (Generated, `codex-cli 0.104.0`)

### Client request methods
`initialize`, `thread/start`, `thread/resume`, `thread/fork`, `thread/archive`, `thread/name/set`, `thread/unarchive`, `thread/compact/start`, `thread/rollback`, `thread/list`, `thread/loaded/list`, `thread/read`, `skills/list`, `skills/remote/list`, `skills/remote/export`, `app/list`, `skills/config/write`, `turn/start`, `turn/steer`, `turn/interrupt`, `review/start`, `model/list`, `experimentalFeature/list`, `mcpServer/oauth/login`, `config/mcpServer/reload`, `mcpServerStatus/list`, `account/login/start`, `account/login/cancel`, `account/logout`, `account/rateLimits/read`, `feedback/upload`, `command/exec`, `config/read`, `config/value/write`, `config/batchWrite`, `configRequirements/read`, `account/read`, `newConversation`, `getConversationSummary`, `listConversations`, `resumeConversation`, `forkConversation`, `archiveConversation`, `sendUserMessage`, `sendUserTurn`, `interruptConversation`, `addConversationListener`, `removeConversationListener`, `gitDiffToRemote`, `loginApiKey`, `loginChatGpt`, `cancelLoginChatGpt`, `logoutChatGpt`, `getAuthStatus`, `getUserSavedConfig`, `setDefaultModel`, `getUserAgent`, `userInfo`, `fuzzyFileSearch`, `execOneOffCommand`.

### Server notification methods
`error`, `thread/started`, `thread/archived`, `thread/unarchived`, `thread/name/updated`, `thread/tokenUsage/updated`, `turn/started`, `turn/completed`, `turn/diff/updated`, `turn/plan/updated`, `item/started`, `item/completed`, `rawResponseItem/completed`, `item/agentMessage/delta`, `item/plan/delta`, `item/commandExecution/outputDelta`, `item/commandExecution/terminalInteraction`, `item/fileChange/outputDelta`, `item/mcpToolCall/progress`, `mcpServer/oauthLogin/completed`, `account/updated`, `account/rateLimits/updated`, `app/list/updated`, `item/reasoning/summaryTextDelta`, `item/reasoning/summaryPartAdded`, `item/reasoning/textDelta`, `thread/compacted`, `model/rerouted`, `deprecationNotice`, `configWarning`, `fuzzyFileSearch/sessionUpdated`, `fuzzyFileSearch/sessionCompleted`, `windows/worldWritableWarning`, `account/login/completed`, `authStatusChange`, `loginChatGptComplete`, `sessionConfigured`.

### Server-initiated request methods
`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/tool/requestUserInput`, `item/tool/call`, `account/chatgptAuthTokens/refresh`, `applyPatchApproval`, `execCommandApproval`.

---

## 15) How Official Clients Use It (Architecture Pattern)

From OpenAI’s App Server architecture writeup:
- Local clients (Desktop/IDE style) typically launch App Server as a child process and communicate over stdio JSONL.
- Web runtime hosts App Server inside backend/container workers and relays updates to browser over web transport.
- The protocol is used as the unifying harness boundary across surfaces.

Design implication for custom clients:
- Keep your client thin and protocol-driven.
- Let App Server own thread/turn semantics and approval orchestration.

---

## 16) Recommended Integration Blueprint

1. Launch/attach to app-server (prefer local-only bind for WS).
2. Run strict initialize handshake.
3. Maintain one reliable JSON-RPC session manager with:
   - request id correlation
   - notification dispatch
   - server-request handling
4. Implement thread browser (`thread/list`, `thread/read`).
5. Implement active conversation (`thread/resume`, `turn/start`, `turn/steer`, `turn/interrupt`).
6. Stream and render events incrementally.
7. Handle approval requests and auth/account notifications.
8. Add retry/backoff and reconnect logic.
9. Regenerate schema on CLI upgrades and run compatibility tests.

---

## 17) Versioning Strategy

App Server is actively evolving. To stay stable:
- Pin a tested `codex-cli` version.
- Generate TS/JSON schema artifacts in CI.
- Validate your adapters against generated contracts.
- Keep feature flags and fallbacks for protocol drift.

---

## 18) Quick Commands You’ll Actually Use

```bash
# Show app-server options
codex app-server --help

# Start stdio server (default)
codex app-server

# Start websocket server
codex app-server --listen ws://127.0.0.1:4500

# Generate version-pinned protocol artifacts
codex app-server generate-ts --out ./schemas
codex app-server generate-json-schema --out ./schemas
```

---

## 19) End-to-End JSON-RPC Example (WebSocket)

Below is a minimal practical flow.

### 1. Initialize

Client request:
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"my-client","version":"1.0.0"},"capabilities":null}}
```

Server response:
```json
{"jsonrpc":"2.0","id":1,"result":{"userAgent":"Codex Desktop/..."}}
```

Client notification:
```json
{"jsonrpc":"2.0","method":"initialized"}
```

### 2. List threads

Request:
```json
{"jsonrpc":"2.0","id":2,"method":"thread/list","params":{"limit":20}}
```

Typical response shape:
```json
{"jsonrpc":"2.0","id":2,"result":{"data":[{"id":"...","preview":"...","updatedAt":1739964585}],"nextCursor":"opaque-or-null"}}
```

### 3. Read + resume a thread

Read:
```json
{"jsonrpc":"2.0","id":3,"method":"thread/read","params":{"threadId":"<thread-id>","includeTurns":true}}
```

Resume:
```json
{"jsonrpc":"2.0","id":4,"method":"thread/resume","params":{"threadId":"<thread-id>","approvalPolicy":"never","persistExtendedHistory":true}}
```

### 4. Start a turn

Request:
```json
{"jsonrpc":"2.0","id":5,"method":"turn/start","params":{"threadId":"<thread-id>","input":[{"type":"text","text":"Summarize the latest errors","text_elements":[]}],"approvalPolicy":"never"}}
```

Response:
```json
{"jsonrpc":"2.0","id":5,"result":{"turn":{"id":"<turn-id>","status":"inProgress","items":[],"error":null}}}
```

### 5. Stream notifications

Examples you may receive (no `id`):
```json
{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"<thread-id>","turn":{"id":"<turn-id>","status":"inProgress"}}}
{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"threadId":"<thread-id>","turnId":"<turn-id>","itemId":"<item-id>","delta":"Hello"}}
{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"<thread-id>","turn":{"id":"<turn-id>","status":"completed"}}}
```

### 6. Handle server-initiated approval request

Server request example:
```json
{"jsonrpc":"2.0","id":98,"method":"item/commandExecution/requestApproval","params":{"threadId":"<thread-id>","turnId":"<turn-id>","...":"..."}}
```

Client response example:
```json
{"jsonrpc":"2.0","id":98,"result":{"decision":"accept"}}
```

If unsupported, return a JSON-RPC error response for that `id` instead of dropping it.

---

## 20) Where To Go For More Detail

- Detailed API walkthroughs and examples: [Codex App Server docs](https://developers.openai.com/codex/app-server)
- CLI behavior and options around Codex usage: [Codex CLI docs](https://developers.openai.com/codex/cli/)
- Config/sandbox/approval policy behavior: [Advanced config](https://developers.openai.com/codex/config-advanced/)
- Programmatic automation alternative: [Codex SDK](https://developers.openai.com/codex/sdk/)
- Design rationale and cross-client architecture: [Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/)
