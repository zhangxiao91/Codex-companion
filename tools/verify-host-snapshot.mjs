import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MessageType, createMessage, encodeMessage, decodeMessage } from '../packages/protocol/index.mjs';
import { spawn } from 'node:child_process';

const relayPort = 8842;
const devToken = 'host-snapshot-token';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const httpUrl = `http://127.0.0.1:${relayPort}`;
const processes = [];
const tempDir = await mkdtemp(join(tmpdir(), 'cmc-host-snapshot-'));

try {
  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    RELAY_PORT: String(relayPort),
    RELAY_DEV_TOKEN: devToken,
    RELAY_SQLITE_PATH: join(tempDir, 'relay.sqlite'),
    RELAY_IDENTITY_STORE_PATH: join(tempDir, 'identity-store.json'),
    RELAY_GIT_AUDIT_LOG_PATH: join(tempDir, 'git-audit.ndjson')
  });
  processes.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);

  const host = await connect(relayUrl);
  send(host, MessageType.HostRegister, {
    host_id: 'snapshot-host',
    display_name: 'Snapshot Host',
    capabilities: ['session.list', 'session.prompt'],
    bridge_version: 'verify'
  }, { dev_token: devToken });
  await waitForOutput(relay, 'host registered: snapshot-host', 5000);

  send(host, MessageType.SessionSnapshot, {
    session: {
      session_id: 'snapshot-session',
      host_id: 'snapshot-host',
      project_name: 'Snapshot Project',
      repo_path: '',
      branch: 'main',
      status: 'running',
      summary: 'Host snapshot verification',
      updated_at: new Date().toISOString()
    }
  }, { dev_token: devToken });
  await waitForOutput(relay, 'session snapshot: snapshot-session', 5000);

  const deviceToken = await pairDevice();
  const client = await connect(relayUrl);
  send(client, MessageType.SessionSubscribe, { session_id: '*' }, { device_token: deviceToken });
  const initialSnapshot = await waitForMessage(client, (message) => (
    message.type === MessageType.HostSnapshot
      && message.payload?.host?.host_id === 'snapshot-host'
      && message.payload?.host?.status === 'online'
      && message.payload?.session_count === 1
  ), 5000);

  if (initialSnapshot.payload.host.display_name !== 'Snapshot Host') {
    throw new Error('Expected host snapshot display name.');
  }

  host.close();
  const offlineSnapshot = await waitForMessage(client, (message) => (
    message.type === MessageType.HostSnapshot
      && message.payload?.host?.host_id === 'snapshot-host'
      && message.payload?.host?.status === 'offline'
      && message.payload?.session_count === 0
  ), 5000);

  if (!offlineSnapshot.payload.host.last_seen_at) {
    throw new Error('Expected offline host snapshot last_seen_at.');
  }

  console.log('[verify] Host snapshot routing verified.');
} finally {
  for (const process of processes.reverse()) {
    process.kill();
  }
  await delay(150);
  await rm(tempDir, { recursive: true, force: true });
}

function send(socket, type, payload, auth) {
  socket.send(encodeMessage(createMessage(type, payload, { auth })));
}

async function pairDevice() {
  const response = await fetch(`${httpUrl}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Relay-Pairing-Token': devToken
    },
    body: JSON.stringify({
      device_id: 'host-snapshot-device',
      display_name: 'Host Snapshot Verify'
    })
  });
  const json = await response.json();
  if (!response.ok || !json.device_token) {
    throw new Error(`Pairing failed with HTTP ${response.status}`);
  }
  return json.device_token;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => resolve(socket), { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
}

function waitForMessage(socket, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error(`Timed out waiting for message after ${timeoutMs}ms`));
    }, timeoutMs);

    const onMessage = (event) => {
      const message = decodeMessage(event.data);
      if (predicate(message)) {
        clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        resolve(message);
      }
    };

    socket.addEventListener('message', onMessage);
  });
}

function spawnProcess(label, command, args, env) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.output.includes(needle)) {
      return;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for output: ${needle}`);
}
