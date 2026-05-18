import { spawn } from 'node:child_process';

const relayUrl = process.env.RELAY_PUBLIC_WS_URL
  ?? process.env.RELAY_URL;
const token = process.env.RELAY_HOST_TOKEN
  ?? process.env.RELAY_DEV_TOKEN
  ?? process.env.DEV_TOKEN;
const hostId = process.env.HOST_ID ?? 'local-dev-host';
const hostName = process.env.HOST_NAME ?? 'Local Development Host';
const adapter = process.env.CODEX_ADAPTER ?? 'app-server';

if (!relayUrl) {
  throw new Error('Set RELAY_URL or RELAY_PUBLIC_WS_URL to the server Relay WebSocket URL.');
}

if (!relayUrl.startsWith('ws://') && !relayUrl.startsWith('wss://')) {
  throw new Error('Relay URL must start with ws:// or wss://.');
}

if (!token) {
  throw new Error('Set RELAY_HOST_TOKEN before starting Host Bridge.');
}

console.log('[server-bridge] Starting Host Bridge against server Relay.');
console.log(`[server-bridge] Relay URL: ${relayUrl}`);
console.log(`[server-bridge] Host ID: ${hostId}`);
console.log(`[server-bridge] Host name: ${hostName}`);
console.log(`[server-bridge] Codex adapter: ${adapter}`);
console.log('');

const child = spawn('node', ['bridge/host-bridge/index.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    RELAY_URL: relayUrl,
    RELAY_HOST_TOKEN: token,
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
