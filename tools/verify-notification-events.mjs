import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MessageType, createMessage, decodeMessage, encodeMessage } from '../packages/protocol/index.mjs';

const tempDir = await mkdtemp(join(tmpdir(), 'cmc-notifications-'));
const port = 8897 + Math.floor(Math.random() * 100);
const token = 'notification-verify-token';
const relay = spawn('node', ['relay/service/server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    RELAY_PORT: String(port),
    RELAY_HOST: '127.0.0.1',
    RELAY_DEV_TOKEN: token,
    RELAY_SQLITE_PATH: join(tempDir, 'relay.sqlite')
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

relay.stdout.on('data', (chunk) => process.stdout.write(`[relay] ${chunk}`));
relay.stderr.on('data', (chunk) => process.stderr.write(`[relay:err] ${chunk}`));

try {
  await waitForOutput(relay, '[relay] listening', 5000);
  const deviceToken = await pairDevice();
  const host = await openSocket();
  const client = await openSocket();
  send(client, MessageType.SessionSubscribe, { session_id: '*' }, deviceToken);

  send(host, MessageType.HostRegister, {
    host_id: 'notification-host',
    display_name: 'Notification Host',
    capabilities: ['session.list', 'timeline.event']
  });
  for (const sessionId of ['approval-session', 'input-session', 'completed-session', 'offline-session']) {
    send(host, MessageType.SessionSnapshot, {
      session: baseSession(sessionId, 'running')
    });
  }
  send(host, MessageType.ApprovalRequest, {
    approval: {
      approval_id: 'approval-001',
      session_id: 'approval-session',
      kind: 'shell',
      title: 'Run command',
      summary: 'Approve a command.',
      command: 'npm test',
      risk_level: 'medium',
      status: 'pending',
      requested_at: new Date().toISOString()
    }
  });
  const approval = await waitForNotification(client, 'approval_pending');
  assert.equal(approval.session_id, 'approval-session');

  send(host, MessageType.SessionSnapshot, {
    session: baseSession('input-session', 'waiting_for_input')
  });
  const needsInput = await waitForNotification(client, 'needs_input');
  assert.equal(needsInput.session_id, 'input-session');

  send(host, MessageType.TimelineEvent, {
    event: {
      event_id: 'completed-event',
      session_id: 'completed-session',
      created_at: new Date().toISOString(),
      type: 'turn_completed',
      title: 'Turn completed',
      summary: 'Turn completed.',
      payload: { turn_id: 'turn-001' },
      redaction_level: 'metadata'
    }
  });
  const completed = await waitForNotification(client, 'session_completed');
  assert.equal(completed.session_id, 'completed-session');

  host.close();
  const offline = await waitForNotification(client, 'host_offline');
  assert.equal(offline.host_id, 'notification-host');

  client.close();
  console.log('[verify] Relay notification events for approval, completion, needs-input, and host-offline verified.');
} finally {
  relay.kill();
  await new Promise((resolve) => relay.once('exit', resolve));
  await rm(tempDir, { recursive: true, force: true });
}

function baseSession(sessionId, status) {
  return {
    session_id: sessionId,
    host_id: 'notification-host',
    project_name: 'Notification Verify',
    repo_path: process.cwd(),
    branch: 'main',
    status,
    summary: 'Notification verification session.',
    updated_at: new Date().toISOString()
  };
}

async function openSocket() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.messages = [];
  socket.addEventListener('message', (event) => {
    socket.messages.push(decodeMessage(event.data));
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return socket;
}

async function pairDevice() {
  const response = await fetch(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-relay-pairing-token': token
    },
    body: JSON.stringify({
      device_id: 'notification-client',
      display_name: 'Notification verifier'
    })
  });
  if (!response.ok) {
    throw new Error(`Pair failed: HTTP ${response.status}`);
  }
  const json = await response.json();
  return json.device_token;
}

function send(socket, type, payload, authToken = token) {
  socket.send(encodeMessage(createMessage(type, payload, { auth: { token: authToken } })));
}

function waitForNotification(socket, kind) {
  return waitForMessage(socket, (message) => (
    message.type === MessageType.NotificationEvent
      && message.payload?.notification?.kind === kind
  ), 5000).then((message) => message.payload.notification);
}

function waitForMessage(socket, predicate, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const index = socket.messages.findIndex(predicate);
      if (index >= 0) {
        const [message] = socket.messages.splice(index, 1);
        clearInterval(timer);
        resolve(message);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for message.'));
      }
    }, 25);
  });
}

function waitForOutput(child, needle, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for output: ${needle}\n${output}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (output.includes(needle)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}
