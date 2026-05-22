import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const tempDir = await mkdtemp(join(tmpdir(), 'cmc-host-trust-'));
const relayPort = '8834';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const hostToken = 'host-device-trust-bootstrap-token';
const identityPath = join(tempDir, 'host-identity.json');
const sqlitePath = join(tempDir, 'relay.sqlite');
const children = [];

try {
  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_PORT: relayPort,
    RELAY_HOST_TOKEN: hostToken,
    RELAY_PAIRING_TOKEN: 'host-device-trust-pairing-token',
    RELAY_SQLITE_PATH: sqlitePath,
    RELAY_IDENTITY_STORE_PATH: join(tempDir, 'identity-store.json'),
    RELAY_GIT_AUDIT_LOG_PATH: join(tempDir, 'git-audit.ndjson')
  });
  children.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);

  const firstBridge = spawnProcess('bridge:first', 'node', ['bridge/host-bridge/index.mjs'], {
    ...process.env,
    RELAY_URL: relayUrl,
    RELAY_HOST_TOKEN: hostToken,
    HOST_ID: 'trusted-host',
    HOST_NAME: 'Trusted Host',
    HOST_IDENTITY_PATH: identityPath,
    CODEX_ADAPTER: 'mock'
  });
  children.push(firstBridge);
  await waitForOutput(firstBridge, 'saved host device trust', 5000);
  if (!existsSync(identityPath)) {
    throw new Error('Host identity file was not created.');
  }
  const identity = JSON.parse(await readFile(identityPath, 'utf8'));
  if (!identity.host_device_token?.startsWith('cmc_hostdev_')) {
    throw new Error('Host identity did not include a host device token.');
  }
  stopProcess(firstBridge);
  await delay(350);

  const secondBridge = spawnProcess('bridge:second', 'node', ['bridge/host-bridge/index.mjs'], {
    ...process.env,
    RELAY_URL: relayUrl,
    HOST_ID: 'trusted-host',
    HOST_NAME: 'Trusted Host',
    HOST_IDENTITY_PATH: identityPath,
    CODEX_ADAPTER: 'mock'
  });
  children.push(secondBridge);
  await waitForOutput(secondBridge, 'registered host capabilities', 5000);
  await delay(350);

  const healthResponse = await fetch(`http://127.0.0.1:${relayPort}/health`, {
    headers: {
      'X-Relay-Host-Device-Token': identity.host_device_token
    }
  });
  if (!healthResponse.ok) {
    throw new Error(`Host device token health failed with HTTP ${healthResponse.status}`);
  }
  const health = await healthResponse.json();
  if (health.identity?.trusted_host_devices !== 1) {
    throw new Error(`Expected one trusted host device, received ${health.identity?.trusted_host_devices}`);
  }

  console.log('[verify] Host device trust verified.');
} finally {
  for (const child of children.reverse()) {
    stopProcess(child);
  }
  await delay(500);
  await rm(tempDir, { recursive: true, force: true });
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
  return child;
}

function stopProcess(child) {
  if (child && !child.killed) {
    child.kill();
  }
}

async function waitForOutput(child, needle, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.output.includes(needle)) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for output: ${needle}\n${child.output}`);
}
