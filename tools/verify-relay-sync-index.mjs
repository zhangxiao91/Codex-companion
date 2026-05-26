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

const relayPort = '8841';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const devToken = 'relay-sync-index-token';
const tempDir = await mkdtemp(join(tmpdir(), 'cmc-sync-index-'));
const sqlitePath = join(tempDir, 'relay.sqlite');
const processes = [];

try {
  let relay = await startRelay();
  const deviceToken = await pairDevice();

  const host = await connect(relayUrl);
  send(host, MessageType.HostRegister, {
    host_id: 'sync-host',
    display_name: 'Sync Host',
    bridge_version: 'verify',
    capabilities: ['session.list', 'timeline.event']
  });
  send(host, MessageType.SessionSnapshot, {
    session: createSession('sync-session-a', 'Session A')
  });
  send(host, MessageType.SessionSnapshot, {
    session: createSession('sync-session-b', 'Session B')
  });
  await waitForOutput(relay, 'session snapshot: sync-session-b', 5000);

  const client = await connect(relayUrl);
  send(client, MessageType.SessionSyncIndex, { limit: 20 }, deviceToken);
  const initialIndex = await waitForMessage(client, MessageType.SessionSyncIndexResult, 5000);
  assertEqual(initialIndex.payload.sessions.length, 2, 'initial dirty sessions');
  assertSessionIds(initialIndex.payload.sessions, ['sync-session-a', 'sync-session-b'], 'initial index sessions');

  ackAll(client, initialIndex.payload.sessions, deviceToken);
  await waitForMessage(client, MessageType.Ack, 5000);
  send(client, MessageType.SessionSyncIndex, { limit: 20 }, deviceToken);
  const cleanIndex = await waitForMessage(client, MessageType.SessionSyncIndexResult, 5000);
  assertEqual(cleanIndex.payload.sessions.length, 0, 'clean sessions after ack');
  assertEqual(cleanIndex.payload.unchanged_count, 2, 'unchanged count after ack');

  send(client, MessageType.SessionSyncIndex, { limit: 20, include_clean: true }, deviceToken);
  const cleanFullIndex = await waitForMessage(client, MessageType.SessionSyncIndexResult, 5000);
  assertEqual(cleanFullIndex.payload.sessions.length, 2, 'clean sessions returned when include_clean is true');
  assertSessionIds(cleanFullIndex.payload.sessions, ['sync-session-a', 'sync-session-b'], 'include_clean sessions');

  send(host, MessageType.TimelineEvent, {
    event: createTimelineEvent('sync-session-a', 'sync-event-a-1', 'Session A changed')
  });
  await waitForOutput(relay, 'timeline event: Session A changed', 5000);

  send(client, MessageType.SessionSyncIndex, { limit: 20 }, deviceToken);
  const dirtyIndex = await waitForMessage(client, MessageType.SessionSyncIndexResult, 5000);
  assertEqual(dirtyIndex.payload.sessions.length, 1, 'single dirty session after timeline event');
  assertEqual(dirtyIndex.payload.sessions[0].session.session_id, 'sync-session-a', 'dirty session id');
  if (!dirtyIndex.payload.sessions[0].dirty_reasons.includes('timeline')) {
    throw new Error(`Expected timeline dirty reason, got ${dirtyIndex.payload.sessions[0].dirty_reasons.join(',')}`);
  }
  assertEqual(dirtyIndex.payload.sessions[0].recommended_action, 'timeline_page', 'dirty action');
  ackAll(client, dirtyIndex.payload.sessions, deviceToken);
  await waitForMessage(client, MessageType.Ack, 5000);

  host.close();
  client.close();
  stopProcess(relay);
  await delay(350);
  relay = await startRelay();

  const restoredClient = await connect(relayUrl);
  send(restoredClient, MessageType.SessionSyncIndex, { limit: 20 }, deviceToken);
  const restoredIndex = await waitForMessage(restoredClient, MessageType.SessionSyncIndexResult, 5000);
  assertEqual(restoredIndex.payload.sessions.length, 0, 'clean sessions after restart');
  assertEqual(restoredIndex.payload.unchanged_count, 2, 'unchanged count after restart');

  const health = await readHealth();
  assertEqual(health.sync.session_sync_index_enabled, true, 'health sync flag');
  assertEqual(health.storage.counts.device_session_sync, 2, 'persisted device session sync rows');

  restoredClient.close();
  console.log('[verify] Relay sync index and ack persistence verified.');
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

function createSession(sessionId, name) {
  return {
    session_id: sessionId,
    host_id: 'sync-host',
    project_name: name,
    repo_path: process.cwd(),
    branch: 'main',
    status: 'running',
    summary: `${name} verification session.`,
    updated_at: new Date().toISOString()
  };
}

function createTimelineEvent(sessionId, eventId, title) {
  return {
    event_id: eventId,
    session_id: sessionId,
    created_at: new Date().toISOString(),
    type: 'assistant_message',
    title,
    summary: title,
    payload: { source: 'verify-relay-sync-index' },
    redaction_level: 'none'
  };
}

function ackAll(socket, sessions, token) {
  send(socket, MessageType.SessionSyncAck, {
    sessions: sessions.map((entry) => ({
      session_id: entry.session.session_id,
      seen_snapshot_revision: entry.snapshot_revision,
      seen_stage_revision: entry.stage_revision,
      seen_timeline_cursor: entry.timeline_newest_cursor,
      seen_sync_revision: entry.sync_revision
    }))
  }, token);
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

async function pairDevice() {
  const response = await fetch(`http://127.0.0.1:${relayPort}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Relay-Dev-Token': devToken
    },
    body: JSON.stringify({
      device_id: 'sync-device',
      display_name: 'Sync Device'
    })
  });
  if (!response.ok) {
    throw new Error(`Pairing failed with HTTP ${response.status}`);
  }
  const pair = await response.json();
  return pair.device_token;
}

async function readHealth() {
  const response = await fetch(`http://127.0.0.1:${relayPort}/health`, {
    headers: {
      'X-Relay-Dev-Token': devToken
    }
  });
  if (!response.ok) {
    throw new Error(`Health failed with HTTP ${response.status}`);
  }
  return response.json();
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

function send(socket, type, payload, token = devToken) {
  socket.send(encodeMessage(createMessage(type, payload, {
    auth: {
      token
    }
  })));
}

function assertSessionIds(entries, expected, label) {
  const actual = entries.map((entry) => entry.session.session_id).sort();
  assertEqual(JSON.stringify(actual), JSON.stringify([...expected].sort()), label);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}
