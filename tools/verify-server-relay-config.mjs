import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const tempDir = await mkdtemp(join(tmpdir(), 'cmc-server-relay-config-'));
const configPath = join(tempDir, 'server-relay-config.json');
const sqlitePath = join(tempDir, 'relay.sqlite');
const relayPort = '8831';
const pairingToken = 'server-config-pairing-token';
const hostToken = 'server-config-host-token';
const publicWsUrl = 'wss://relay-config.example.com';
const publicHttpUrl = 'https://relay-config.example.com';
const children = [];

try {
  const init = spawnProcess('init', 'node', ['tools/server-relay-init.mjs'], {
    ...process.env,
    CMC_SERVER_RELAY_CONFIG: configPath,
    RELAY_PORT: relayPort,
    RELAY_PUBLIC_WS_URL: publicWsUrl,
    RELAY_PUBLIC_HTTP_URL: publicHttpUrl,
    RELAY_PAIRING_TOKEN: pairingToken,
    RELAY_HOST_TOKEN: hostToken,
    RELAY_SQLITE_PATH: sqlitePath,
    CMC_PAIRING_QR: 'none',
    CMC_PAIRING_OPEN: '0'
  });
  await waitForExit(init, 5000);

  const rawConfig = JSON.parse(await readFile(configPath, 'utf8'));
  assertEqual(rawConfig.public_ws_url, publicWsUrl, 'persisted public ws url');
  assertEqual(rawConfig.public_http_url, publicHttpUrl, 'persisted public http url');
  assertEqual(rawConfig.pairing_token, pairingToken, 'persisted pairing token');
  assertEqual(rawConfig.host_token, hostToken, 'persisted host token');
  assertEqual(rawConfig.sqlite_path, sqlitePath, 'persisted sqlite path');

  const relay = spawnProcess('relay', 'node', ['tools/server-relay-start.mjs'], {
    ...process.env,
    CMC_SERVER_RELAY_CONFIG: configPath,
    CMC_PAIRING_QR: 'none',
    CMC_PAIRING_OPEN: '0',
    RELAY_IDENTITY_STORE_PATH: join(tempDir, 'identity-store.json'),
    RELAY_GIT_AUDIT_LOG_PATH: join(tempDir, 'git-audit.ndjson')
  });
  children.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);

  const healthResponse = await fetch(`http://127.0.0.1:${relayPort}/health`, {
    headers: {
      'X-Relay-Pairing-Token': pairingToken
    }
  });
  if (!healthResponse.ok) {
    throw new Error(`Health failed with HTTP ${healthResponse.status}`);
  }
  const health = await healthResponse.json();
  assertEqual(health.listen.public_websocket_url, publicWsUrl, 'health public ws url');
  assertEqual(health.storage.path, sqlitePath, 'health sqlite path');

  console.log('[verify] Server Relay persisted config verified.');
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
    child.kill('SIGTERM');
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

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stopProcess(child);
      reject(new Error(`Timed out waiting for process exit after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Process exited with code ${code}\n${child.output}`));
      }
    });
  });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}
