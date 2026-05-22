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
$env:RELAY_PAIRING_TOKEN='choose-a-long-random-pairing-token'
$env:RELAY_HOST_TOKEN='choose-a-different-long-random-host-token'
npm run server:relay
```

The helper starts Relay bound to `127.0.0.1` by default and prints a `cmc1...` pairing code for Android. It now also prints a terminal QR code and writes a local HTML pairing page in `.relay/pairing/pairing.html`. The pairing code contains only `RELAY_PAIRING_TOKEN`; Host Bridge nodes must use `RELAY_HOST_TOKEN`. It keeps the current Android pairing payload unchanged; HTTPS/WSS termination must be provided by a reverse proxy in front of the Node process. QR output can be controlled with `CMC_PAIRING_QR=both` (default), `terminal`, `html`, or `none`.

### HTTPS/WSS Reverse Proxy

Production-like server access should terminate TLS before Relay. Keep the Node Relay bound to localhost, expose only the reverse proxy to the public network, and forward both HTTP `/health`/`/pair` and WebSocket upgrade traffic to the same local port.

Firewall baseline:

- Allow public `443/tcp` for HTTPS/WSS.
- Allow SSH from trusted IPs.
- Do not expose `8787/tcp` to the public internet.
- Keep Host Bridge on PCs and devboxes outbound-only; it connects to `wss://relay.example.com`.

Recommended server layout:

```text
Android / Host Bridge
  -> https://relay.example.com / wss://relay.example.com
      -> reverse proxy with TLS
          -> 127.0.0.1:8787 Relay
```

Caddy example:

```caddyfile
relay.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

Nginx example:

```nginx
server {
  listen 443 ssl http2;
  server_name relay.example.com;

  ssl_certificate /etc/letsencrypt/live/relay.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
  }
}
```

Relay command behind the proxy:

First run:

```powershell
$env:RELAY_HOST='127.0.0.1'
$env:RELAY_PORT='8787'
$env:RELAY_PUBLIC_WS_URL='wss://relay.example.com'
$env:RELAY_PUBLIC_HTTP_URL='https://relay.example.com'
$env:RELAY_SQLITE_PATH='C:\cmc\relay.sqlite'
npm run server:relay:init
```

Later runs:

```powershell
npm run server:relay
```

You can override the config path with `CMC_SERVER_RELAY_CONFIG`. The default path is `.relay/server-relay-config.json`.

Direct environment-only run:

```powershell
$env:RELAY_HOST='127.0.0.1'
$env:RELAY_PORT='8787'
$env:RELAY_PUBLIC_WS_URL='wss://relay.example.com'
$env:RELAY_PUBLIC_HTTP_URL='https://relay.example.com'
$env:RELAY_PAIRING_TOKEN='use-a-long-random-pairing-secret'
$env:RELAY_HOST_TOKEN='use-a-different-long-random-host-secret'
$env:RELAY_SQLITE_PATH='C:\cmc\relay.sqlite'
npm run server:relay
```

Host Bridge command from a PC or server node:

```powershell
$env:RELAY_URL='wss://relay.example.com'
$env:RELAY_HOST_TOKEN='use-the-host-token-issued-for-this-node'
$env:HOST_ID='local-pc'
$env:HOST_NAME='Local PC'
$env:CODEX_ADAPTER='app-server'
npm run server:bridge
```

The current first-pass server token model separates pairing and host auth:

- `RELAY_PAIRING_TOKEN` can call `/pair` and mint a device token.
- `RELAY_HOST_TOKEN` can register hosts and send host-side messages.
- Device tokens authorize Android/client WebSocket control messages after pairing.
- `RELAY_DEV_TOKEN` remains a local development fallback, but should not be used as the recommended server deployment shape.

### Device Management

Server Relay exposes a small admin surface for trusted device management:

- `GET /devices` lists active Android devices and trusted Host Bridge devices.
- `GET /devices?include_revoked=1` also includes revoked entries.
- `POST /devices/revoke` revokes either an Android `device_id` or a Host Bridge `host_device_id`.

Admin requests require a Relay secret (`RELAY_HOST_TOKEN`, `RELAY_PAIRING_TOKEN`, `RELAY_DEV_TOKEN`, or `RELAY_ADMIN_TOKEN` through the CLI). Ordinary Android device tokens are not accepted for device administration.

CLI usage:

```powershell
$env:RELAY_PUBLIC_HTTP_URL='https://relay.example.com'
$env:RELAY_ADMIN_TOKEN='use-a-relay-admin-secret'
npm run server:devices -- list
npm run server:devices -- list --all
npm run server:devices -- revoke android <device_id>
npm run server:devices -- revoke host <host_device_id>
```

Revoking an Android device removes it from the in-memory auth set and marks it revoked in SQLite, so existing WebSocket reconnects with that device token are rejected. Revoking a host device marks its saved Host Bridge trust token revoked; the bridge must be started once with `RELAY_HOST_TOKEN` to establish a new trusted host-device token.

Before broader public exposure, replace the long-lived pairing token with a short-lived one-time pairing code, add token rotation UX, and add rate limits for pairing/admin failures.

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

For a full server Relay smoke test, use:

```powershell
$env:RELAY_PUBLIC_HTTP_URL='https://relay.example.com'
$env:RELAY_PUBLIC_WS_URL='wss://relay.example.com'
$env:RELAY_PAIRING_TOKEN='use-the-current-pairing-secret'
$env:RELAY_HOST_TOKEN='use-the-current-host-secret'
npm run server:smoke
```

The smoke test verifies `/health`, `/pair`, device-token authorized health diagnostics, WebSocket host registration, session visibility, prompt routing to the host, and timeline event return to the client. For local deterministic validation without a real server, run:

```powershell
npm run verify:server-smoke-local
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

Current status:

- SQLite persistence is now in place for paired devices, known hosts, session snapshots, timeline events, and Git audit events.
- Android device trust and Host Bridge device trust can be listed and revoked through `npm run server:devices`.
- The database path is configurable with `RELAY_SQLITE_PATH`; the default is `.relay/relay.sqlite`.
- Existing JSON identity and NDJSON Git audit files are still read as migration inputs when SQLite is empty.
- Restart verification is available through `npm run verify:relay-sqlite-persistence`.

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
5. Persist paired devices and host metadata across Relay restarts. Completed in first pass with the JSON identity store.

First-pass verification:

```powershell
npm run verify:server-pairing-code
npm run verify:relay-public-url
npm run verify:server-relay-start
npm run verify:server-bridge-start
npm run verify:relay-identity-storage
npm run verify:relay-token-separation
npm run verify:dev-pairing-code
```

Result:

```text
[verify] Server pairing code generation verified.
[verify] Relay public URL health metadata verified.
[verify] Server Relay startup helper verified.
[verify] Server Host Bridge startup helper verified.
[verify] Relay identity storage verified.
[verify] Relay pairing/host/device token separation verified.
[verify] Dev pairing code generation verified.
```
