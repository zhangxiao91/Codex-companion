# Codex Mobile Companion

Android-first control plane for Codex sessions.

This project is not a mobile IDE. It is a phone-first information relay for commute-time and away-from-keyboard work:
- view active and historical Codex sessions
- send lightweight prompts
- handle approvals
- inspect Git status and diffs
- receive high-value notifications
- keep the local PC or server host as the only place that actually touches repos, shell, and Codex runtime state

## Current shape

The system now has three main pieces:

- Android app: session inbox, timeline, prompt composer, tools, notifications, pairing UI
- Relay: auth, pairing, host registry, routing, session archive, timeline cache, notification fanout, Git audit, queue state, SQLite persistence
- Host Bridge: connects a PC or server host to Relay and talks to Codex/App Server/Git on the host side

## What it can do now

- Pair Android to a local PC or a server Relay
- Keep session history visible even when a host is offline
- Replay cached timeline pages with cursor-based pagination
- Use Relay-owned cloud incremental sync so reconnects check dirty sessions before requesting timeline pages
- Send prompts to an online host
- Queue simple follow-up prompts
- Pick up new/updated Codex App sessions from Host Bridge polling without restarting the bridge
- Show approval requests and completion / needs-input / host-offline notifications
- Show Git status, diff summary, file diffs, commit confirmation, and push confirmation
- Persist devices, hosts, sessions, timeline cache, queue state, approvals, notifications, and Git audit metadata in SQLite
- Persist per-device session sync acknowledgements in SQLite, so clean sessions are skipped after reconnect/restart
- Keep a trusted host/device identity model instead of re-pairing every time

## Recommended topology

### Local dev

Use this when the host bridge runs on your PC:

```powershell
npm run local
```

`npm run dev:pair` is kept as the explicit alias.

```powershell
npm run dev:pair
```

This starts a local Relay, a local Host Bridge, and prints:
- a copyable `cmc1...` pairing code
- a terminal QR code
- a local HTML pairing page under `.relay/pairing/`

### Server Relay

Use this when Android should connect over the internet or campus/public network:

```powershell
npm run server:relay:init
npm run server:up
```

Then start a host bridge from the PC:

```powershell
npm run connect
```

`npm run connect` reads saved server / Windows bridge config and saved host device trust, so after the first successful trust setup you usually do not need to pass `RELAY_URL` or `RELAY_HOST_TOKEN` again. `npm run server:bridge` remains the explicit alias.

For one-step Windows host startup:

```powershell
npm run bridge:windows:install
npm run bridge:windows:start
```

To show the Android pairing QR/code again from saved server config:

```powershell
npm run pair
```

To diagnose the current connection without changing state:

```powershell
npm run doctor
```

The doctor checks saved config, Relay `/health`, WebSocket upgrade, online host count, pairing-code readiness, Windows auto-start, and the recent Host Bridge log. `npm run status` is the same command with a shorter name.

Long-running workflow during fast iteration:

```powershell
# server
npm run server:up

# PC
npm run connect

# if something looks wrong
npm run doctor

# Android
# scan or paste the code from npm run pair only when pairing changes
```

### One-command updates

Server Relay:

```bash
npm run server:update
```

Default behavior:

- refuses to run if the Git worktree has local changes
- runs `git fetch --prune`
- runs `git pull --ff-only`
- runs `npm ci`
- runs lightweight Node syntax checks
- restarts Relay in a `screen` session named `codex-companion-relay`

Useful options:

```bash
npm run server:update -- --dry-run
npm run server:update -- --skip-restart
npm run server:update -- --allow-dirty
```

Server environment knobs:

```bash
export CMC_SERVER_RELAY_SCREEN_NAME=codex-companion-relay
export CMC_SERVER_RELAY_LOG_PATH=.relay/server-relay-screen.log
```

Windows Host Bridge:

```powershell
npm run bridge:update
```

Default behavior:

- refuses to run if the Git worktree has local changes
- runs `git fetch --prune`
- runs `git pull --ff-only`
- runs `npm ci`
- runs lightweight Node syntax checks
- stops the Windows scheduled task if it is running
- starts the Windows Host Bridge scheduled task again

Useful options:

```powershell
npm run bridge:update -- --dry-run
npm run bridge:update -- --skip-restart
npm run bridge:update -- --allow-dirty
```

## Pairing

The current pairing flow supports:
- QR code
- pasted `cmc1...` pairing code
- manual Relay URL + pairing token entry

The pairing code currently contains the Relay URL and pairing token. That is still a development-friendly model, not a final security design.

## Security model

Current baseline:
- pairing token and host token are separate in server mode
- device tokens are minted through `/pair`
- Host Bridge tokens are scoped to host registration and host-side messages
- Relay stores metadata, not source code or long-lived execution secrets
- dangerous actions stay gated on the host side

