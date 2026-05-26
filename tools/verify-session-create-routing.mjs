import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
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
const sockets = [];
const devToken = 'session-create-routing-token';
const hostId = 'verify-host';
const tempDir = mkdtempSync(join(tmpdir(), 'cmc-session-create-routing-'));
const relayPort = await getFreePort();
const relayUrl = `ws://127.0.0.1:${relayPort}`;

try {
  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_PORT: String(relayPort),
    RELAY_DEV_TOKEN: devToken,
    RELAY_SQLITE_PATH: join(tempDir, 'relay.sqlite'),
    RELAY_IDENTITY_STORE_PATH: join(tempDir, 'identity.json'),
    RELAY_GIT_AUDIT_LOG_PATH: join(tempDir, 'git-audit.ndjson')
  });
  processes.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);

  const deviceToken = await pairDevice(relayPort);
  const host = await openSocket(relayUrl);
  sockets.push(host);
  send(host, MessageType.HostRegister, {
    host_id: hostId,
    display_name: 'Verify Host',
    capabilities: ['session.create']
  }, devToken);
  await waitForMessage(host, (message) => message.type === MessageType.HostTrusted, 5000);

  const client = await openSocket(relayUrl);
  sockets.push(client);

  send(client, MessageType.SessionCreate, {
    host_id: hostId,
    ephemeral: false,
    persist_extended_history: true,
    service_name: 'codex-mobile-companion'
  }, deviceToken);

  const routedPersistent = await waitForMessage(host, (message) => message.type === MessageType.SessionCreate, 5000);
  assertEqual(routedPersistent.payload.ephemeral, false, 'session.create should preserve ephemeral=false');
  assertEqual(routedPersistent.payload.persist_extended_history, true, 'session.create should request extended history persistence');
  send(host, MessageType.SessionSnapshot, {
    session: session('persistent-session')
  }, devToken);
  await waitForMessage(client, (message) => message.type === MessageType.SessionSnapshot
    && message.payload.session.session_id === 'persistent-session', 5000);

  send(client, MessageType.SessionCreateEphemeral, {
    host_id: hostId
  }, deviceToken);
  const routedLegacy = await waitForMessage(host, (message) => message.type === MessageType.SessionCreateEphemeral, 5000);
  if (Object.hasOwn(routedLegacy.payload, 'ephemeral')) {
    throw new Error('legacy session.create_ephemeral should not be rewritten by Relay');
  }

  console.log('[verify] Session create routing preserves persistent mobile New Chat and legacy ephemeral clients.');
} finally {
  for (const socket of sockets) {
    try {
      socket.close();
    } catch {
      // best effort cleanup
    }
  }
  for (const child of processes.reverse()) {
    if (!child.killed) {
      child.kill();
    }
  }
  await delay(250);
}

function session(sessionId) {
  return {
    session_id: sessionId,
    host_id: hostId,
    project_name: 'Verify Project',
    repo_path: process.cwd(),
    branch: 'main',
    status: 'completed',
    summary: 'Verify session create routing.',
    updated_at: new Date().toISOString()
  };
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => resolve(port));
    });
  });
}

async function pairDevice(port) {
  const response = await fetch(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-relay-pairing-token': devToken
    },
    body: JSON.stringify({
      device_id: 'verify-device',
      display_name: 'Verify Device'
    })
  });
  if (!response.ok) {
    throw new Error(`Pair failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json();
  return body.device_token;
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${url}`)), 5000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      socket.messages = [];
      socket.waiters = [];
      socket.addEventListener('message', (event) => {
        const message = decodeMessage(event.data);
        socket.messages.push(message);
        for (const waiter of [...socket.waiters]) {
          if (waiter.predicate(message)) {
            socket.waiters.splice(socket.waiters.indexOf(waiter), 1);
            clearTimeout(waiter.timer);
            waiter.resolve(message);
          }
        }
      });
      resolve(socket);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error connecting to ${url}`));
    }, { once: true });
  });
}

function waitForMessage(socket, predicate, timeoutMs) {
  const existing = socket.messages.find(predicate);
  if (existing) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      timer: setTimeout(() => {
        socket.waiters.splice(socket.waiters.indexOf(waiter), 1);
        reject(new Error('Timed out waiting for WebSocket message'));
      }, timeoutMs)
    };
    socket.waiters.push(waiter);
  });
}

function send(socket, type, payload, token) {
  socket.send(encodeMessage(createMessage(type, payload, token ? { auth: { token } } : {})));
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

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
