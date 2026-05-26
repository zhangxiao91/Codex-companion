import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MessageType,
  createMessage,
  decodeMessage,
  encodeMessage
} from '../packages/protocol/index.mjs';

const processes = [];
const relayPort = '8837';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const tempDir = mkdtempSync(join(tmpdir(), 'cmc-relay-ws-keepalive-'));

try {
  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_PORT: relayPort,
    RELAY_SQLITE_PATH: join(tempDir, 'relay.sqlite'),
    RELAY_IDENTITY_STORE_PATH: join(tempDir, 'identity-store.json'),
    RELAY_GIT_AUDIT_LOG_PATH: join(tempDir, 'git-audit.ndjson'),
    RELAY_WS_PING_INTERVAL_MS: '100',
    RELAY_WS_STALE_TIMEOUT_MS: '1000'
  });
  processes.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);

  const client = await connect(relayUrl);
  send(client, MessageType.SessionSubscribe, { session_id: '*' });
  await delay(1200);

  if (client.readyState !== WebSocket.OPEN) {
    throw new Error(`Expected WebSocket to remain open after keepalive pings, readyState=${client.readyState}`);
  }

  const health = await readHealth();
  if (health.counts.clients !== 1) {
    throw new Error(`Expected one connected client, received ${health.counts.clients}`);
  }

  client.close();
  console.log('[verify] Relay WebSocket keepalive verified.');
} finally {
  for (const child of processes.reverse()) {
    stopProcess(child);
  }
  await delay(250);
  rmSync(tempDir, { recursive: true, force: true });
}

async function readHealth() {
  const response = await fetch(`http://127.0.0.1:${relayPort}/health`);
  if (!response.ok) {
    throw new Error(`Health failed with HTTP ${response.status}`);
  }
  return response.json();
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out opening WebSocket ${url}`));
    }, 2500);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket connection failed for ${url}`));
    });
    socket.addEventListener('message', (event) => {
      decodeMessage(event.data);
    });
  });
}

function send(socket, type, payload) {
  socket.send(encodeMessage(createMessage(type, payload)));
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
  throw new Error(`Timed out waiting for output: ${needle}`);
}
