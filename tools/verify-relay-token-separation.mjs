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

const relayPort = '8823';
const httpUrl = `http://127.0.0.1:${relayPort}`;
const wsUrl = `ws://127.0.0.1:${relayPort}`;
const pairingToken = 'token-separation-pairing-token';
const hostToken = 'token-separation-host-token';
const hostId = 'token-separation-host';
const sessionId = 'token-separation-session';
const tempDir = mkdtempSync(join(tmpdir(), 'cmc-token-separation-'));
const processes = [];

try {
  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_HOST: '127.0.0.1',
    RELAY_PORT: relayPort,
    RELAY_PAIRING_TOKEN: pairingToken,
    RELAY_HOST_TOKEN: hostToken,
    RELAY_IDENTITY_STORE_PATH: join(tempDir, 'identity-store.json'),
    RELAY_GIT_AUDIT_LOG_PATH: join(tempDir, 'git-audit.ndjson')
  });
  processes.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);

  const hostPair = await postPair(hostToken);
  if (hostPair.status !== 401) {
    throw new Error(`Expected host token to be rejected by /pair, received HTTP ${hostPair.status}.`);
  }

  const pair = await postPair(pairingToken);
  if (pair.status !== 200 || !pair.body.device_token) {
    throw new Error(`Expected pairing token to pair a device, received HTTP ${pair.status}.`);
  }
  const deviceToken = pair.body.device_token;

  await assertDetailedHealth('X-Relay-Pairing-Token', pairingToken);
  await assertDetailedHealth('X-Relay-Host-Token', hostToken);
  await assertDetailedHealth('authorization', `Bearer ${deviceToken}`);

  const rejectedHost = await connect(wsUrl);
  send(rejectedHost, MessageType.HostRegister, {
    host_id: 'pairing-token-host',
    display_name: 'Pairing Token Host',
    bridge_version: 'test',
    capabilities: []
  }, { token: pairingToken });
  const unauthorizedHost = await waitForMessage(rejectedHost, (message) => (
    message.type === MessageType.Error
  ), 5000);
  if (!unauthorizedHost.payload.detail.includes('Unauthorized')) {
    throw new Error(`Expected pairing-token host registration to be rejected: ${unauthorizedHost.payload.detail}`);
  }
  rejectedHost.close();

  const host = await connect(wsUrl);
  send(host, MessageType.HostRegister, {
    host_id: hostId,
    display_name: 'Token Separation Host',
    bridge_version: 'test',
    capabilities: ['session.list', 'session.prompt', 'timeline.event']
  }, { host_token: hostToken });
  send(host, MessageType.SessionSnapshot, {
    session: {
      session_id: sessionId,
      host_id: hostId,
      project_name: 'Token Separation Verify',
      repo_path: process.cwd(),
      branch: 'main',
      status: 'waiting_for_input',
      summary: 'Synthetic session for auth separation verification.',
      updated_at: new Date().toISOString()
    }
  }, { host_token: hostToken });
  await waitForOutput(relay, `session snapshot: ${sessionId}`, 5000);

  const unauthenticatedClient = await connect(wsUrl);
  send(unauthenticatedClient, MessageType.SessionPrompt, {
    session_id: sessionId,
    text: 'must be rejected'
  });
  const unauthorizedClient = await waitForMessage(unauthenticatedClient, (message) => (
    message.type === MessageType.Error
  ), 5000);
  if (!unauthorizedClient.payload.detail.includes('Unauthorized')) {
    throw new Error(`Expected unauthenticated client prompt to be rejected: ${unauthorizedClient.payload.detail}`);
  }
  unauthenticatedClient.close();

  const client = await connect(wsUrl);
  send(client, MessageType.SessionSubscribe, { session_id: '*' }, { device_token: deviceToken });
  await waitForMessage(client, (message) => (
    message.type === MessageType.SessionSnapshot
      && message.payload.session?.session_id === sessionId
  ), 5000);

  send(client, MessageType.SessionPrompt, {
    session_id: sessionId,
    text: 'must be routed'
  }, { device_token: deviceToken });
  const routedPrompt = await waitForMessage(host, (message) => (
    message.type === MessageType.SessionPrompt
      && message.payload.session_id === sessionId
  ), 5000);
  if (routedPrompt.payload.text !== 'must be routed') {
    throw new Error(`Expected routed prompt, received: ${routedPrompt.payload.text}`);
  }

  host.close();
  client.close();
  console.log('[verify] Relay pairing/host/device token separation verified.');
} finally {
  for (const child of processes.reverse()) {
    if (!child.killed) {
      child.kill();
    }
  }
  await delay(250);
  rmSync(tempDir, { recursive: true, force: true });
}

async function postPair(token) {
  const response = await fetch(`${httpUrl}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Relay-Pairing-Token': token
    },
    body: JSON.stringify({
      device_id: `verify-device-${token}`,
      display_name: 'Verify Device'
    })
  });

  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : {}
  };
}

async function assertDetailedHealth(headerName, headerValue) {
  const response = await fetch(`${httpUrl}/health`, {
    headers: {
      [headerName]: headerValue
    }
  });
  if (!response.ok) {
    throw new Error(`Health request failed for ${headerName} with HTTP ${response.status}.`);
  }
  const health = await response.json();
  if (typeof health.counts?.paired_devices !== 'number') {
    throw new Error(`Expected ${headerName} to authorize detailed health diagnostics.`);
  }
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

function waitForMessage(socket, selector, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for matching WebSocket message.'));
    }, timeoutMs);

    socket.addEventListener('message', (event) => {
      const message = decodeMessage(event.data);
      if (!selector(message)) {
        return;
      }

      clearTimeout(timer);
      resolve(message);
    });
  });
}

function send(socket, type, payload, auth = {}) {
  socket.send(encodeMessage(createMessage(type, payload, Object.keys(auth).length ? { auth } : {})));
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
