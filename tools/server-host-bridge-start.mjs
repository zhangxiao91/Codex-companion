import { spawn } from 'node:child_process';
import { createHostIdentityStore } from '../bridge/host-bridge/host-identity-store.mjs';
import { loadServerRelayConfig } from './server-relay-config.mjs';
import { loadWindowsBridgeConfig } from './windows-host-bridge-service.mjs';

const serverConfig = loadConfigSafely(loadServerRelayConfig);
const bridgeConfig = loadConfigSafely(loadWindowsBridgeConfig);
const hostIdentityPath = firstNonBlank(
  process.env.HOST_IDENTITY_PATH,
  bridgeConfig.host_identity_path,
  '.relay/host-identity.json'
);
const hostIdentityStore = createHostIdentityStore({ path: hostIdentityPath });
const storedIdentity = hostIdentityStore.load();
const relayUrl = firstNonBlank(
  process.env.RELAY_PUBLIC_WS_URL,
  process.env.RELAY_URL,
  bridgeConfig.relay_url,
  storedIdentity.relay_url,
  serverConfig.public_ws_url
);
const token = firstNonBlank(
  process.env.RELAY_HOST_TOKEN,
  process.env.RELAY_DEV_TOKEN,
  process.env.DEV_TOKEN,
  bridgeConfig.host_token,
  serverConfig.host_token
);
const hostId = firstNonBlank(process.env.HOST_ID, bridgeConfig.host_id, 'local-dev-host');
const hostName = firstNonBlank(process.env.HOST_NAME, bridgeConfig.host_name, 'Local Development Host');
const adapter = firstNonBlank(process.env.CODEX_ADAPTER, bridgeConfig.codex_adapter, 'app-server');
const storedIdentityMatchesRelay = storedIdentity.relay_url === relayUrl;
const storedIdentityMatchesRelayOrigin = storedIdentity.relay_url === relayUrl || !storedIdentity.relay_url;

if (!relayUrl) {
  throw new Error('Set RELAY_URL/RELAY_PUBLIC_WS_URL once, or create .relay/windows-host-bridge-config.json / .relay/server-relay-config.json.');
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

function loadConfigSafely(loadConfig) {
  try {
    return loadConfig();
  } catch {
    return {};
  }
}

function firstNonBlank(...values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) {
      return normalized;
    }
  }
  return '';
}
