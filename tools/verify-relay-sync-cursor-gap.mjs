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

const relayPort = '8842';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const devToken = 'relay-sync-cursor-gap-token';
const tempDir = await mkdtemp(join(tmpdir(), 'cmc-sync-gap-'));
const sqlitePath = join(tempDir, 'relay.sqlite');
const processes = [];

try {
  const relay = await startRelay();
  const deviceToken = await pairDevice();
  const host = await connect(relayUrl);
  const client = await connect(relayUrl);

  send(host, MessageType.HostRegister, {
    host_id: 'gap-host',
    display_name: 'Gap Host',
    bridge_version: 'verify',
    capabilities: ['session.list', 'timeline.event']
  });
  send(host, MessageType.SessionSnapshot, {
    session: {
      session_id: 'gap-session',
      host_id: 'gap-host',
      project_name: 'Cursor Gap',
      repo_path: process.cwd(),
      branch: 'main',
      status: 'running',
      summary: 'Cursor gap verification session.',
      updated_at: new Date().toISOString()
    }
  });
  await waitForOutput(relay, 'session snapshot: gap-session', 5000);

  for (const cursor of [1, 2, 3]) {
    send(host, MessageType.TimelineEvent, {
      event: {
        event_id: `gap-event-${cursor}`,
        session_id: 'gap-session',
        cursor: String(cursor),
        created_at: new Date().toISOString(),
        type: 'assistant_message',
        title: `Gap event ${cursor}`,
        summary: `Gap event ${cursor}`,
        payload: { cursor },
        redaction_level: 'none'
      }
    });
    await waitForOutput(relay, `timeline event: Gap event ${cursor}`, 5000);
  }

  send(client, MessageType.SessionSyncIndex, { limit: 10 }, deviceToken);
  const index = await waitForMessage(client, MessageType.SessionSyncIndexResult, 5000);
  const entry = index.payload.sessions.find((item) => item.session.session_id === 'gap-session');
  if (!entry) {
    throw new Error('Expected gap-session in initial sync index.');
  }
  assertEqual(entry.timeline_oldest_cursor, 2, 'oldest cursor after cache trim');
  assertEqual(entry.timeline_newest_cursor, 3, 'newest cursor after cache trim');

  send(client, MessageType.SessionSyncAck, {
    sessions: [{
      session_id: 'gap-session',
      seen_snapshot_revision: entry.snapshot_revision,
      seen_stage_revision: entry.stage_revision,
      seen_timeline_cursor: 1,
      seen_sync_revision: entry.sync_revision
    }]
  }, deviceToken);
  await waitForMessage(client, MessageType.Ack, 5000);

  send(client, MessageType.SessionSyncIndex, { limit: 10 }, deviceToken);
  const gapIndex = await waitForMessage(client, MessageType.SessionSyncIndexResult, 5000);
  const gapEntry = gapIndex.payload.sessions.find((item) => item.session.session_id === 'gap-session');
  if (!gapEntry) {
    throw new Error('Expected gap-session after acking stale timeline cursor.');
  }
  if (!gapEntry.dirty_reasons.includes('cursor_gap')) {
    throw new Error(`Expected cursor_gap dirty reason, got ${gapEntry.dirty_reasons.join(',')}`);
  }
  assertEqual(gapEntry.recommended_action, 'resync_from_host', 'cursor gap recommended action');

  host.close();
  client.close();
  console.log('[verify] Relay sync cursor-gap detection verified.');
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
    RELAY_TIMELINE_CACHE_LIMIT: '2',
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
      device_id: 'gap-device',
      display_name: 'Gap Device'
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

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}
