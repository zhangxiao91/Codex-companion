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
const relayPort = '8836';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const devToken = 'host-timeline-error-page-token';
const tempDir = mkdtempSync(join(tmpdir(), 'cmc-host-timeline-error-page-'));

try {
  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_PORT: relayPort,
    RELAY_DEV_TOKEN: devToken,
    RELAY_SQLITE_PATH: join(tempDir, 'relay.sqlite'),
    RELAY_IDENTITY_STORE_PATH: join(tempDir, 'identity-store.json'),
    RELAY_GIT_AUDIT_LOG_PATH: join(tempDir, 'git-audit.ndjson')
  });
  processes.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);
  const deviceToken = await pairDevice();

  const bridge = spawnProcess('bridge', 'node', ['bridge/host-bridge/index.mjs'], {
    ...process.env,
    RELAY_URL: relayUrl,
    RELAY_DEV_TOKEN: devToken,
    CODEX_ADAPTER: 'mock',
    MOCK_TIMELINE_FAIL: '1'
  });
  processes.push(bridge);
  await waitForOutput(bridge, '[bridge] connected', 5000);
  await waitForOutput(relay, 'session snapshot: mock-session-001', 5000);

  const client = await connect(relayUrl);
  send(client, MessageType.SessionSubscribe, { session_id: '*' }, deviceToken);
  await waitForSession(client, 'mock-session-001', 5000);

  send(client, MessageType.SessionTimelineRequest, {
    session_id: 'mock-session-001',
    page: true,
    limit: 10
  }, deviceToken);

  const page = await waitForTimelinePage(client, 'host_error', 5000);
  assertEqual(page.session_id, 'mock-session-001', 'timeline page session id');
  assertEqual(page.source, 'host_error', 'timeline page source');
  if (!String(page.error ?? '').includes('Mock timeline failure')) {
    throw new Error(`Expected host_error page to include mock failure detail, received ${page.error}`);
  }

  await waitForOutput(bridge, 'timeline request failed for mock-session-001', 5000);
  client.close();
  console.log('[verify] Host timeline failure returns host_error page.');
} finally {
  for (const child of processes.reverse()) {
    stopProcess(child);
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
      device_id: 'host-timeline-error-page-client',
      display_name: 'Host Timeline Error Page Client'
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

function waitForSession(socket, sessionId, timeoutMs) {
  return waitForMessage(socket, timeoutMs, (message) => {
    if (message.type !== MessageType.SessionSnapshot) {
      return undefined;
    }
    return message.payload.session?.session_id === sessionId ? message.payload.session : undefined;
  });
}

function waitForTimelinePage(socket, source, timeoutMs) {
  return waitForMessage(socket, timeoutMs, (message) => {
    if (message.type !== MessageType.TimelinePage) {
      return undefined;
    }
    return message.payload.source === source ? message.payload : undefined;
  });
}

function waitForMessage(socket, timeoutMs, selector) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for WebSocket message after ${timeoutMs}ms`));
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

function send(socket, type, payload, token) {
  socket.send(encodeMessage(createMessage(type, payload, {
    auth: {
      token
    }
  })));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Expected ${label}=${expected}, received ${actual}`);
  }
}
