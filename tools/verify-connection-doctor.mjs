import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const relayPort = '8841';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const pairingToken = 'doctor-pairing-token';
const hostToken = 'doctor-host-token';
const tempDir = mkdtempSync(join(tmpdir(), 'cmc-connection-doctor-'));
const serverConfigPath = join(tempDir, 'server-relay-config.json');
const bridgeConfigPath = join(tempDir, 'windows-host-bridge-config.json');
const hostIdentityPath = join(tempDir, 'host-identity.json');
const bridgeLogPath = join(tempDir, 'windows-host-bridge.log');
const processes = [];

try {
  writeJson(serverConfigPath, {
    version: 1,
    relay_host: '127.0.0.1',
    relay_port: relayPort,
    public_ws_url: relayUrl,
    public_http_url: `http://127.0.0.1:${relayPort}`,
    pairing_token: pairingToken,
    host_token: hostToken,
    sqlite_path: join(tempDir, 'relay.sqlite'),
    allow_insecure_server_relay: '1',
    pairing_qr: 'none'
  });
  writeJson(bridgeConfigPath, {
    version: 1,
    relay_url: relayUrl,
    host_token: hostToken,
    host_id: 'doctor-host',
    host_name: 'Doctor Host',
    codex_adapter: 'mock',
    host_identity_path: hostIdentityPath,
    log_path: bridgeLogPath
  });

  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], cleanEnv({
    RELAY_PORT: relayPort,
    RELAY_PAIRING_TOKEN: pairingToken,
    RELAY_HOST_TOKEN: hostToken,
    RELAY_SQLITE_PATH: join(tempDir, 'relay.sqlite'),
    RELAY_IDENTITY_STORE_PATH: join(tempDir, 'identity-store.json'),
    RELAY_GIT_AUDIT_LOG_PATH: join(tempDir, 'git-audit.ndjson')
  }));
  processes.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);

  const bridge = spawnProcess('bridge', 'node', ['tools/server-host-bridge-start.mjs'], cleanEnv({
    CMC_SERVER_RELAY_CONFIG: serverConfigPath,
    CMC_WINDOWS_BRIDGE_CONFIG: bridgeConfigPath
  }));
  processes.push(bridge);
  await waitForOutput(relay, 'host registered: doctor-host', 5000);
  await waitForOutput(relay, 'session snapshot: mock-session-001', 5000);

  const doctor = spawnProcess('doctor', 'node', ['tools/connection-doctor.mjs'], cleanEnv({
    CMC_SERVER_RELAY_CONFIG: serverConfigPath,
    CMC_WINDOWS_BRIDGE_CONFIG: bridgeConfigPath
  }));
  await waitForExit(doctor, 8000);
  if (!doctor.output.includes('Overall: OK')) {
    throw new Error(`Doctor did not report Overall: OK.\n${doctor.output}`);
  }
  if (!doctor.output.includes('Host online')) {
    throw new Error(`Doctor did not check host online status.\n${doctor.output}`);
  }
  if (!doctor.output.includes('WebSocket probe')) {
    throw new Error(`Doctor did not check WebSocket connectivity.\n${doctor.output}`);
  }

  console.log('[verify] Connection doctor verified.');
} finally {
  for (const child of processes.reverse()) {
    stopProcess(child);
  }
  await delay(250);
  rmSync(tempDir, { recursive: true, force: true });
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function cleanEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of [
    'RELAY_URL',
    'RELAY_PUBLIC_WS_URL',
    'RELAY_ANDROID_URL',
    'RELAY_HOST_TOKEN',
    'RELAY_PAIRING_TOKEN',
    'RELAY_DEV_TOKEN',
    'DEV_TOKEN',
    'HOST_ID',
    'HOST_NAME',
    'CODEX_ADAPTER',
    'HOST_IDENTITY_PATH',
    'CMC_WINDOWS_BRIDGE_LOG_PATH'
  ]) {
    if (!(key in overrides)) {
      delete env[key];
    }
  }
  return env;
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

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    if (child.exitCode === 0) {
      return Promise.resolve();
    }
    return Promise.reject(new Error(`Process exited with code ${child.exitCode}`));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`Timed out waiting for process exit after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`Process exited with code ${code}`));
      }
    });
  });
}
