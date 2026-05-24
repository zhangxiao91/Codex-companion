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
- Send prompts to an online host
- Queue simple follow-up prompts
- Show approval requests and completion / needs-input / host-offline notifications
- Show Git status, diff summary, file diffs, commit confirmation, and push confirmation
- Persist devices, hosts, sessions, timeline cache, queue state, notifications, and Git audit metadata in SQLite
- Keep a trusted host/device identity model instead of re-pairing every time

## Recommended topology

### Local dev

Use this when the host bridge runs on your PC:

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
npm run server:relay
```

Then start a host bridge from the PC:

```powershell
$env:RELAY_URL='wss://relay.example.com'
$env:RELAY_HOST_TOKEN='choose-a-long-random-token'
npm run server:bridge
```

For one-step Windows host startup:

```powershell
npm run bridge:windows:install
npm run bridge:windows:start
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

## Docs

- [docs/architecture.md](docs/architecture.md)
- [docs/implementation-plan.md](docs/implementation-plan.md)
- [docs/server-relay-plan.md](docs/server-relay-plan.md)
- [docs/progress.md](docs/progress.md)
- [codex-mobile-android-analysis.md](codex-mobile-android-analysis.md)

## Validation

Common checks:

```powershell
npm run verify:delivery-strategy
npm run verify:relay-offline-host-sessions
npm run verify:relay-sqlite-persistence
npm run verify:notification-events
npm run verify:rich-prompt-flow
cd android
.\gradlew.bat :app:assembleDebug --no-daemon
```

## Notes

- Offline host history is retained and replayable.
- New prompts still require the owning Host Bridge to be online.
- The current product direction is server Relay first, not direct LAN-only phone-to-PC coupling.

