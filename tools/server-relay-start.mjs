import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createPairingCode, createPairingPayload } from './pairing-code.mjs';
import { displayPairingCode } from './pairing-display.mjs';

const port = process.env.RELAY_PORT ?? '8787';
const host = process.env.RELAY_HOST ?? '127.0.0.1';
const publicWsUrl = process.env.RELAY_PUBLIC_WS_URL ?? '';
const publicHttpUrl = process.env.RELAY_PUBLIC_HTTP_URL ?? '';
const allowInsecureServerRelay = process.env.CMC_ALLOW_INSECURE_SERVER_RELAY === '1';
const pairingToken = process.env.RELAY_PAIRING_TOKEN
  ?? process.env.RELAY_DEV_TOKEN
  ?? `cmc_${randomBytes(32).toString('base64url')}`;
const hostToken = process.env.RELAY_HOST_TOKEN
  ?? process.env.RELAY_DEV_TOKEN
  ?? `cmc_host_${randomBytes(32).toString('base64url')}`;

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

console.log('[server-relay] Starting Codex Mobile Companion Relay.');
console.log(`[server-relay] Listen: ${host}:${port}`);
console.log(`[server-relay] Public WebSocket URL: ${publicWsUrl}`);
if (publicHttpUrl) {
  console.log(`[server-relay] Public HTTP URL: ${publicHttpUrl}`);
}
console.log(`[server-relay] Pairing token: ${pairingToken}`);
console.log(`[server-relay] Host token: ${hostToken}`);
console.log('');
console.log('[server-relay] Android pairing code:');
console.log(pairingCode);
console.log('');
await displayPairingCode({
  pairingCode,
  relayUrl: publicWsUrl,
  title: 'Codex Mobile Companion Server Relay Pairing'
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
