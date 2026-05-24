import { spawn } from 'node:child_process';
import { createHostIdentityStore } from '../bridge/host-bridge/host-identity-store.mjs';

const relayUrl = process.env.RELAY_PUBLIC_WS_URL
  ?? process.env.RELAY_URL;
const token = process.env.RELAY_HOST_TOKEN
  ?? process.env.RELAY_DEV_TOKEN
  ?? process.env.DEV_TOKEN;
const hostId = process.env.HOST_ID ?? 'local-dev-host';
const hostName = process.env.HOST_NAME ?? 'Local Development Host';
const adapter = process.env.CODEX_ADAPTER ?? 'app-server';
const hostIdentityStore = createHostIdentityStore();
const storedIdentity = hostIdentityStore.load();
const storedIdentityMatchesRelay = storedIdentity.relay_url === relayUrl;
const storedIdentityMatchesRelayOrigin = storedIdentity.relay_url === relayUrl || !storedIdentity.relay_url;

if (!relayUrl) {
  throw new Error('Set RELAY_URL or RELAY_PUBLIC_WS_URL to the server Relay WebSocket URL.');
}

if (!relayUrl.startsWith('ws://') && !relayUrl.startsWith('wss://')) {
  throw new Error('Relay URL must start with ws:// or wss://.');
}

if (!token && !storedIdentity.host_device_token) {
  throw new Error('Set RELAY_HOST_TOKEN for first-time Host Bridge trust, or keep an existing HOST_IDENTITY_PATH file.');
}
if (!token && storedIdentity.host_device_token && !storedIdentityMatchesRelayOrigin) {
  throw new Error(`Saved host identity was issued for ${storedIdentity.relay_url ?? 'a different Relay'}; start once with RELAY_HOST_TOKEN for ${relayUrl}.`);
}

console.log('[server-bridge] Starting Host Bridge against server Relay.');
console.log(`[server-bridge] Relay URL: ${relayUrl}`);
console.log(`[server-bridge] Host ID: ${hostId}`);
console.log(`[server-bridge] Host name: ${hostName}`);
console.log(`[server-bridge] Codex adapter: ${adapter}`);
console.log(`[server-bridge] Host identity: ${hostIdentityStore.path}`);
if (storedIdentity.host_device_token && !token && storedIdentityMatchesRelay) {
  console.log('[server-bridge] Using saved host device trust.');
}
if (storedIdentity.host_device_token && !storedIdentityMatchesRelayOrigin) {
  console.log(`[server-bridge] Saved host identity targets ${storedIdentity.relay_url}; ignoring it for ${relayUrl}.`);
}
console.log('');

const child = spawn('node', ['bridge/host-bridge/index.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    RELAY_URL: relayUrl,
    ...(token ? { RELAY_HOST_TOKEN: token } : {}),
    ...(storedIdentity.host_device_token && storedIdentityMatchesRelayOrigin && !token ? { RELAY_HOST_DEVICE_TOKEN: storedIdentity.host_device_token } : {}),
    HOST_IDENTITY_PATH: hostIdentityStore.path,
    HOST_ID: hostId,
    HOST_NAME: hostName,
    CODEX_ADAPTER: adapter
  },
  stdio: 'inherit'
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
