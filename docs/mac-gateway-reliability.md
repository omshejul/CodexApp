# macOS Gateway Reliability Runbook

Use this runbook when the menu app says gateway stopped, reports port conflicts, or local network permission prompts appear unexpectedly.

## What changed

- Gateway is supervised by `launchd` as a per-user `LaunchAgent`:
  `~/Library/LaunchAgents/com.codex.gateway.plist`
- `Start` writes/updates and starts the agent.
- `Stop` unloads the agent and removes the plist.
- The app treats a listener on `127.0.0.1:<port>` as "ours" when the PID command matches bundled gateway runtime (`GatewayRuntime/dist/server.js`), and as "other process" otherwise.
- Tailscale checks/serve setup now run on `Start` (not on app bootstrap/status checks).

## Expected behavior

- Closing the menu app does not stop gateway if launch agent is installed.
- After sleep/wake or app relaunch, status should show `Running` if our gateway PID is already on the configured port.
- "Stop Other Process" should only appear for non-gateway listeners on the same port.

## Operational checks

1. Verify launch agent exists:
   `ls -l ~/Library/LaunchAgents/com.codex.gateway.plist`
2. Verify launchd job state:
   `launchctl print gui/$(id -u)/com.codex.gateway`
3. Verify gateway health:
   `curl -sf http://127.0.0.1:8787/health`
4. Check launchd logs:
   `tail -n 200 ~/Library/Application\ Support/CodexGateway/logs/launchd-stdout.log`
   `tail -n 200 ~/Library/Application\ Support/CodexGateway/logs/launchd-stderr.log`

## Common scenarios

### Gateway looks stopped after overnight sleep

- Open menu app and click `Start`.
- If already running under launchd, the app should detect current listener and switch to `Running` without killing it.

### Local network permission prompt appears

- Prompt may appear when clicking `Start` because Tailscale checks/serve setup are initiated there.
- This is expected for first-time local network/Tailscale operations.

### "Another process is running"

- If the listed PID is not the bundled gateway command, use `Stop Other Process`.
- If this recurs, change gateway port in settings or stop the conflicting service.

## Rebuild guidance

For macOS app changes, rebuild using:

`/Users/omshejul/Code/CodexApp/mac/CodexGatewayMenu/scripts/build_app.sh`
