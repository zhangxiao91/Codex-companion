import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
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
const originalFixture = await readFile(diffFixturePath, 'utf8');

try {
  await writeFile(diffFixturePath, `${originalFixture}\n<!-- verify-git-flow temporary diff -->\n`);

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

  send(client, MessageType.GitRequest, {
    session_id: 'mock-session-001',
    action: 'status'
  }, deviceToken);
  const statusSnapshot = await waitForGitSnapshot(client, 'status', 5000);
  if (statusSnapshot.session_id !== 'mock-session-001') {
    throw new Error(`Unexpected git snapshot session: ${statusSnapshot.session_id}`);
  }
  if (!statusSnapshot.is_git_repo) {
    throw new Error(`Expected workspace to be a git repo: ${statusSnapshot.error}`);
  }

  send(client, MessageType.GitRequest, {
    session_id: 'mock-session-001',
    action: 'diff',
    file_path: diffFixturePath
  }, deviceToken);
  const diffSnapshot = await waitForGitSnapshot(client, 'diff', 5000);
  if (diffSnapshot.selected_file_path !== diffFixturePath) {
    throw new Error(`Unexpected selected diff file: ${diffSnapshot.selected_file_path}`);
  }
  if (!diffSnapshot.selected_file_diff.includes('verify-git-flow temporary diff')) {
    throw new Error('Expected file-level diff to include temporary fixture change.');
  }

  send(client, MessageType.GitRequest, {
    session_id: 'mock-session-001',
    action: 'commit',
    message: 'Verify disabled mobile commit'
  }, deviceToken);
  const commitSnapshot = await waitForGitSnapshot(client, 'commit', 5000);
  if (commitSnapshot.result?.ok !== false) {
    throw new Error('Expected commit to be disabled by default.');
  }

  await waitForOutput(bridge, 'received git status for mock-session-001', 5000);
  await waitForOutput(bridge, 'received git diff for mock-session-001', 5000);
  await waitForOutput(bridge, 'received git commit for mock-session-001', 5000);
  client.close();
  console.log('[verify] Git status and file diff snapshot flow verified.');
} finally {
  await writeFile(diffFixturePath, originalFixture);

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
