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

const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
  ...process.env,
  RELAY_HOST: '0.0.0.0',
  RELAY_PORT: relayPort,
  RELAY_DEV_TOKEN: token
});
children.push(relay);

console.log('[pairing] Starting Codex Mobile Companion dev pair.');
console.log(`[pairing] Relay URL for Android: ${relayUrlForAndroid}`);
console.log('[pairing] Pairing code:');
console.log(pairingCode);
console.log('');
console.log('[pairing] Paste this code into Android > Relay connection > Pairing code, then tap Use code.');
console.log('[pairing] Keep this terminal running while using the app.');
if (lanHost.startsWith('169.254.')) {
  console.log('[pairing] Warning: selected a 169.254.x.x link-local address. Set RELAY_LAN_HOST to your Wi-Fi/LAN IPv4 address if Android cannot connect.');
}
console.log('');

await waitForOutput(relay, '[relay] listening', 5000);

const bridge = spawnProcess('bridge', 'node', ['bridge/host-bridge/index.mjs'], {
  ...process.env,
  RELAY_URL: relayUrlForBridge,
  RELAY_DEV_TOKEN: token
});
children.push(bridge);

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function createPairingCode(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `cmc1.${encoded}`;
}

function findLanAddress() {
  const candidates = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        candidates.push(address.address);
      }
    }
  }

  return candidates.find(isPrivateLanAddress)
    ?? candidates.find((address) => !address.startsWith('169.254.'))
    ?? candidates[0]
    ?? '127.0.0.1';
}

function isPrivateLanAddress(address) {
  if (address.startsWith('10.')) {
    return true;
  }
  if (address.startsWith('192.168.')) {
    return true;
  }

  const match = address.match(/^172\.(\d+)\./);
  if (!match) {
    return false;
  }

  const second = Number.parseInt(match[1], 10);
  return second >= 16 && second <= 31;
}

function spawnProcess(label, command, args, env) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.output = '';

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    child.output += text;
    process.stdout.write(`[${label}] ${text}`);
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    child.output += text;
    process.stderr.write(`[${label}:err] ${text}`);
  });

  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') {
      console.error(`[pairing] ${label} exited with code=${code} signal=${signal ?? ''}`);
    }
  });

  return child;
}

async function waitForOutput(child, needle, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.output.includes(needle)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for output: ${needle}`);
}

function shutdown() {
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
  process.exit(0);
}
