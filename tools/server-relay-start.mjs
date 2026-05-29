import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createPairingCode, createPairingPayload } from './pairing-code.mjs';
import { displayPairingCode } from './pairing-display.mjs';
import {
  buildServerRelayConfigFromEnv,
  loadServerRelayConfig,
  resolveServerRelayConfigPath,
  saveServerRelayConfig
} from './server-relay-config.mjs';

const configPath = resolveServerRelayConfigPath();
const existingConfig = loadServerRelayConfig(configPath);
const config = buildServerRelayConfigFromEnv(existingConfig);
const port = config.relay_port;
const host = config.relay_host;
const publicWsUrl = config.public_ws_url;
const publicHttpUrl = config.public_http_url;
const allowInsecureServerRelay = config.allow_insecure_server_relay === '1';
const pairingToken = config.pairing_token || `cmc_${randomBytes(32).toString('base64url')}`;
const hostToken = config.host_token || `cmc_host_${randomBytes(32).toString('base64url')}`;
const sqlitePath = config.sqlite_path || '.relay/relay.sqlite';

if (!publicWsUrl) {
  throw new Error('Set RELAY_PUBLIC_WS_URL to the server WebSocket URL, for example wss://relay.example.com.');
}

if (!publicWsUrl.startsWith('ws://') && !publicWsUrl.startsWith('wss://')) {
  throw new Error('RELAY_PUBLIC_WS_URL must start with ws:// or wss://.');
}

if (!allowInsecureServerRelay && !publicWsUrl.startsWith('wss://')) {
  throw new Error('Server Relay public URL must use wss://. Set CMC_ALLOW_INSECURE_SERVER_RELAY=1 only for local verification.');
}

if (publicHttpUrl && !publicHttpUrl.startsWith('http://') && !publicHttpUrl.startsWith('https://')) {
  throw new Error('RELAY_PUBLIC_HTTP_URL must start with http:// or https://.');
}

const pairingCode = createPairingCode(createPairingPayload({
  relayUrl: publicWsUrl,
  pairingToken
}));

const savedConfigPath = saveServerRelayConfig({
  ...config,
  pairing_token: pairingToken,
  host_token: hostToken,
  sqlite_path: sqlitePath
}, configPath);

console.log('[server-relay] Starting Codex Mobile Companion Relay.');
console.log(`[server-relay] Config: ${savedConfigPath}`);
console.log(`[server-relay] Listen: ${host}:${port}`);
console.log(`[server-relay] Public WebSocket URL: ${publicWsUrl}`);
if (publicHttpUrl) {
  console.log(`[server-relay] Public HTTP URL: ${publicHttpUrl}`);
}
console.log(`[server-relay] Pairing token: ${pairingToken}`);
console.log(`[server-relay] Host token: ${hostToken}`);
console.log(`[server-relay] SQLite path: ${sqlitePath}`);
console.log('');
console.log('[server-relay] Android pairing code:');
console.log(pairingCode);
console.log('');
await displayPairingCode({
  pairingCode,
  relayUrl: publicWsUrl,
  title: 'Codex Mobile Companion Server Relay Pairing',
  mode: config.pairing_qr ?? process.env.CMC_PAIRING_QR ?? 'both'
});
console.log('');
console.log('[server-relay] Keep this process running. Use RELAY_HOST_TOKEN for Host Bridge nodes; the Android pairing code contains only the pairing token.');
console.log('');

const child = spawn('node', ['relay/service/server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    RELAY_HOST: host,
    RELAY_PORT: port,
    RELAY_PAIRING_TOKEN: pairingToken,
    RELAY_HOST_TOKEN: hostToken,
    RELAY_SQLITE_PATH: sqlitePath,
    RELAY_PUBLIC_WS_URL: publicWsUrl,
    ...(publicHttpUrl ? { RELAY_PUBLIC_HTTP_URL: publicHttpUrl } : {}),
    ...(allowInsecureServerRelay ? { CMC_ALLOW_INSECURE_SERVER_RELAY: '1' } : {})
  },
  stdio: 'inherit'
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (child && !child.killed) {
    child.kill(signal);
  }
  setTimeout(() => {
    process.exit(0);
  }, 1000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

child.on('exit', (code, signal) => {
  if (shuttingDown) {
    process.exit(0);
    return;
  }

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