Still to improve:
- one-time pairing nonce
- stronger public-network hardening
- true push wakeup
- tighter rate limiting and secret redaction

## Approval retention

Relay persists active and resolved approvals in SQLite. Defaults:

- pending approvals: retained for 7 days
- resolved approvals: retained for 24 hours
- cleanup interval: 1 hour

Override with:

```powershell
$env:RELAY_APPROVAL_PENDING_TTL_MS='604800000'
$env:RELAY_APPROVAL_RESOLVED_TTL_MS='86400000'
$env:RELAY_APPROVAL_CLEANUP_INTERVAL_MS='3600000'
```

## Sync behavior

Current Android builds prefer the Relay sync index when the server supports it:

- Android asks Relay for `session.sync.index` after connecting.
- Relay compares session revisions / timeline cursors against this device's last ack.
- Normal reconnects request dirty sessions first, then a small priority set: selected, active, needs-input, and recent sessions.
- Android only requests timeline pages for dirty/priority sessions or sessions the user opens.
- Manual refresh can still run a fuller clean-session refresh when needed.
- After Room persistence, Android sends `session.sync.ack`.
- Archive and pin are now stored per Android device in Relay sync state and restored from the sync index.
- If the Relay is older and rejects the sync-index message, Android falls back to the previous local heuristic sync.

This is meant to make reconnecting with dozens of sessions much faster and less timeout-prone.

Host Bridge also polls Codex App Server for new or changed sessions every 5 seconds by default, then publishes changed `session.snapshot` messages to Relay. Tune with:

```powershell
$env:CMC_SESSION_POLL_INTERVAL_MS='5000'
$env:CMC_SESSION_LIST_LIMIT='50'
```

## Docs

- [docs/architecture.md](docs/architecture.md)
- [docs/implementation-plan.md](docs/implementation-plan.md)
- [docs/server-relay-plan.md](docs/server-relay-plan.md)
- [docs/cloud-incremental-sync-refactor.md](docs/cloud-incremental-sync-refactor.md)
- [docs/progress.md](docs/progress.md)
- [codex-mobile-android-analysis.md](codex-mobile-android-analysis.md)

## Validation

Common checks:

```powershell
npm run verify:delivery-strategy
npm run verify:relay-offline-host-sessions
npm run verify:relay-sqlite-persistence
npm run verify:relay-sync-cursor-gap
npm run verify:relay-sync-index
npm run verify:relay-cloud-archive-pin
npm run verify:notification-events
npm run verify:rich-prompt-flow
cd android
.\gradlew.bat :app:assembleDebug --no-daemon
```

## CI/CD

The first CI pass lives in `.github/workflows/ci.yml`.

On push, pull request, or manual workflow dispatch it:

- installs Node dependencies with `npm ci`
- runs `npm run ci:node`
- installs Android SDK 36 / build tools 36.0.0
- builds `:app:assembleDebug`
- runs `:app:testDebugUnitTest`
- uploads `app-debug.apk` as the `codex-mobile-companion-debug-apk` artifact

This is intentionally continuous delivery, not automatic deployment. Server Relay and Host Bridge are not restarted by CI yet, so a failed or bad build cannot interrupt an active Codex session.

### Download CI APK artifacts

Every successful CI run uploads `codex-mobile-companion-debug-apk`.

From the GitHub UI:

1. Open the repository Actions tab.
2. Open the latest successful `CI` workflow run.
3. Download the `codex-mobile-companion-debug-apk` artifact.
4. Install the APK on Android.

From a machine with GitHub CLI:

```powershell
gh auth login
npm run artifact:apk
```

The APK downloads to `.relay/artifacts/latest-apk/` by default.

Useful options:

```powershell
npm run artifact:apk -- --branch master
npm run artifact:apk -- --run <github-actions-run-id>
npm run artifact:apk -- --dest .relay/artifacts/manual
```

### GitHub Releases

Release builds live in `.github/workflows/release.yml`.

To publish a release APK:

```powershell
git tag v0.1.0-alpha.1
git push origin v0.1.0-alpha.1
```

The Release workflow builds the debug APK, uploads it as an Actions artifact, then creates or updates a GitHub Release and attaches:

```text
codex-mobile-companion-<tag>-debug.apk
```

Use Actions artifacts for fast internal iteration. Use GitHub Releases when you want a stable APK link for a known tag.

Node/Relay/Bridge version metadata:

- Relay `/health` now includes `version.relay` and `version.protocol`
- Host Bridge registers and heartbeats with `bridge_version` and `protocol_version`
- Android diagnostics show Android, Relay, and Host Bridge version/protocol metadata
- Android shows a suggested update warning when Relay/Host versions or protocol versions are out of sync

## Notes

- Offline host history is retained and replayable.
- New prompts still require the owning Host Bridge to be online.
- The current product direction is server Relay first, not direct LAN-only phone-to-PC coupling.
