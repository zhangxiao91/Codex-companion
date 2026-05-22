import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MessageType,
  createMessage,
  decodeMessage,
  encodeMessage
} from '../packages/protocol/index.mjs';

const tempDir = await mkdtemp(join(tmpdir(), 'cmc-server-devices-'));
const relayPort = '8836';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const httpUrl = `http://127.0.0.1:${relayPort}`;
const pairingToken = 'server-devices-pairing-token';
const hostToken = 'server-devices-host-token';
const identityPath = join(tempDir, 'host-identity.json');
const children = [];

try {
  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_PORT: relayPort,
    RELAY_PAIRING_TOKEN: pairingToken,
    RELAY_HOST_TOKEN: hostToken,
    RELAY_SQLITE_PATH: join(tempDir, 'relay.sqlite'),
    RELAY_IDENTITY_STORE_PATH: join(tempDir, 'identity-store.json'),
    RELAY_GIT_AUDIT_LOG_PATH: join(tempDir, 'git-audit.ndjson')
  });
  children.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);

  const pair = await pairDevice('managed-android');
  const hostBridge = spawnProcess('bridge', 'node', ['bridge/host-bridge/index.mjs'], {
    ...process.env,
    RELAY_URL: relayUrl,
    RELAY_HOST_TOKEN: hostToken,
    HOST_ID: 'managed-host',
    HOST_NAME: 'Managed Host',
    HOST_IDENTITY_PATH: identityPath,
    CODEX_ADAPTER: 'mock'
  });
  children.push(hostBridge);
  await waitForOutput(hostBridge, 'saved host device trust', 5000);
  if (!existsSync(identityPath)) {
    throw new Error('Expected host identity file.');
  }
  const hostIdentity = JSON.parse(await readFile(identityPath, 'utf8'));

  const listed = await getJson('/devices');
  if (!listed.devices.some((device) => device.device_id === 'managed-android')) {
    throw new Error('Expected Android device in /devices.');
  }
  if (!listed.host_devices.some((device) => device.host_device_id === hostIdentity.host_device_id)) {
    throw new Error('Expected host device in /devices.');
  }

  await postJson('/devices/revoke', {
    type: 'android',
    device_id: 'managed-android'
  });
  await postJson('/devices/revoke', {
    type: 'host',
    host_device_id: hostIdentity.host_device_id
  });

  const afterRevoke = await getJson('/devices?include_revoked=1');
  const android = afterRevoke.devices.find((device) => device.device_id === 'managed-android');
  const host = afterRevoke.host_devices.find((device) => device.host_device_id === hostIdentity.host_device_id);
  if (!android?.revoked_at) {
    throw new Error('Expected Android revoked_at.');
  }
  if (!host?.revoked_at) {
    throw new Error('Expected host revoked_at.');
  }

  const rejectedClient = await connect(relayUrl);
  send(rejectedClient, MessageType.SessionSubscribe, { session_id: '*' }, { token: pair.device_token });
  const clientError = await waitForMessage(rejectedClient, MessageType.Error, 5000);
  if (!clientError.payload.detail.includes('Unauthorized')) {
    throw new Error(`Expected revoked Android token to be rejected, received ${clientError.payload.detail}`);
  }
  rejectedClient.close();

  const rejectedHost = await connect(relayUrl);
  send(rejectedHost, MessageType.HostRegister, {
    host_id: 'managed-host',
    display_name: 'Managed Host'
  }, { host_device_token: hostIdentity.host_device_token });
  const hostError = await waitForMessage(rejectedHost, MessageType.Error, 5000);
  if (!hostError.payload.detail.includes('Unauthorized')) {
    throw new Error(`Expected revoked host device token to be rejected, received ${hostError.payload.detail}`);
  }
  rejectedHost.close();

  const cli = spawnProcess('cli', 'node', ['tools/server-devices.mjs', 'list', '--all'], {
    ...process.env,
    RELAY_PUBLIC_HTTP_URL: httpUrl,
    RELAY_HOST_TOKEN: hostToken
  });
  await waitForExit(cli, 5000);
  if (!cli.output.includes('managed-android') || !cli.output.includes(hostIdentity.host_device_id)) {
    throw new Error('Expected server:devices CLI output to include revoked devices.');
  }

  console.log('[verify] Server device management verified.');
} finally {
  for (const child of children.reverse()) {
    stopProcess(child);
  }
  await delay(500);
  await rm(tempDir, { recursive: true, force: true });
}

async function pairDevice(deviceId) {
  const response = await fetch(`${httpUrl}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Relay-Pairing-Token': pairingToken
    },
    body: JSON.stringify({
      device_id: deviceId,
      display_name: 'Managed Android'
    })
  });
  if (!response.ok) {
    throw new Error(`Pairing failed with HTTP ${response.status}`);
  }
  return response.json();
}

async function getJson(path) {
  const response = await fetch(`${httpUrl}${path}`, {
    headers: {
      'X-Relay-Host-Token': hostToken
    }
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status} ${json.detail ?? ''}`);
  }
  return json;
}

async function postJson(path, body) {
  const response = await fetch(`${httpUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Relay-Host-Token': hostToken
    },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`POST ${path} failed: ${response.status} ${json.detail ?? ''}`);
  }
  return json;
}

function spawnProcess(label, command, args, env) {
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

function send(socket, type, payload, auth = {}) {
  socket.send(encodeMessage(createMessage(type, payload, {
    auth
  })));
}

function waitForMessage(socket, expectedType, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expectedType}`)), timeoutMs);
    socket.addEventListener('message', (event) => {
      const message = decodeMessage(event.data);
      if (message.type === expectedType) {
        clearTimeout(timer);
        resolve(message);
      }
    });
  });
}

async function waitForOutput(child, needle, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.output.includes(needle)) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for output: ${needle}\n${child.output}`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stopProcess(child);
      reject(new Error(`Timed out waiting for process exit after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Process exited with code ${code}\n${child.output}`));
      }
    });
  });
}

function stopProcess(child) {
  if (child && !child.killed) {
    child.kill();
  }
}
