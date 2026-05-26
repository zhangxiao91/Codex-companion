import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const relayPort = '8838';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const pairingToken = 'connection-shortcuts-pairing-token';
const hostToken = 'connection-shortcuts-host-token';
const tempDir = mkdtempSync(join(tmpdir(), 'cmc-connection-shortcuts-'));
const serverConfigPath = join(tempDir, 'server-relay-config.json');
const bridgeConfigPath = join(tempDir, 'windows-host-bridge-config.json');
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
    host_id: 'connection-shortcut-host',
    host_name: 'Connection Shortcut Host',
    codex_adapter: 'mock',
    host_identity_path: join(tempDir, 'host-identity.json')
  });

  const pairing = spawnProcess('pairing', 'node', ['tools/server-pairing-code.mjs'], cleanEnv({
    CMC_SERVER_RELAY_CONFIG: serverConfigPath,
    CMC_PAIRING_QR: 'none'
  }));
  processes.push(pairing);
  await waitForOutput(pairing, '[pairing] Pairing code:', 5000);
  await waitForExit(pairing, 5000);

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
  await waitForOutput(bridge, '[server-bridge] Relay URL: ws://127.0.0.1:8838', 5000);
  await waitForOutput(relay, 'host registered: connection-shortcut-host', 5000);
  await waitForOutput(relay, 'session snapshot: mock-session-001', 5000);

  console.log('[verify] Connection shortcut config fallback verified.');
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
    'HOST_IDENTITY_PATH'
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

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for process exit after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Process exited with code ${code}`));
      }
    });
  });
}
