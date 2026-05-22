import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createPairingCode, createPairingPayload } from './pairing-code.mjs';
import { displayPairingCode } from './pairing-display.mjs';

const relayPort = await resolveRelayPort();
const lanHost = process.env.RELAY_LAN_HOST || findLanAddress();
const token = process.env.RELAY_DEV_TOKEN || `cmc_${randomBytes(32).toString('base64url')}`;
const codexAdapter = process.env.CODEX_ADAPTER || 'app-server';
const relayUrlForAndroid = process.env.RELAY_ANDROID_URL || `ws://${lanHost}:${relayPort}`;
const relayUrlForBridge = `ws://127.0.0.1:${relayPort}`;
const pairingCode = createPairingCode(createPairingPayload({
  relayUrl: relayUrlForAndroid,
  pairingToken: token
}));

const children = [];

console.log('[pairing] Starting Codex Mobile Companion dev pair.');
console.log(`[pairing] Starting Relay on port ${relayPort}.`);

const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
  ...process.env,
  RELAY_HOST: '0.0.0.0',
  RELAY_PORT: String(relayPort),
  RELAY_DEV_TOKEN: token
});
children.push(relay);

await waitForOutput(relay, '[relay] listening', 5000);

const bridge = spawnProcess('bridge', 'node', ['bridge/host-bridge/index.mjs'], {
  ...process.env,
  CODEX_ADAPTER: codexAdapter,
  RELAY_URL: relayUrlForBridge,
  RELAY_DEV_TOKEN: token
});
children.push(bridge);

const bridgeConnected = await waitForOutput(bridge, '[bridge] connected', 2000)
  .then(() => true)
  .catch((error) => {
    console.warn(`[pairing] Host Bridge did not report connected yet: ${error.message}`);
    return false;
  });

console.log(`[pairing] Relay URL for Android: ${relayUrlForAndroid}`);
console.log(`[pairing] Host Bridge adapter: ${codexAdapter}`);
console.log('[pairing] Pairing code:');
console.log(pairingCode);
console.log('');
const pairingDisplay = await displayPairingCode({
  pairingCode,
  relayUrl: relayUrlForAndroid,
  title: 'Codex Mobile Companion',
  statusItems: [
    { label: 'Relay', detail: `Running on port ${relayPort}` },
    { label: 'Host Bridge', detail: bridgeConnected ? `Connected with ${codexAdapter}` : `Starting with ${codexAdapter}` },
    { label: 'Android URL', detail: relayUrlForAndroid }
  ]
});
if (pairingDisplay.htmlPath) {
  await maybeOpenPairingPage(pairingDisplay.htmlPath);
}
console.log('');
console.log('[pairing] Android: open Codex Mobile Companion, tap Scan QR code, then scan the browser page.');
console.log('[pairing] Fallback: paste the printed cmc1 pairing code into Android > Paste pairing code.');
console.log('[pairing] Keep this terminal running while using the app.');
if (lanHost.startsWith('169.254.')) {
  console.log('[pairing] Warning: selected a 169.254.x.x link-local address. Set RELAY_LAN_HOST to your Wi-Fi/LAN IPv4 address if Android cannot connect.');
}
console.log('');

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function resolveRelayPort() {
  if (process.env.RELAY_PORT) {
    const explicitPort = Number.parseInt(process.env.RELAY_PORT, 10);
    if (!Number.isInteger(explicitPort) || explicitPort <= 0) {
      throw new Error(`Invalid RELAY_PORT: ${process.env.RELAY_PORT}`);
    }

    if (!await isPortAvailable(explicitPort)) {
      throw new Error(`RELAY_PORT ${explicitPort} is already in use. Stop the old dev:pair/relay process or unset RELAY_PORT to allow automatic fallback.`);
    }

    return explicitPort;
  }

  const start = 8787;
  for (let port = start; port < start + 20; port += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error('Could not find an available Relay port from 8787 to 8806.');
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '0.0.0.0');
  });
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

async function maybeOpenPairingPage(htmlPath) {
  const openMode = String(process.env.CMC_PAIRING_OPEN ?? '1').trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(openMode)) {
    console.log('[pairing] Auto-open disabled by CMC_PAIRING_OPEN=0.');
    return;
  }

  const opened = await openFile(htmlPath).catch((error) => {
    console.warn(`[pairing] Could not auto-open pairing page: ${error.message}`);
    return false;
  });

  if (opened) {
    console.log('[pairing] Opened pairing page in your browser.');
  }
}

function openFile(filePath) {
  return new Promise((resolve, reject) => {
    let command;
    let args;
    if (process.platform === 'win32') {
      command = 'cmd.exe';
      args = ['/c', 'start', '', filePath];
    } else if (process.platform === 'darwin') {
      command = 'open';
      args = [filePath];
    } else {
      command = 'xdg-open';
      args = [filePath];
    }

    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}
