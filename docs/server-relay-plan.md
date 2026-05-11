# Server Relay Construction Plan

This document defines the next construction direction for Codex Mobile Companion: a server-hosted Relay as the default sync and auth service.

## Decision

Use a server Relay as the primary Android endpoint.

Android should connect to one stable server URL. Local PC, remote devbox, and the server itself should connect to that Relay as Host Bridge nodes. This avoids campus/LAN firewall complexity while keeping execution, repo access, Git credentials, and Codex runtime state inside Host Bridge.

## Target Shape

```text
Android App
  -> Server Relay
      -> Host Bridge on local PC
          -> local Codex App Server / Git / repo
      -> Host Bridge on server
          -> server Codex App Server / Git / repo
```

Relay owns:

- device pairing and device token validation
- host registration and host online state
- session snapshot routing
- timeline cursor/cache
- prompt routing
- approval request/decision routing
- Git request routing and metadata audit
- future push notification fanout

Relay must not own:

- source code storage
- raw terminal log storage
- OpenAI tokens
- GitHub tokens
- SSH keys
- direct shell execution

## Milestone 1: Deployable Server Relay

Goal: run Relay on the server and let Android connect to it.

Tasks:

- Add server runtime configuration:
  - `RELAY_PUBLIC_HTTP_URL`
  - `RELAY_PUBLIC_WS_URL`
  - `RELAY_HOST`
  - `RELAY_PORT`
  - token secrets
  - audit storage path
- Document reverse proxy setup for HTTPS/WSS.
- Keep local `npm run dev:pair` as a dev-only path.
- Add a server pairing flow that assumes Relay is already running on a stable URL.
- Add a smoke test for `/health`, `/pair`, and WebSocket auth against a non-local Relay URL.

Acceptance:

- Android can test health against the server Relay.
- Android can pair with the server Relay.
- A Node test client can subscribe through the server Relay.

Current helper:

```powershell
$env:RELAY_PUBLIC_WS_URL='wss://relay.example.com'
$env:RELAY_PUBLIC_HTTP_URL='https://relay.example.com'
$env:RELAY_DEV_TOKEN='choose-a-long-random-token'
npm run server:relay
```

The helper starts Relay and prints a `cmc1...` pairing code for Android. It keeps the current protocol unchanged; HTTPS/WSS termination can be provided by a reverse proxy in front of the Node process.

## Milestone 2: PC Host Through Server Relay

Goal: local PC no longer exposes Relay directly.

Tasks:

- Start Relay on server.
- Start Host Bridge on PC with `RELAY_URL=wss://<server>/...`.
- Host Bridge registers host and sends session snapshots.
- Android receives sessions from the server Relay.
- Android sends prompt through server Relay to the PC Host Bridge.

Acceptance:

- Phone on mobile network can see PC Codex sessions.
- Prompt reaches PC Host Bridge.
- Timeline events return to Android.
- PC firewall does not need inbound Relay access.

Current helper:

```powershell
$env:RELAY_URL='wss://relay.example.com'
$env:RELAY_HOST_TOKEN='choose-a-long-random-token'
$env:HOST_ID='local-pc'
$env:HOST_NAME='Local PC'
npm run server:bridge
```

For local deterministic verification, use:

```powershell
npm run verify:server-bridge-start
```

## Milestone 3: Durable Identity and Cursor State

Goal: Relay restart should not force full re-pairing.

Tasks:

- Persist paired devices.
- Persist host records.
- Persist host tokens or token hashes.
- Persist timeline cursor metadata and audit metadata.
- Keep timeline payload cache short-lived and redacted.
- Add migration path from current in-memory state.

Acceptance:

- Relay restart preserves device identity.
- Relay restart preserves known host identity.
- Android can reconnect and request missed events by cursor.

## Milestone 4: Server as Codex Host

Goal: the server can also run Codex and appear as a host.

Tasks:

- Run Host Bridge on the server as a separate process from Relay.
- Configure `CODEX_ADAPTER=app-server`.
- Start or connect to server-side Codex App Server.
- Register server host with a distinct `host_id`.
- Verify Android can switch between PC host and server host.

Acceptance:

- Android sees both local PC and server host.
- Android can open server-side sessions.
- Android can send prompt to server-side Codex.
- Approval and Git flows still route by owning host.

## Milestone 5: Security Hardening

Tasks:

- Enforce TLS/WSS outside local development.
- Replace long-lived pairing token with short-lived pairing code.
- Add device revocation.
- Add host token rotation.
- Add rate limits:
  - pairing
  - auth failures
  - prompt sends
  - approval decisions
  - Git actions
- Add metadata-only audit for:
  - prompt sent
  - approval decision
  - Git commit request
  - Git push request
- Keep Host Bridge policy checks as the final gate for dangerous operations.

Acceptance:

- A stolen pairing code expires quickly.
- A device token can be revoked.
- Relay logs enough metadata to answer who triggered what action.
- Relay still does not store source code or secrets.

## Immediate Next Step

Implement a server mode for the current Relay without changing the protocol:

1. Add public URL configuration. Completed in first pass with `RELAY_PUBLIC_HTTP_URL` and `RELAY_PUBLIC_WS_URL`.
2. Add a server pairing helper that emits a `cmc1...` code using the server URL. Completed in first pass with `npm run server:pairing-code`.
3. Add docs for running Relay behind HTTPS/WSS.
4. Verify Android can pair against that URL.

First-pass verification:

```powershell
npm run verify:server-pairing-code
npm run verify:relay-public-url
npm run verify:server-relay-start
npm run verify:server-bridge-start
npm run verify:dev-pairing-code
```

Result:

```text
[verify] Server pairing code generation verified.
[verify] Relay public URL health metadata verified.
[verify] Server Relay startup helper verified.
[verify] Server Host Bridge startup helper verified.
[verify] Dev pairing code generation verified.
```
