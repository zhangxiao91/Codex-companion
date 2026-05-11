import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createPairingCode, createPairingPayload } from './pairing-code.mjs';

const port = process.env.RELAY_PORT ?? '8787';
const host = process.env.RELAY_HOST ?? '0.0.0.0';
const publicWsUrl = process.env.RELAY_PUBLIC_WS_URL ?? '';
const publicHttpUrl = process.env.RELAY_PUBLIC_HTTP_URL ?? '';
const token = process.env.RELAY_DEV_TOKEN
  ?? process.env.RELAY_PAIRING_TOKEN
  ?? `cmc_${randomBytes(32).toString('base64url')}`;

if (!publicWsUrl) {
  throw new Error('Set RELAY_PUBLIC_WS_URL to the server WebSocket URL, for example wss://relay.example.com.');
}

if (!publicWsUrl.startsWith('ws://') && !publicWsUrl.startsWith('wss://')) {
  throw new Error('RELAY_PUBLIC_WS_URL must start with ws:// or wss://.');
}

if (publicHttpUrl && !publicHttpUrl.startsWith('http://') && !publicHttpUrl.startsWith('https://')) {
  throw new Error('RELAY_PUBLIC_HTTP_URL must start with http:// or https://.');
}

const pairingCode = createPairingCode(createPairingPayload({
  relayUrl: publicWsUrl,
  pairingToken: token
}));

console.log('[server-relay] Starting Codex Mobile Companion Relay.');
console.log(`[server-relay] Listen: ${host}:${port}`);
console.log(`[server-relay] Public WebSocket URL: ${publicWsUrl}`);
if (publicHttpUrl) {
  console.log(`[server-relay] Public HTTP URL: ${publicHttpUrl}`);
}
console.log('');
console.log('[server-relay] Android pairing code:');
console.log(pairingCode);
console.log('');
console.log('[server-relay] Keep this process running. Use the same RELAY_DEV_TOKEN for Host Bridge nodes.');
console.log('');

const child = spawn('node', ['relay/service/server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    RELAY_HOST: host,
    RELAY_PORT: port,
    RELAY_DEV_TOKEN: token,
    RELAY_PUBLIC_WS_URL: publicWsUrl,
    ...(publicHttpUrl ? { RELAY_PUBLIC_HTTP_URL: publicHttpUrl } : {})
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

