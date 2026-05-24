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
const relayPort = '8832';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const devToken = 'approval-replay-cleanup-token';
const tempDir = mkdtempSync(join(tmpdir(), 'cmc-approval-cleanup-'));

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
  const deviceToken = await pairDevice(relayPort, devToken);

  const host = await connect(relayUrl);
  send(host, MessageType.HostRegister, {
    host_id: 'approval-cleanup-host',
    display_name: 'Approval Cleanup Host',
    bridge_version: 'verify',
    capabilities: ['session.list', 'session.prompt']
  }, devToken);
  send(host, MessageType.SessionSnapshot, {
    session: {
      session_id: 'approval-cleanup-session',
      host_id: 'approval-cleanup-host',
      project_name: 'Approval Cleanup',
      repo_path: process.cwd(),
      branch: 'main',
      status: 'running',
      summary: 'Approval cleanup test session.',
      updated_at: new Date().toISOString()
    }
  }, devToken);
  send(host, MessageType.ApprovalRequest, {
    approval: {
      approval_id: 'approval-cleanup-001',
      session_id: 'approval-cleanup-session',
      title: 'Approve cleanup',
      summary: 'Waiting on approval.',
      command: 'echo ok',
      risk_level: 'medium',
      status: 'pending',
      requested_at: new Date().toISOString()
    }
  }, devToken);
  await waitForOutput(relay, 'approval requested: approval-cleanup-001', 5000);

  const client = await connect(relayUrl);
  send(client, MessageType.SessionSubscribe, { session_id: '*' }, deviceToken);
  const approval = await waitForApproval(client, 5000);
  if (approval.status !== 'pending') {
    throw new Error(`Expected pending approval, received ${approval.status}`);
  }

  send(host, MessageType.TimelineEvent, {
    event: {
      event_id: 'approval-cleanup-session:approval-cleanup-001:approval_resolved',
      session_id: 'approval-cleanup-session',
      created_at: new Date().toISOString(),
      type: 'approval_resolved',
      title: 'Approval resolved',
      summary: 'Decision: approve_once',
      payload: {
        approval_id: 'approval-cleanup-001',
        decision: 'approve_once'
      },
      redaction_level: 'none'
    }
  }, devToken);

  const resolved = await waitForApprovalStatus(client, 'approval-cleanup-001', 'approve_once', 5000);
  if (resolved.status !== 'approve_once') {
    throw new Error(`Expected approval to resolve, received ${resolved.status}`);
  }

  console.log('[verify] Approval replay cleanup verified.');
} finally {
  for (const child of processes.reverse()) {
    if (!child.killed) {
      child.kill();
    }
  }
  await delay(250);
  rmSync(tempDir, { recursive: true, force: true });
}

async function pairDevice(port, pairingToken) {
  const response = await fetch(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Relay-Dev-Token': pairingToken
    },
    body: JSON.stringify({
      device_id: 'approval-cleanup-client',
      display_name: 'Approval Cleanup Client'
    })
  });
  if (!response.ok) {
    throw new Error(`Pairing failed with HTTP ${response.status}`);
  }
  const pair = await response.json();
  return pair.device_token;
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

function waitForApproval(socket, timeoutMs) {
  return waitForMessage(socket, timeoutMs, (message) => (
    message.type === MessageType.ApprovalRequest ? message.payload.approval : undefined
  ));
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

function send(socket, type, payload, token) {
  socket.send(encodeMessage(createMessage(type, payload, {
    auth: {
      token
    }
  })));
}
