import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const relayPort = '8813';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const devToken = 'git-push-disposable-token';
const tempDir = await mkdtemp(join(tmpdir(), 'cmc-git-push-'));
const workRepo = join(tempDir, 'work');
const remoteRepo = join(tempDir, 'remote.git');
const auditPath = join(tempDir, 'git-audit.ndjson');

try {
  await setupDisposableRepos();

  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_PORT: relayPort,
    RELAY_DEV_TOKEN: devToken,
    RELAY_GIT_AUDIT_LOG_PATH: auditPath
  });
  processes.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);
  const deviceToken = await pairDevice(relayPort, devToken);

  const bridge = spawnProcess('bridge', 'node', ['bridge/host-bridge/index.mjs'], {
    ...process.env,
    RELAY_URL: relayUrl,
    RELAY_DEV_TOKEN: devToken,
    MOCK_SESSION_REPO_PATH: workRepo,
    GIT_WRITE_ACTIONS_ENABLED: 'true',
    GIT_PUSH_ACTIONS_ENABLED: 'true'
  });
  processes.push(bridge);
  await waitForOutput(bridge, '[bridge] connected', 5000);
  await waitForOutput(relay, 'session snapshot: mock-session-001', 5000);

  const client = await connect(relayUrl);
  send(client, MessageType.SessionSubscribe, { session_id: '*' }, deviceToken);
  await waitForSession(client, 'mock-session-001', 5000);

  const statusCompletedAudit = waitForGitAudit(client, 'completed', 'status', 5000);
  send(client, MessageType.GitRequest, {
    session_id: 'mock-session-001',
    action: 'status'
  }, deviceToken);
  const statusSnapshot = await waitForGitSnapshot(client, 'status', 5000);
  await statusCompletedAudit;
  if (!statusSnapshot.is_git_repo || statusSnapshot.files.length !== 0) {
    throw new Error(`Expected clean disposable repo, status=${statusSnapshot.status_summary}`);
  }

  const pushCompletedAuditPromise = waitForGitAudit(client, 'completed', 'push', 5000);
  send(client, MessageType.GitRequest, {
    session_id: 'mock-session-001',
    action: 'push'
  }, deviceToken);
  const pushSnapshot = await waitForGitSnapshot(client, 'push', 5000);
  const pushCompletedAudit = await pushCompletedAuditPromise;
  if (pushSnapshot.result?.ok !== true) {
    throw new Error(`Expected disposable push to succeed: ${pushSnapshot.result?.message}`);
  }
  if (pushCompletedAudit.payload.result_ok !== true) {
    throw new Error('Expected push audit result to be ok.');
  }

  const remoteHead = await runGit(remoteRepo, ['rev-parse', 'refs/heads/main']);
  if (remoteHead.exitCode !== 0 || !remoteHead.output.trim()) {
    throw new Error(`Expected remote main branch after push: ${remoteHead.error || remoteHead.output}`);
  }

  client.close();
  console.log('[verify] Disposable Git push through Relay/Bridge verified.');
} finally {
  for (const child of processes.reverse()) {
    if (child && !child.killed) {
      child.kill();
    }
  }

  await rm(tempDir, { recursive: true, force: true });
  await delay(250);
}

async function setupDisposableRepos() {
  await mkdir(workRepo, { recursive: true });
  await mkdir(remoteRepo, { recursive: true });
  await runGitOrThrow(tempDir, ['init', '--bare', remoteRepo]);
  await runGitOrThrow(workRepo, ['init', '-b', 'main']);
  await runGitOrThrow(workRepo, ['config', 'user.email', 'codex-mobile@example.invalid']);
  await runGitOrThrow(workRepo, ['config', 'user.name', 'Codex Mobile Verify']);
  await writeFile(join(workRepo, 'README.md'), '# Disposable push verification\n', 'utf8');
  await runGitOrThrow(workRepo, ['add', 'README.md']);
  await runGitOrThrow(workRepo, ['commit', '-m', 'Initial disposable commit']);
  await runGitOrThrow(workRepo, ['remote', 'add', 'origin', remoteRepo]);
  await runGitOrThrow(workRepo, ['push', '-u', 'origin', 'main']);
  await writeFile(join(workRepo, 'README.md'), '# Disposable push verification\n\nSecond commit through Relay.\n', 'utf8');
  await runGitOrThrow(workRepo, ['add', 'README.md']);
  await runGitOrThrow(workRepo, ['commit', '-m', 'Second disposable commit']);
}

async function runGitOrThrow(cwd, args) {
  const result = await runGit(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error || result.output}`);
  }
  return result;
}

function runGit(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    let error = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      error += chunk.toString();
    });
    child.on('error', (spawnError) => {
      resolve({
        exitCode: 1,
        output,
        error: spawnError.message
      });
    });
    child.on('close', (exitCode) => {
      resolve({
        exitCode,
        output,
        error
      });
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
      device_id: 'git-push-disposable-client',
      display_name: 'Git Push Disposable Client'
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
