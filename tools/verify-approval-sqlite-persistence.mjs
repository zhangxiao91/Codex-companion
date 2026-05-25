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
const relayPort = '8834';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const devToken = 'approval-sqlite-persistence-token';
const tempDir = mkdtempSync(join(tmpdir(), 'cmc-approval-sqlite-'));
const sqlitePath = join(tempDir, 'relay.sqlite');

try {
  let relay = await startRelay();
  const deviceToken = await pairDevice();
  let host = await connect(relayUrl);
  registerHostAndSession(host);

  send(host, MessageType.ApprovalRequest, {
    approval: {
      approval_id: 'approval-sqlite-001',
      session_id: 'approval-sqlite-session',
      title: 'Approve persisted action',
      summary: 'Pending approval should survive Relay restart.',
      command: 'echo ok',
      risk_level: 'medium',
      status: 'pending',
      requested_at: new Date().toISOString()
    }
  }, devToken);
  await waitForOutput(relay, 'approval requested: approval-sqlite-001', 5000);

  host.close();
  stopProcess(relay);
  await delay(350);

  relay = await startRelay();
  const restoredClient = await connect(relayUrl);
  send(restoredClient, MessageType.SessionSubscribe, { session_id: '*' }, deviceToken);
  const restoredApproval = await waitForApprovalStatus(restoredClient, 'approval-sqlite-001', 'pending', 5000);
  assertEqual(restoredApproval.summary, 'Pending approval should survive Relay restart.', 'restored approval summary');

  const healthWithApproval = await readHealth();
  assertEqual(healthWithApproval.storage.counts.approvals, 1, 'persisted approval count');

  host = await connect(relayUrl);
  registerHostAndSession(host);
  send(host, MessageType.TimelineEvent, {
    event: {
      event_id: 'approval-sqlite-session:approval-sqlite-001:resolved',
      session_id: 'approval-sqlite-session',
      created_at: new Date().toISOString(),
      type: 'approval_resolved',
      title: 'Approval resolved',
      summary: 'Decision: approve_once',
      payload: {
        approval_id: 'approval-sqlite-001',
        decision: 'approve_once'
      },
      redaction_level: 'none'
    }
  }, devToken);
  const resolvedApproval = await waitForApprovalStatus(restoredClient, 'approval-sqlite-001', 'approve_once', 5000);
  assertEqual(resolvedApproval.status, 'approve_once', 'resolved approval status');
  restoredClient.close();
  host.close();
  stopProcess(relay);
  await delay(20);

  relay = await startRelay({
    RELAY_APPROVAL_RESOLVED_TTL_MS: '1'
  });
  const healthAfterCleanup = await readHealth();
  assertEqual(healthAfterCleanup.storage.counts.approvals, 0, 'expired resolved approval cleanup count');

  console.log('[verify] Approval SQLite persistence and expiry cleanup verified.');
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
    host_id: 'approval-sqlite-host',
    display_name: 'Approval SQLite Host',
    bridge_version: 'verify',
    capabilities: ['session.list', 'timeline.event']
  }, devToken);
  send(host, MessageType.SessionSnapshot, {
    session: {
      session_id: 'approval-sqlite-session',
      host_id: 'approval-sqlite-host',
      project_name: 'Approval SQLite',
      repo_path: process.cwd(),
      branch: 'main',
      status: 'running',
      summary: 'Approval persistence test session.',
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
      device_id: 'approval-sqlite-client',
      display_name: 'Approval SQLite Client'
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
