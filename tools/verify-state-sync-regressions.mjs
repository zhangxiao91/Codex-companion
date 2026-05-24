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
const relayPort = '8833';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const devToken = 'state-sync-regressions-token';
const tempDir = mkdtempSync(join(tmpdir(), 'cmc-state-sync-'));
const sqlitePath = join(tempDir, 'relay.sqlite');

try {
  let relay = await startRelay();
  const deviceToken = await pairDevice();

  const client = await connect(relayUrl);
  send(client, MessageType.SessionTimelineRequest, {
    session_id: 'stale-local-cache-session',
    cache_only: true,
    page: true
  }, deviceToken);
  const stalePage = await waitForTimelinePage(client, 'stale-local-cache-session', 5000);
  if (stalePage.events.length !== 0 || stalePage.source !== 'cache') {
    throw new Error(`Expected empty cache page for stale session, received ${JSON.stringify(stalePage)}`);
  }

  const host = await connect(relayUrl);
  send(host, MessageType.HostRegister, {
    host_id: 'state-sync-host',
    display_name: 'State Sync Host',
    bridge_version: 'verify',
    capabilities: ['session.list', 'timeline.event']
  }, devToken);
  send(host, MessageType.SessionSnapshot, {
    session: {
      session_id: 'state-sync-session',
      host_id: 'state-sync-host',
      project_name: 'State Sync',
      repo_path: process.cwd(),
      branch: 'main',
      status: 'running',
      summary: 'Should be recomputed from timeline on restart.',
      updated_at: '2026-05-24T01:00:00.000Z'
    }
  }, devToken);
  send(host, MessageType.TimelineEvent, {
    event: {
      event_id: 'state-sync-session:file',
      session_id: 'state-sync-session',
      created_at: '2026-05-24T01:01:00.000Z',
      type: 'file_changed',
      title: 'File patch updated',
      summary: '1 file change(s).',
      payload: { turn_id: 'turn-1' },
      redaction_level: 'none'
    }
  }, devToken);
  send(host, MessageType.TimelineEvent, {
    event: {
      event_id: 'state-sync-session:completed',
      session_id: 'state-sync-session',
      created_at: '2026-05-24T01:02:00.000Z',
      type: 'turn_completed',
      title: 'Turn completed',
      summary: 'Turn completed.',
      payload: { turn_id: 'turn-1' },
      redaction_level: 'none'
    }
  }, devToken);
  await waitForOutput(relay, 'timeline event: Turn completed', 5000);
  host.close();
  client.close();

  stopProcess(relay);
  await delay(350);
  relay = await startRelay();

  const restoredClient = await connect(relayUrl);
  send(restoredClient, MessageType.SessionSubscribe, { session_id: '*' }, deviceToken);
  const snapshot = await waitForSessionSnapshot(restoredClient, 'state-sync-session', 5000);
  if (snapshot.session.stage?.type !== 'completed') {
    throw new Error(`Expected restored session stage=completed, received ${JSON.stringify(snapshot.session.stage)}`);
  }

  restoredClient.close();
  console.log('[verify] State sync stale timeline and restored stage regressions verified.');
} finally {
  for (const child of processes.reverse()) {
    stopProcess(child);
  }
  await delay(250);
  rmSync(tempDir, { recursive: true, force: true });
}

async function startRelay() {
  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_PORT: relayPort,
    RELAY_DEV_TOKEN: devToken,
    RELAY_SQLITE_PATH: sqlitePath,
    RELAY_IDENTITY_STORE_PATH: join(tempDir, 'identity-store.json'),
    RELAY_GIT_AUDIT_LOG_PATH: join(tempDir, 'git-audit.ndjson')
  });
  processes.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);
  return relay;
}

function stopProcess(child) {
  if (child && !child.killed) {
    child.kill();
  }
}

async function pairDevice() {
  const response = await fetch(`http://127.0.0.1:${relayPort}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Relay-Dev-Token': devToken
    },
    body: JSON.stringify({
      device_id: 'state-sync-client',
      display_name: 'State Sync Client'
    })
  });
  if (!response.ok) {
    throw new Error(`Pairing failed with HTTP ${response.status}`);
  }
  const pair = await response.json();
  return pair.device_token;
}

function waitForTimelinePage(socket, sessionId, timeoutMs) {
  return waitForMessage(socket, timeoutMs, (message) => {
    if (message.type !== MessageType.TimelinePage) {
      return undefined;
    }
    return message.payload.session_id === sessionId ? message.payload : undefined;
  });
}

function waitForSessionSnapshot(socket, sessionId, timeoutMs) {
  return waitForMessage(socket, timeoutMs, (message) => {
    if (message.type !== MessageType.SessionSnapshot) {
      return undefined;
    }
    return message.payload.session?.session_id === sessionId ? message.payload : undefined;
  });
}

function waitForMessage(socket, timeoutMs, selector) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for WebSocket message.'));
    }, timeoutMs);

    socket.addEventListener('message', (event) => {
      const message = decodeMessage(event.data);
      if (message.type === MessageType.Error) {
        clearTimeout(timer);
        reject(new Error(message.payload.detail));
        return;
      }

      const selected = selector(message);
      if (selected !== undefined) {
        clearTimeout(timer);
        resolve(selected);
      }
    });
  });
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

function send(socket, type, payload, token) {
  socket.send(encodeMessage(createMessage(type, payload, {
    auth: {
      token
    }
  })));
}
