import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MessageType,
  createMessage,
  encodeMessage
} from '../packages/protocol/index.mjs';

const relayPort = '8818';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const devToken = 'identity-storage-token';
const tempDir = mkdtempSync(join(tmpdir(), 'cmc-identity-'));
const identityPath = join(tempDir, 'identity-store.json');
const processes = [];

try {
  const firstRelay = await startRelay();
  processes.push(firstRelay);

  const pair = await pairDevice();
  const host = await connect(relayUrl);
  send(host, MessageType.HostRegister, {
    host_id: 'identity-host',
    display_name: 'Identity Host',
    kind: 'local_pc',
    bridge_version: 'verify',
    capabilities: ['session.list']
  }, devToken);
  await waitForOutput(firstRelay, 'host registered: identity-host', 5000);
  host.close();

  firstRelay.kill();
  await waitForExit(firstRelay, 5000);
  processes.pop();

  const secondRelay = await startRelay();
  processes.push(secondRelay);
  await waitForOutput(secondRelay, 'loaded 1 device(s) and 1 host(s)', 5000);

  const deviceHealth = await fetch(`http://127.0.0.1:${relayPort}/health`, {
    headers: {
      authorization: `Bearer ${pair.device_token}`
    }
  });
  if (!deviceHealth.ok) {
    throw new Error(`Device-token health failed with HTTP ${deviceHealth.status}`);
  }

  const health = await deviceHealth.json();
  if (health.counts.paired_devices !== 1) {
    throw new Error(`Expected one paired device after restart, received ${health.counts.paired_devices}`);
  }
  if (health.counts.hosts !== 1) {
    throw new Error(`Expected one stored host after restart, received ${health.counts.hosts}`);
  }
  if (health.counts.online_hosts !== 0) {
    throw new Error(`Expected stored host to be offline after restart, received ${health.counts.online_hosts}`);
  }

  console.log('[verify] Relay identity storage verified.');
} finally {
  for (const child of processes.reverse()) {
    if (!child.killed) {
      child.kill();
    }
  }
  await delay(250);
  rmSync(tempDir, { recursive: true, force: true });
}

async function startRelay() {
  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_PORT: relayPort,
    RELAY_DEV_TOKEN: devToken,
    RELAY_IDENTITY_STORE_PATH: identityPath,
    RELAY_GIT_AUDIT_LOG_PATH: join(tempDir, 'git-audit.ndjson')
  });
  await waitForOutput(relay, '[relay] listening', 5000);
  return relay;
}

async function pairDevice() {
  const response = await fetch(`http://127.0.0.1:${relayPort}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Relay-Dev-Token': devToken
    },
    body: JSON.stringify({
      device_id: 'identity-device',
      display_name: 'Identity Device'
    })
  });
  if (!response.ok) {
    throw new Error(`Pairing failed with HTTP ${response.status}`);
  }

  const pair = await response.json();
  if (!pair.device_token) {
    throw new Error('Pairing did not return a device token.');
  }
  return pair;
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

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out opening WebSocket ${url}`));
    }, 2000);

    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket connection failed for ${url}`));
    });
  });
}

function send(socket, type, payload, token = '') {
  socket.send(encodeMessage(createMessage(type, payload, token ? {
    auth: { token }
  } : {})));
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

