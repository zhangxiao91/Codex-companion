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

const relayPort = '8827';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const devToken = 'relay-sqlite-persistence-token';
const tempDir = await mkdtemp(join(tmpdir(), 'cmc-sqlite-'));
const sqlitePath = join(tempDir, 'relay.sqlite');
const processes = [];

try {
  let relay = await startRelay();
  const deviceToken = await pairDevice();

  const host = await connect(relayUrl);
  send(host, MessageType.HostRegister, {
    host_id: 'sqlite-host',
    display_name: 'SQLite Host',
    bridge_version: 'verify',
    capabilities: ['session.list', 'timeline.event', 'git.status']
  });
  send(host, MessageType.SessionSnapshot, {
    session: {
      session_id: 'sqlite-session',
      host_id: 'sqlite-host',
      project_name: 'SQLite Persistence',
      repo_path: process.cwd(),
      branch: 'main',
      status: 'running',
      summary: 'SQLite persistence verification session.',
      updated_at: new Date().toISOString()
    }
  });
  send(host, MessageType.TimelineEvent, {
    event: createTimelineEvent('sqlite-session', 'sqlite-event-1', 'SQLite timeline event')
  });
  await waitForOutput(relay, 'timeline event: SQLite timeline event', 5000);

  const client = await connect(relayUrl);
  send(client, MessageType.GitRequest, {
    session_id: 'sqlite-session',
    action: 'status'
  }, deviceToken);
  await waitForOutput(relay, 'routing git status to host sqlite-host: sqlite-session', 5000);
  send(host, MessageType.GitSnapshot, {
    snapshot: {
      audit_id: 'sqlite-audit',
      session_id: 'sqlite-session',
      host_id: 'sqlite-host',
      action: 'status',
      repo_path: process.cwd(),
      branch: 'main',
      is_git_repo: true,
      status_summary: 'clean',
      files: [],
      result: { ok: true, message: 'ok' },
      updated_at: new Date().toISOString()
    }
  });
  await waitForOutput(relay, 'git snapshot: sqlite-session status', 5000);
  host.close();
  client.close();

  stopProcess(relay);
  await delay(350);
  relay = await startRelay();

  const health = await readHealth();
  assertEqual(health.storage.kind, 'sqlite', 'storage kind');
  assertEqual(health.storage.counts.devices, 1, 'persisted devices');
  assertEqual(health.storage.counts.hosts, 1, 'persisted hosts');
  assertEqual(health.storage.counts.sessions, 1, 'persisted sessions');
  assertEqual(health.storage.counts.timeline_events >= 1, true, 'persisted timeline events');
  assertEqual(health.storage.counts.git_audit_events >= 2, true, 'persisted git audit events');

  const restoredClient = await connect(relayUrl);
  send(restoredClient, MessageType.SessionTimelineRequest, {
    session_id: 'sqlite-session',
    after_cursor: '0',
    cache_only: true
  }, deviceToken);
  const restoredTimeline = await waitForTimelineEvent(restoredClient, 5000);
  assertEqual(restoredTimeline.type, 'sqlite-event-1', 'restored timeline type');
  restoredClient.close();

  const audit = await readGitAudit();
  if (!audit.events.some((event) => event.phase === 'completed' && event.action === 'status')) {
    throw new Error('Expected completed git audit event after Relay restart.');
  }

  console.log('[verify] Relay SQLite persistence verified.');
} finally {
  for (const child of processes.reverse()) {
    stopProcess(child);
  }
  await delay(500);
  await rm(tempDir, { recursive: true, force: true });
  await delay(250);
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

function createTimelineEvent(sessionId, eventId, title) {
  return {
    event_id: eventId,
    session_id: sessionId,
    created_at: new Date().toISOString(),
    type: eventId,
    title,
    summary: title,
    payload: { source: 'verify-relay-sqlite-persistence' },
    redaction_level: 'none'
  };
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
      device_id: 'sqlite-device',
      display_name: 'SQLite Device'
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

async function readGitAudit() {
  const response = await fetch(`http://127.0.0.1:${relayPort}/git/audit?session_id=sqlite-session&limit=10`, {
    headers: {
      'X-Relay-Dev-Token': devToken
    }
  });
  if (!response.ok) {
    throw new Error(`Git audit failed with HTTP ${response.status}`);
  }
  return response.json();
}

function waitForTimelineEvent(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for timeline event after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.addEventListener('message', (event) => {
      const message = decodeMessage(event.data);
      if (message.type === MessageType.Error) {
        clearTimeout(timer);
        reject(new Error(message.payload.detail));
        return;
      }
      if (message.type === MessageType.TimelineEvent) {
        clearTimeout(timer);
        resolve(message.payload.event);
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

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}
