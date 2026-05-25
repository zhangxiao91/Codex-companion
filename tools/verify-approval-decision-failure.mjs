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
const relayPort = '8835';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const devToken = 'approval-decision-failure-token';
const tempDir = mkdtempSync(join(tmpdir(), 'cmc-approval-decision-failure-'));
const sqlitePath = join(tempDir, 'relay.sqlite');

try {
  let relay = await startRelay();
  const deviceToken = await pairDevice();
  const host = await connect(relayUrl);
  registerHostAndSession(host);

  send(host, MessageType.ApprovalRequest, {
    approval: {
      approval_id: 'approval-decision-failure-001',
      session_id: 'approval-decision-failure-session',
      title: 'Approval that must remain pending',
      summary: 'Failed decision delivery must not resolve this approval.',
      command: 'echo ok',
      risk_level: 'medium',
      status: 'pending',
      requested_at: new Date().toISOString()
    }
  }, devToken);
  await waitForOutput(relay, 'approval requested: approval-decision-failure-001', 5000);

  host.close();
  await waitForOutput(relay, 'host disconnected: approval-decision-failure-host', 5000);

  const client = await connect(relayUrl);
  send(client, MessageType.ApprovalDecision, {
    approval_id: 'approval-decision-failure-001',
    decision: 'approve_once'
  }, deviceToken);
  const error = await waitForError(client, 'Host is offline: approval-decision-failure-host', 5000);
  assertEqual(error.payload.detail, 'Host is offline: approval-decision-failure-host', 'offline decision error');
  client.close();

  const healthAfterFailedDecision = await readHealth();
  assertEqual(healthAfterFailedDecision.storage.counts.approvals, 1, 'approval count after failed decision');

  stopProcess(relay);
  await delay(350);

  relay = await startRelay();
  const restoredClient = await connect(relayUrl);
  send(restoredClient, MessageType.SessionSubscribe, { session_id: '*' }, deviceToken);
  const restoredApproval = await waitForApprovalStatus(restoredClient, 'approval-decision-failure-001', 'pending', 5000);
  assertEqual(restoredApproval.summary, 'Failed decision delivery must not resolve this approval.', 'restored pending approval summary');
  restoredClient.close();

  console.log('[verify] Failed approval decision leaves persisted approval pending.');
} finally {
  for (const child of processes.reverse()) {
    stopProcess(child);
  }
  await delay(250);
  rmSync(tempDir, { recursive: true, force: true });
}

async function startRelay(extraEnv = {}) {
  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_PORT: relayPort,
    RELAY_DEV_TOKEN: devToken,
    RELAY_SQLITE_PATH: sqlitePath,
    RELAY_IDENTITY_STORE_PATH: join(tempDir, 'identity-store.json'),
    RELAY_GIT_AUDIT_LOG_PATH: join(tempDir, 'git-audit.ndjson'),
    RELAY_APPROVAL_CLEANUP_INTERVAL_MS: '0',
    ...extraEnv
  });
  processes.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);
  return relay;
}

function registerHostAndSession(host) {
  send(host, MessageType.HostRegister, {
    host_id: 'approval-decision-failure-host',
    display_name: 'Approval Decision Failure Host',
    bridge_version: 'verify',
    capabilities: ['session.list', 'timeline.event']
  }, devToken);
  send(host, MessageType.SessionSnapshot, {
    session: {
      session_id: 'approval-decision-failure-session',
      host_id: 'approval-decision-failure-host',
      project_name: 'Approval Decision Failure',
      repo_path: process.cwd(),
      branch: 'main',
      status: 'running',
      summary: 'Approval decision failure test session.',
      updated_at: new Date().toISOString()
    }
  }, devToken);
}

async function pairDevice() {
  const response = await fetch(`http://127.0.0.1:${relayPort}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Relay-Dev-Token': devToken
    },
    body: JSON.stringify({
      device_id: 'approval-decision-failure-client',
      display_name: 'Approval Decision Failure Client'
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

function waitForApprovalStatus(socket, approvalId, status, timeoutMs) {
  return waitForMessage(socket, timeoutMs, (message) => {
    if (message.type !== MessageType.ApprovalRequest) {
      return undefined;
    }
    const approval = message.payload.approval;
    if (approval.approval_id === approvalId && approval.status === status) {
      return approval;
    }
    return undefined;
  });
}

function waitForError(socket, expectedDetail, timeoutMs) {
  return waitForMessage(socket, timeoutMs, (message) => {
    if (message.type !== MessageType.Error) {
      return undefined;
    }
    return message.payload.detail === expectedDetail ? message : undefined;
  });
}

function waitForMessage(socket, timeoutMs, selector) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for WebSocket message after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.addEventListener('message', (event) => {
      const message = decodeMessage(event.data);
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
