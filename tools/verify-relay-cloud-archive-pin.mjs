import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MessageType,
  createMessage,
  decodeMessage,
  encodeMessage
} from '../packages/protocol/index.mjs';

const relayPort = '8843';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const devToken = 'relay-cloud-archive-pin-token';
const tempDir = await mkdtemp(join(tmpdir(), 'cmc-archive-pin-'));
const sqlitePath = join(tempDir, 'relay.sqlite');
const processes = [];

try {
  const relay = await startRelay();
  const deviceToken = await pairDevice();
  const host = await connect(relayUrl);
  const client = await connect(relayUrl);

  send(host, MessageType.HostRegister, {
    host_id: 'archive-host',
    display_name: 'Archive Host',
    bridge_version: 'verify',
    capabilities: ['session.list']
  });
  send(host, MessageType.SessionSnapshot, {
    session: {
      session_id: 'archive-session',
      host_id: 'archive-host',
      project_name: 'Archive Pin',
      repo_path: process.cwd(),
      branch: 'main',
      status: 'completed',
      summary: 'Archive and pin verification session.',
      updated_at: new Date().toISOString()
    }
  });
  await waitForOutput(relay, 'session snapshot: archive-session', 5000);

  send(client, MessageType.SessionArchiveUpdate, {
    session_id: 'archive-session',
    archived: true
  }, deviceToken);
  await waitForMessage(client, MessageType.Ack, 5000);

  send(client, MessageType.SessionSyncIndex, { limit: 10, include_archived: false, include_clean: true }, deviceToken);
  const activeIndex = await waitForMessage(client, MessageType.SessionSyncIndexResult, 5000);
  if (activeIndex.payload.sessions.some((entry) => entry.session.session_id === 'archive-session')) {
    throw new Error('Archived session should be hidden from active sync index.');
  }

  send(client, MessageType.SessionSyncIndex, { limit: 10, include_archived: true, include_clean: true }, deviceToken);
  const archivedIndex = await waitForMessage(client, MessageType.SessionSyncIndexResult, 5000);
  const archivedEntry = archivedIndex.payload.sessions.find((entry) => entry.session.session_id === 'archive-session');
  if (!archivedEntry?.device_seen?.archived_at) {
    throw new Error('Expected archived_at in include_archived sync index.');
  }

  send(client, MessageType.SessionArchiveUpdate, {
    session_id: 'archive-session',
    archived: false
  }, deviceToken);
  await waitForMessage(client, MessageType.Ack, 5000);
  send(client, MessageType.SessionPinUpdate, {
    session_id: 'archive-session',
    pinned: true
  }, deviceToken);
  await waitForMessage(client, MessageType.Ack, 5000);

  send(client, MessageType.SessionSyncIndex, { limit: 10, include_archived: true, include_clean: true }, deviceToken);
  const pinnedIndex = await waitForMessage(client, MessageType.SessionSyncIndexResult, 5000);
  const pinnedEntry = pinnedIndex.payload.sessions.find((entry) => entry.session.session_id === 'archive-session');
  if (pinnedEntry?.device_seen?.archived_at) {
    throw new Error('Expected archived_at to be cleared after restore.');
  }
  if (!pinnedEntry?.device_seen?.pinned_at) {
    throw new Error('Expected pinned_at after pin update.');
  }

  host.close();
  client.close();
  console.log('[verify] Relay cloud archive/pin state verified.');
} finally {
  for (const child of processes.reverse()) {
    stopProcess(child);
  }
  await delay(500);
  await rm(tempDir, { recursive: true, force: true });
}

async function startRelay() {
  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_PORT: relayPort,
    RELAY_DEV_TOKEN: devToken,
    RELAY_SQLITE_PATH: sqlitePath,
    RELAY_GIT_AUDIT_LOG_PATH: join(tempDir, 'git-audit.ndjson'),
    RELAY_IDENTITY_STORE_PATH: join(tempDir, 'identity-store.json')
  });
  processes.push(relay);
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
      device_id: 'archive-device',
      display_name: 'Archive Device'
    })
  });
  if (!response.ok) {
    throw new Error(`Pairing failed with HTTP ${response.status}`);
  }
  const pair = await response.json();
  return pair.device_token;
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
  });
}

function waitForMessage(socket, expectedType, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${expectedType} after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.addEventListener('message', (event) => {
      const message = decodeMessage(event.data);
      if (message.type === MessageType.Error) {
        clearTimeout(timer);
        reject(new Error(message.payload.detail));
        return;
      }
      if (message.type === expectedType) {
        clearTimeout(timer);
        resolve(message);
      }
    });
  });
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

function send(socket, type, payload, token = devToken) {
  socket.send(encodeMessage(createMessage(type, payload, {
    auth: {
      token
    }
  })));
}
