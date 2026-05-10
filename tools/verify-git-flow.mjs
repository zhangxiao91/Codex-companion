import { spawn } from 'node:child_process';
import { rm, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MessageType,
  createMessage,
  decodeMessage,
  encodeMessage
} from '../packages/protocol/index.mjs';

const processes = [];
const relayPort = '8811';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const devToken = 'git-flow-token';
const diffFixturePath = 'README.md';
const untrackedFixturePath = 'verify-git-flow-untracked.tmp';
const originalFixture = await readFile(diffFixturePath, 'utf8');

try {
  await writeFile(diffFixturePath, `${originalFixture}\n<!-- verify-git-flow temporary diff -->\n`);
  await writeFile(untrackedFixturePath, 'temporary untracked fixture\n');

  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_PORT: relayPort,
    RELAY_DEV_TOKEN: devToken
  });
  processes.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);
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

  const statusRequestedAudit = waitForGitAudit(client, 'requested', 'status', 5000);
  const statusCompletedAudit = waitForGitAudit(client, 'completed', 'status', 5000);
  send(client, MessageType.GitRequest, {
    session_id: 'mock-session-001',
    action: 'status'
  }, deviceToken);
  const statusSnapshot = await waitForGitSnapshot(client, 'status', 5000);
  await statusRequestedAudit;
  await statusCompletedAudit;
  if (statusSnapshot.session_id !== 'mock-session-001') {
    throw new Error(`Unexpected git snapshot session: ${statusSnapshot.session_id}`);
  }
  if (!statusSnapshot.is_git_repo) {
    throw new Error(`Expected workspace to be a git repo: ${statusSnapshot.error}`);
  }
  if ((statusSnapshot.untracked_file_count ?? 0) < 1) {
    throw new Error('Expected at least one untracked file in git snapshot.');
  }
  if (!statusSnapshot.files.some((file) => file.path === untrackedFixturePath && file.tracked === false)) {
    throw new Error('Expected untracked fixture to be marked tracked=false.');
  }

  const diffRequestedAudit = waitForGitAudit(client, 'requested', 'diff', 5000);
  const diffCompletedAudit = waitForGitAudit(client, 'completed', 'diff', 5000);
  send(client, MessageType.GitRequest, {
    session_id: 'mock-session-001',
    action: 'diff',
    file_path: diffFixturePath
  }, deviceToken);
  const diffSnapshot = await waitForGitSnapshot(client, 'diff', 5000);
  const diffAudit = await diffRequestedAudit;
  await diffCompletedAudit;
  if (diffAudit.payload.file_path !== diffFixturePath) {
    throw new Error(`Expected diff audit file path ${diffFixturePath}, received ${diffAudit.payload.file_path}`);
  }
  if (diffSnapshot.selected_file_path !== diffFixturePath) {
    throw new Error(`Unexpected selected diff file: ${diffSnapshot.selected_file_path}`);
  }
  if (!diffSnapshot.selected_file_diff.includes('verify-git-flow temporary diff')) {
    throw new Error('Expected file-level diff to include temporary fixture change.');
  }

  const commitRequestedAudit = waitForGitAudit(client, 'requested', 'commit', 5000);
  const commitCompletedAuditPromise = waitForGitAudit(client, 'completed', 'commit', 5000);
  send(client, MessageType.GitRequest, {
    session_id: 'mock-session-001',
    action: 'commit',
    message: 'Verify disabled mobile commit',
    commit_strategy: 'include_untracked'
  }, deviceToken);
  const commitSnapshot = await waitForGitSnapshot(client, 'commit', 5000);
  await commitRequestedAudit;
  const commitCompletedAudit = await commitCompletedAuditPromise;
  if (commitCompletedAudit.payload.result_ok !== false) {
    throw new Error('Expected commit audit result to be blocked.');
  }
  if (commitSnapshot.result?.ok !== false) {
    throw new Error('Expected commit to be disabled by default.');
  }
  if (commitSnapshot.commit_strategy !== 'include_untracked') {
    throw new Error(`Expected include_untracked strategy, received ${commitSnapshot.commit_strategy}`);
  }
  if (!commitSnapshot.result?.message?.includes('stages tracked and untracked files')) {
    throw new Error('Expected commit result to preserve include_untracked strategy.');
  }

  const pushRequestedAudit = waitForGitAudit(client, 'requested', 'push', 5000);
  const pushCompletedAuditPromise = waitForGitAudit(client, 'completed', 'push', 5000);
  send(client, MessageType.GitRequest, {
    session_id: 'mock-session-001',
    action: 'push'
  }, deviceToken);
  const pushSnapshot = await waitForGitSnapshot(client, 'push', 5000);
  await pushRequestedAudit;
  const pushCompletedAudit = await pushCompletedAuditPromise;
  if (pushCompletedAudit.payload.result_ok !== false) {
    throw new Error('Expected push audit result to be blocked.');
  }
  if (pushSnapshot.result?.ok !== false) {
    throw new Error('Expected push to be disabled by default.');
  }
  if (!pushSnapshot.result?.message?.includes('GIT_PUSH_ACTIONS_ENABLED=true')) {
    throw new Error('Expected push result to mention the host push policy gate.');
  }

  const health = await readHealth(relayPort, deviceToken);
  if ((health.counts?.git_audit_events ?? 0) < 8) {
    throw new Error(`Expected at least 8 git audit events, received ${health.counts?.git_audit_events}`);
  }

  await waitForOutput(bridge, 'received git status for mock-session-001', 5000);
  await waitForOutput(bridge, 'received git diff for mock-session-001', 5000);
  await waitForOutput(bridge, 'received git commit for mock-session-001', 5000);
  await waitForOutput(bridge, 'received git push for mock-session-001', 5000);
  client.close();
  console.log('[verify] Git status, file diff, commit strategy, push policy, and audit flow verified.');
} finally {
  await writeFile(diffFixturePath, originalFixture);
  await rm(untrackedFixturePath, { force: true });

  for (const child of processes.reverse()) {
    if (!child.killed) {
      child.kill();
    }
  }

  await delay(250);
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

async function pairDevice(port, pairingToken) {
  const response = await fetch(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Relay-Dev-Token': pairingToken
    },
    body: JSON.stringify({
      device_id: 'git-flow-client',
      display_name: 'Git Flow Client'
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

async function readHealth(port, deviceToken) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: {
      'X-Relay-Device-Token': deviceToken
    }
  });

  if (!response.ok) {
    throw new Error(`Health check failed with HTTP ${response.status}`);
  }

  return response.json();
}
