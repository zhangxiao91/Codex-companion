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

const processes = [];
const relayPort = '8812';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const devToken = 'git-audit-storage-token';
const tempDir = await mkdtemp(join(tmpdir(), 'cmc-git-audit-'));
const auditPath = join(tempDir, 'git-audit.ndjson');

try {
  let relay = await startRelay();
  const deviceToken = await pairDevice(relayPort, devToken);

  const bridge = spawnProcess('bridge', 'node', ['bridge/host-bridge/index.mjs'], {
    ...process.env,
    RELAY_URL: relayUrl,
    RELAY_DEV_TOKEN: devToken,
    GIT_WRITE_ACTIONS_ENABLED: 'false'
  });
  processes.push(bridge);
  await waitForOutput(bridge, '[bridge] connected', 5000);
  await waitForOutput(relay, 'session snapshot: mock-session-001', 5000);

  const client = await connect(relayUrl);
  send(client, MessageType.SessionSubscribe, { session_id: '*' }, deviceToken);
  await waitForSession(client, 'mock-session-001', 5000);

  const completedAudit = waitForGitAudit(client, 'completed', 'status', 5000);
  send(client, MessageType.GitRequest, {
    session_id: 'mock-session-001',
    action: 'status'
  }, deviceToken);
  await waitForGitSnapshot(client, 'status', 5000);
  await completedAudit;
  client.close();

  const audit = await readAudit(relayPort, deviceToken, 'session_id=mock-session-001&limit=10');
  if (audit.count < 2) {
    throw new Error(`Expected at least 2 audit events before restart, received ${audit.count}`);
  }
  if (!audit.events.some((event) => event.phase === 'completed' && event.action === 'status')) {
    throw new Error('Expected completed status audit event before restart.');
  }

  stopProcess(relay);
  await delay(350);
  relay = await startRelay();

  const restoredAudit = await readAudit(relayPort, devToken, 'action=status&limit=10');
  if (restoredAudit.count < 2) {
    throw new Error(`Expected restored audit events after restart, received ${restoredAudit.count}`);
  }
  if (!restoredAudit.events.every((event) => event.action === 'status')) {
    throw new Error('Expected action filter to return only status events.');
  }

  const health = await readHealth(relayPort, devToken);
  if (health.audit?.persistent_git_audit_enabled !== true) {
    throw new Error('Expected health to report persistent git audit enabled.');
  }

  console.log('[verify] Git audit persistent storage and query endpoint verified.');
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
    RELAY_SQLITE_PATH: join(tempDir, 'relay.sqlite'),
    RELAY_GIT_AUDIT_LOG_PATH: auditPath,
    RELAY_AUDIT_LOG_LIMIT: '50'
  });
  processes.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);
  return relay;
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

async function pairDevice(port, pairingToken) {
  const response = await fetch(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Relay-Dev-Token': pairingToken
    },
    body: JSON.stringify({
      device_id: 'git-audit-storage-client',
      display_name: 'Git Audit Storage Client'
    })
  });

  if (!response.ok) {
    throw new Error(`Pairing failed with HTTP ${response.status}`);
  }

  const pair = await response.json();
  if (!pair.device_token) {
    throw new Error('Pairing response did not include device_token.');
  }

  return pair.device_token;
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

function waitForSession(socket, sessionId, timeoutMs) {
  return waitForMessage(socket, timeoutMs, (message) => (
    message.type === MessageType.SessionSnapshot
      && message.payload.session.session_id === sessionId
      ? message.payload.session
      : undefined
  ));
}

function waitForGitSnapshot(socket, action, timeoutMs) {
  return waitForMessage(socket, timeoutMs, (message) => (
    message.type === MessageType.GitSnapshot
      && message.payload.snapshot.action === action
      ? message.payload.snapshot
      : undefined
  ));
}

function waitForGitAudit(socket, phase, action, timeoutMs) {
  return waitForMessage(socket, timeoutMs, (message) => {
    if (message.type !== MessageType.TimelineEvent) {
      return undefined;
    }

    const event = message.payload.event;
    return event.type === 'git_audit'
      && event.payload?.phase === phase
      && event.payload?.action === action
      ? event
      : undefined;
  });
}

function waitForMessage(socket, timeoutMs, selector) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
    };
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error('Timed out waiting for WebSocket message.'));
    }, timeoutMs);

    const onMessage = (event) => {
      const message = decodeMessage(event.data);
      if (message.type === MessageType.Error) {
        cleanup();
        reject(new Error(message.payload.detail));
        return;
      }

      const selected = selector(message);
      if (selected !== undefined) {
        cleanup();
        resolve(selected);
      }
    };

    socket.addEventListener('message', onMessage);
  });
}

function send(socket, type, payload, token) {
  socket.send(encodeMessage(createMessage(type, payload, {
    auth: {
      token
    }
  })));
}

async function readAudit(port, token, query) {
  const response = await fetch(`http://127.0.0.1:${port}/git/audit?${query}`, {
    headers: {
      'X-Relay-Auth-Token': token
    }
  });

  if (!response.ok) {
    throw new Error(`Audit query failed with HTTP ${response.status}`);
  }

  return response.json();
}

async function readHealth(port, token) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: {
      'X-Relay-Auth-Token': token
    }
  });

  if (!response.ok) {
    throw new Error(`Health check failed with HTTP ${response.status}`);
  }

  return response.json();
}
