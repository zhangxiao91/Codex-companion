import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const processes = [];
const devToken = process.env.RELAY_DEV_TOKEN ?? 'app-server-timeline-token';
const tempDir = mkdtempSync(join(tmpdir(), 'cmc-app-server-timeline-'));

try {
  const relayPort = '8789';
  const relayUrl = `ws://127.0.0.1:${relayPort}`;
  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_PORT: relayPort,
    RELAY_DEV_TOKEN: devToken,
    RELAY_SQLITE_PATH: join(tempDir, 'relay.sqlite'),
    RELAY_IDENTITY_STORE_PATH: join(tempDir, 'identity.json'),
    RELAY_GIT_AUDIT_LOG_PATH: join(tempDir, 'git-audit.ndjson')
  });
  processes.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);
  const deviceToken = await pairDevice(relayPort, devToken);

  const bridge = spawnProcess('bridge', 'node', ['bridge/host-bridge/index.mjs'], {
    ...process.env,
    RELAY_URL: relayUrl,
    RELAY_DEV_TOKEN: devToken,
    CODEX_ADAPTER: 'app-server',
    CODEX_APP_SERVER_LISTEN: 'stdio://',
    HOST_IDENTITY_PATH: join(tempDir, 'host-identity.json')
  });
  processes.push(bridge);
  await waitForOutput(bridge, '[bridge] app-server initialized', 15000);
  await waitForOutput(relay, '[relay] session snapshot', 10000);

  const client = spawnProcess('timeline-client', 'node', ['tools/timeline-client/index.mjs'], {
    ...process.env,
    RELAY_URL: relayUrl,
    RELAY_DEVICE_TOKEN: deviceToken
  });
  processes.push(client);

  const exitCode = await waitForExit(client, 20000);
  if (exitCode !== 0) {
    throw new Error(`timeline-client exited with code ${exitCode}`);
  }

  await waitForOutput(bridge, '[bridge] received timeline request', 5000);
  await waitForOutput(relay, '[relay] timeline event', 10000);
  console.log('[verify] App Server thread/read timeline mapped through Relay.');
} finally {
  for (const child of processes.reverse()) {
    if (!child.killed) {
      child.kill();
    }
  }

  await delay(250);
}

async function pairDevice(port, pairingToken) {
  const response = await fetch(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Relay-Dev-Token': pairingToken
    },
    body: JSON.stringify({
      device_id: 'app-server-timeline-client',
      display_name: 'App Server Timeline Client'
    })
  });

  if (!response.ok) {
    throw new Error(`Pairing failed with HTTP ${response.status}`);
  }

  const pair = await response.json();
  if (!pair.device_token) {
    throw new Error('Pairing response did not include device_token.');
  }

  return pair.device_token;
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

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for process exit after ${timeoutMs}ms`));
    }, timeoutMs);

    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
