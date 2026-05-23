import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const tempDir = await mkdtemp(join(tmpdir(), 'cmc-power-control-'));
const relayPort = '8841';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const hostToken = 'power-control-host-token';
const pairingToken = 'power-control-pairing-token';
const hostId = 'power-host';
const identityPath = join(tempDir, 'host-identity.json');
const policyPath = join(tempDir, 'host-policy.json');
const sqlitePath = join(tempDir, 'relay.sqlite');
const children = [];

try {
  await writeFile(policyPath, `${JSON.stringify({
    power_control: {
      enabled: true,
      allow_keep_awake: true,
      allow_lock: true,
      max_keep_awake_seconds: 3600,
      allow_on_battery: true,
      trust_ttl_seconds: 3600,
      challenge_ttl_seconds: 300,
      max_challenge_attempts: 5
    }
  }, null, 2)}\n`, 'utf8');

  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_PORT: relayPort,
    RELAY_HOST_TOKEN: hostToken,
    RELAY_PAIRING_TOKEN: pairingToken,
    RELAY_SQLITE_PATH: sqlitePath,
    RELAY_IDENTITY_STORE_PATH: join(tempDir, 'identity-store.json'),
    RELAY_GIT_AUDIT_LOG_PATH: join(tempDir, 'git-audit.ndjson')
  });
  children.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);

  const bridge = spawnProcess('bridge', 'node', ['bridge/host-bridge/index.mjs'], {
    ...process.env,
    RELAY_URL: relayUrl,
    RELAY_HOST_TOKEN: hostToken,
    HOST_ID: hostId,
    HOST_NAME: 'Power Host',
    HOST_IDENTITY_PATH: identityPath,
    HOST_POLICY_PATH: policyPath,
    CODEX_ADAPTER: 'mock',
    CMC_POWER_MOCK: '1'
  });
  children.push(bridge);
  await waitForOutput(bridge, 'registered host capabilities', 5000);

  const pairResponse = await fetch(`http://127.0.0.1:${relayPort}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Relay-Pairing-Token': pairingToken
    },
    body: JSON.stringify({
      device_id: 'power-android',
      display_name: 'Power Android'
    })
  });
  if (!pairResponse.ok) {
    throw new Error(`Pairing failed with HTTP ${pairResponse.status}`);
  }
  const paired = await pairResponse.json();
  const client = await openClient(paired.device_token);
  children.push({ kill: () => client.close(), killed: false });

  client.sendJson('session.subscribe', { session_id: '*' });
  await waitForClientMessage(client, (message) => message.type === 'power.status' && message.payload.host_id === hostId, 5000);

  client.sendJson('power.trust.request', { host_id: hostId });
  const challenge = await waitForClientMessage(client, (message) => message.type === 'power.trust.challenge', 5000);
  const code = await waitForPowerCode(bridge, 5000);
  client.sendJson('power.trust.verify', {
    host_id: hostId,
    challenge_id: challenge.payload.challenge_id,
    code
  });
  const granted = await waitForClientMessage(client, (message) => message.type === 'power.trust.granted', 5000);
  if (!granted.payload.trust?.capabilities?.includes('power.keep_awake')) {
    throw new Error('Power trust did not grant keep_awake capability.');
  }

  client.sendJson('power.request', {
    host_id: hostId,
    action: 'keep_awake',
    duration_seconds: 120
  });
  const keepAwakeResult = await waitForClientMessage(client, (message) => message.type === 'power.result' && message.payload.action === 'keep_awake', 5000);
  if (keepAwakeResult.payload.status !== 'accepted') {
    throw new Error(`keep_awake was not accepted: ${keepAwakeResult.payload.reason}`);
  }

  client.sendJson('power.request', {
    host_id: hostId,
    action: 'lock'
  });
  const lockResult = await waitForClientMessage(client, (message) => message.type === 'power.result' && message.payload.action === 'lock', 5000);
  if (lockResult.payload.status !== 'accepted') {
    throw new Error(`lock was not accepted: ${lockResult.payload.reason}`);
  }

  const healthResponse = await fetch(`http://127.0.0.1:${relayPort}/health`, {
    headers: { 'X-Relay-Host-Token': hostToken }
  });
  const health = await healthResponse.json();
  if (health.storage?.counts?.power_control_trusts !== 1) {
    throw new Error(`Expected one persisted power trust, got ${health.storage?.counts?.power_control_trusts}`);
  }
  if ((health.storage?.counts?.power_audit_events ?? 0) < 4) {
    throw new Error(`Expected power audit events, got ${health.storage?.counts?.power_audit_events}`);
  }

  console.log('[verify] Power control trust and request flow verified.');
} finally {
  for (const child of children.reverse()) {
    stopProcess(child);
  }
  await delay(500);
  await rm(tempDir, { recursive: true, force: true });
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

function stopProcess(child) {
  if (child && !child.killed) {
    child.kill();
  }
}

async function openClient(deviceToken) {
  const socket = new WebSocket(relayUrl);
  socket.messages = [];
  socket.addEventListener('message', (event) => {
    socket.messages.push(JSON.parse(event.data));
  });
  socket.sendJson = (type, payload) => {
    socket.send(JSON.stringify({
      id: crypto.randomUUID(),
      type,
      sent_at: new Date().toISOString(),
      payload,
      auth: { token: deviceToken }
    }));
  };
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return socket;
}

async function waitForClientMessage(socket, predicate, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const index = socket.messages.findIndex(predicate);
    if (index >= 0) {
      const [message] = socket.messages.splice(index, 1);
      return message;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for client message. Saw: ${JSON.stringify(socket.messages)}`);
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

async function waitForPowerCode(child, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = child.output.match(/Power control verification code[^:]*:\s*(\d{6})/);
    if (match) {
      return match[1];
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for power code.\n${child.output}`);
}
