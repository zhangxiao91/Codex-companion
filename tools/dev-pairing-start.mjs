import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';

const relayPort = process.env.RELAY_PORT ?? '8787';
const lanHost = process.env.RELAY_LAN_HOST || findLanAddress();
const token = process.env.RELAY_DEV_TOKEN || `cmc_${randomBytes(32).toString('base64url')}`;
const relayUrlForAndroid = process.env.RELAY_ANDROID_URL || `ws://${lanHost}:${relayPort}`;
const relayUrlForBridge = `ws://127.0.0.1:${relayPort}`;
const pairingCode = createPairingCode({
  relay_url: relayUrlForAndroid,
  pairing_token: token,
  created_at: new Date().toISOString()
});

const children = [];

console.log('[pairing] Starting Codex Mobile Companion dev pair.');
console.log(`[pairing] Relay URL for Android: ${relayUrlForAndroid}`);
console.log('[pairing] Pairing code:');
console.log(pairingCode);
console.log('');
console.log('[pairing] Paste this code into Android > Relay connection > Pairing code, then tap Use code.');
console.log('[pairing] Keep this terminal running while using the app.');
console.log('');

children.push(spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
  ...process.env,
  RELAY_HOST: '0.0.0.0',
  RELAY_PORT: relayPort,
  RELAY_DEV_TOKEN: token
}));

children.push(spawnProcess('bridge', 'node', ['bridge/host-bridge/index.mjs'], {
  ...process.env,
  RELAY_URL: relayUrlForBridge,
  RELAY_DEV_TOKEN: token
}));

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function createPairingCode(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `cmc1.${encoded}`;
}

function findLanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }

  return '127.0.0.1';
}

function spawnProcess(label, command, args, env) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[${label}] ${chunk}`);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[${label}:err] ${chunk}`);
  });

  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') {
      console.error(`[pairing] ${label} exited with code=${code} signal=${signal ?? ''}`);
    }
  });

  return child;
}

function shutdown() {
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
  process.exit(0);
}
