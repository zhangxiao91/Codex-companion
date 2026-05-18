import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MessageType,
  createMessage,
  createTimelineEvent,
  decodeMessage,
  encodeMessage
} from '../packages/protocol/index.mjs';

const startLocalRelay = process.env.CMC_SMOKE_START_LOCAL === '1';
const relayPort = process.env.RELAY_PORT ?? '8821';
const pairingToken = process.env.RELAY_PAIRING_TOKEN
  ?? process.env.RELAY_DEV_TOKEN
  ?? process.env.DEV_TOKEN
  ?? (startLocalRelay ? 'server-smoke-token' : '');
const hostToken = process.env.RELAY_HOST_TOKEN
  ?? process.env.RELAY_DEV_TOKEN
  ?? process.env.DEV_TOKEN
  ?? (startLocalRelay ? 'server-smoke-host-token' : '');
const httpUrl = trimTrailingSlash(process.env.RELAY_PUBLIC_HTTP_URL
  ?? process.env.RELAY_HTTP_URL
  ?? (startLocalRelay ? `http://127.0.0.1:${relayPort}` : ''));
const wsUrl = trimTrailingSlash(process.env.RELAY_PUBLIC_WS_URL
  ?? process.env.RELAY_URL
  ?? (startLocalRelay ? `ws://127.0.0.1:${relayPort}` : ''));
const timeoutMs = Number.parseInt(process.env.CMC_SMOKE_TIMEOUT_MS ?? '10000', 10);
const smokeId = `server-smoke-${Date.now()}`;
const hostId = process.env.CMC_SMOKE_HOST_ID ?? `${smokeId}-host`;
const sessionId = process.env.CMC_SMOKE_SESSION_ID ?? `${smokeId}-session`;
const tempDir = mkdtempSync(join(tmpdir(), 'cmc-server-smoke-'));
const processes = [];

if (!httpUrl) {
  throw new Error('Set RELAY_PUBLIC_HTTP_URL or RELAY_HTTP_URL to the server Relay HTTP URL.');
}

if (!wsUrl) {
  throw new Error('Set RELAY_PUBLIC_WS_URL or RELAY_URL to the server Relay WebSocket URL.');
}

if (!pairingToken) {
  throw new Error('Set RELAY_PAIRING_TOKEN or RELAY_DEV_TOKEN before running server smoke test.');
}

if (!hostToken) {
  throw new Error('Set RELAY_HOST_TOKEN or RELAY_DEV_TOKEN before running server smoke test.');
}

try {
  if (startLocalRelay) {
    const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
      ...process.env,
      RELAY_HOST: '127.0.0.1',
      RELAY_PORT: relayPort,
      RELAY_PAIRING_TOKEN: pairingToken,
      RELAY_HOST_TOKEN: hostToken,
      RELAY_PUBLIC_HTTP_URL: httpUrl,
      RELAY_PUBLIC_WS_URL: wsUrl,
      RELAY_IDENTITY_STORE_PATH: join(tempDir, 'identity-store.json'),
      RELAY_GIT_AUDIT_LOG_PATH: join(tempDir, 'git-audit.ndjson')
    });
    processes.push(relay);
    await waitForOutput(relay, '[relay] listening', timeoutMs);
  }

  const publicHealth = await getJson(`${httpUrl}/health`);
  if (!publicHealth.ok) {
    throw new Error('Relay public health did not return ok=true.');
  }

  const pair = await pairDevice();
  if (!pair.device_token) {
    throw new Error('Pairing did not return a device token.');
  }

  const authorizedHealth = await getJson(`${httpUrl}/health`, {
    authorization: `Bearer ${pair.device_token}`
  });
  if (!authorizedHealth.counts || typeof authorizedHealth.counts.paired_devices !== 'number') {
    throw new Error('Authorized health did not expose detailed Relay diagnostics.');
  }

  const host = await connect(wsUrl);
  const client = await connect(wsUrl);

  send(host, MessageType.HostRegister, {
    host_id: hostId,
    display_name: 'Server Smoke Host',
    kind: 'smoke_test',
    bridge_version: 'smoke',
    capabilities: ['session.list', 'session.prompt', 'timeline.event']
  }, hostToken);

  send(host, MessageType.SessionSnapshot, {
    session: {
      session_id: sessionId,
      host_id: hostId,
      project_name: 'Server Relay Smoke Test',
      repo_path: process.cwd(),
      branch: 'smoke',
      status: 'waiting_for_input',
      summary: 'Synthetic session for server Relay smoke testing.',
      updated_at: new Date().toISOString()
    }
  }, hostToken);

  send(client, MessageType.SessionSubscribe, { session_id: '*' }, pair.device_token);
  const snapshot = await waitForMessage(client, timeoutMs, (message) => (
    message.type === MessageType.SessionSnapshot
      && message.payload.session?.session_id === sessionId
  ));
  console.log(`[smoke] session visible: ${snapshot.payload.session.session_id}`);

  const promptText = 'server relay smoke prompt';
  send(client, MessageType.SessionPrompt, {
    session_id: sessionId,
    text: promptText
  }, pair.device_token);

  const routedPrompt = await waitForMessage(host, timeoutMs, (message) => (
    message.type === MessageType.SessionPrompt
      && message.payload.session_id === sessionId
  ));
  if (routedPrompt.payload.text !== promptText) {
    throw new Error(`Unexpected routed prompt text: ${routedPrompt.payload.text}`);
  }
  console.log('[smoke] prompt routed to host');

  send(host, MessageType.TimelineEvent, {
    event: createTimelineEvent(
      sessionId,
      'Server smoke prompt routed',
      'Relay routed a paired device prompt to a connected host and returned a timeline event.',
      { source: 'server-smoke-test' }
    )
  }, hostToken);

  await waitForMessage(client, timeoutMs, (message) => (
    message.type === MessageType.TimelineEvent
      && message.payload.event?.session_id === sessionId
      && message.payload.event?.title === 'Server smoke prompt routed'
  ));
  console.log('[smoke] timeline event returned to client');

  host.close();
  client.close();
  console.log('[smoke] Server Relay smoke test passed.');
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
  const response = await fetch(`${httpUrl}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Relay-Pairing-Token': pairingToken
    },
    body: JSON.stringify({
      device_id: `${smokeId}-device`,
      display_name: 'Server Smoke Device'
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Pairing failed with HTTP ${response.status}: ${text}`);
  }

  return response.json();
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GET ${url} failed with HTTP ${response.status}: ${text}`);
  }
  return response.json();
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out opening WebSocket ${url}`));
    }, timeoutMs);

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

function waitForMessage(socket, timeout, selector) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for matching WebSocket message.'));
    }, timeout);

    socket.addEventListener('message', (event) => {
      const message = decodeMessage(event.data);
      if (!selector(message)) {
        return;
      }

      clearTimeout(timer);
      resolve(message);
    });
  });
}

function send(socket, type, payload, token) {
  socket.send(encodeMessage(createMessage(type, payload, {
    auth: { token }
  })));
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

async function waitForOutput(child, needle, timeout) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (child.output.includes(needle)) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for output: ${needle}`);
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}
