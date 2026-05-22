import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const relayPort = '8817';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const pairingToken = 'server-bridge-start-pairing-token';
const hostToken = 'server-bridge-start-host-token';
const tempDir = mkdtempSync(join(tmpdir(), 'cmc-server-bridge-'));
const processes = [];

try {
  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_PORT: relayPort,
    RELAY_PAIRING_TOKEN: pairingToken,
    RELAY_HOST_TOKEN: hostToken,
    RELAY_PUBLIC_WS_URL: 'wss://relay.example.com',
    RELAY_IDENTITY_STORE_PATH: join(tempDir, 'identity-store.json'),
    RELAY_GIT_AUDIT_LOG_PATH: join(tempDir, 'git-audit.ndjson')
  });
  processes.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);

  const bridge = spawnProcess('bridge', 'node', ['tools/server-host-bridge-start.mjs'], {
    ...process.env,
    RELAY_URL: relayUrl,
    RELAY_HOST_TOKEN: hostToken,
    HOST_ID: 'server-bridge-verify-host',
    HOST_NAME: 'Server Bridge Verify Host',
    HOST_IDENTITY_PATH: join(tempDir, 'host-identity.json'),
    CODEX_ADAPTER: 'mock'
  });
  processes.push(bridge);

  await waitForOutput(bridge, '[server-bridge] Starting Host Bridge', 5000);
  await waitForOutput(relay, 'host registered: server-bridge-verify-host', 5000);
  await waitForOutput(relay, 'session snapshot: mock-session-001', 5000);

  console.log('[verify] Server Host Bridge startup helper verified.');
} finally {
  for (const child of processes.reverse()) {
    if (!child.killed) {
      child.kill();
    }
  }
  await delay(250);
  rmSync(tempDir, { recursive: true, force: true });
}

function spawnProcess(label, command, args, env = process.env) {
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

async function waitForOutput(child, needle, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.output.includes(needle)) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for output: ${needle}`);
}
