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

const relayPort = '8822';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const devToken = 'offline-host-session-token';
const tempDir = mkdtempSync(join(tmpdir(), 'cmc-offline-host-'));
const processes = [];

try {
  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_PORT: relayPort,
    RELAY_DEV_TOKEN: devToken,
    RELAY_IDENTITY_STORE_PATH: join(tempDir, 'identity-store.json'),
    RELAY_GIT_AUDIT_LOG_PATH: join(tempDir, 'git-audit.ndjson'),
    RELAY_SQLITE_PATH: join(tempDir, 'relay.sqlite')
  });
  processes.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);

  const pair = await pairDevice();
  const host = await connect(relayUrl);
  send(host, MessageType.HostRegister, {
    host_id: 'offline-host',
    display_name: 'Offline Host',
    bridge_version: 'verify',
    capabilities: ['session.list', 'session.prompt', 'timeline.event']
  }, devToken);
  send(host, MessageType.SessionSnapshot, {
    session: {
      session_id: 'offline-session',
      host_id: 'offline-host',
      project_name: 'Offline Host Verify',
      repo_path: process.cwd(),
      branch: 'verify',
      status: 'waiting_for_input',
      summary: 'Session should remain visible after host disconnect.',
      updated_at: new Date().toISOString()
    }
  }, devToken);
  send(host, MessageType.TimelineEvent, {
    event: {
      event_id: 'offline-session:event-1',
      session_id: 'offline-session',
      created_at: new Date().toISOString(),
      type: 'assistant_message',
      title: 'Cached offline event',
      summary: 'Cached offline event',
      payload: { source: 'verify-relay-offline-host-sessions' },
      redaction_level: 'none'
    }
  }, devToken);

  await waitForOutput(relay, 'session snapshot: offline-session', 5000);
  await waitForOutput(relay, 'timeline event: Cached offline event', 5000);

  host.close();
  await waitForOutput(relay, 'host disconnected: offline-host', 5000);

  const client = await connect(relayUrl);
  send(client, MessageType.SessionSubscribe, { session_id: '*' }, pair.device_token);

  const snapshot = await waitForSessionSnapshot(client, 5000);
  if (snapshot.session.session_id !== 'offline-session') {
    throw new Error(`Expected offline-session snapshot, received ${snapshot.session.session_id}`);
  }

  send(client, MessageType.SessionTimelineRequest, {
    session_id: 'offline-session',
    after_cursor: '0',
    cache_only: true,
    page: true
  }, pair.device_token);

  const page = await waitForTimelinePage(client, 5000);
  if (page.session_id !== 'offline-session') {
    throw new Error(`Expected offline-session timeline page, received ${page.session_id}`);
  }

  if (!Array.isArray(page.events) || page.events.length === 0) {
    throw new Error('Expected cached timeline events for offline session.');
  }

  const healthResponse = await fetch(`http://127.0.0.1:${relayPort}/health`, {
    headers: {
      authorization: `Bearer ${pair.device_token}`
    }
  });
  const health = await healthResponse.json();
  if (health.counts.sessions !== 1) {
    throw new Error(`Expected one retained session after host disconnect, received ${health.counts.sessions}`);
  }

  client.close();
  console.log('[verify] Relay offline host sessions remain visible and replayable.');
} finally {
  for (const child of processes.reverse()) {
    if (!child.killed) {
      child.kill();
    }
  }
  await delay(250);
  rmSync(tempDir, { recursive: true, force: true });
}

async function pairDevice() {
  const response = await fetch(`http://127.0.0.1:${relayPort}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Relay-Dev-Token': devToken
    },
    body: JSON.stringify({
      device_id: 'offline-host-device',
      display_name: 'Offline Host Device'
    })
  });
  if (!response.ok) {
    throw new Error(`Pairing failed with HTTP ${response.status}`);
  }

  return response.json();
}

function waitForSessionSnapshot(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for session snapshot after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.addEventListener('message', (event) => {
      const message = decodeMessage(event.data);
      if (message.type === MessageType.Error) {
        clearTimeout(timer);
        reject(new Error(message.payload.detail));
        return;
      }

      if (message.type === MessageType.SessionSnapshot) {
        clearTimeout(timer);
        resolve(message.payload);
      }
    });
  });
}

function waitForTimelinePage(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for timeline page after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.addEventListener('message', (event) => {
      const message = decodeMessage(event.data);
      if (message.type === MessageType.Error) {
        clearTimeout(timer);
        reject(new Error(message.payload.detail));
        return;
      }

      if (message.type === MessageType.TimelinePage) {
        clearTimeout(timer);
        resolve(message.payload);
      }
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
