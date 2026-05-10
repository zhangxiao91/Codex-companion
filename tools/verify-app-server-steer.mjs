import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const processes = [];

try {
  const relayPort = '8795';
  const relayUrl = `ws://127.0.0.1:${relayPort}`;
  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_PORT: relayPort
  });
  processes.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);

  const bridge = spawnProcess('bridge', 'node', ['bridge/host-bridge/index.mjs'], {
    ...process.env,
    RELAY_URL: relayUrl,
    CODEX_ADAPTER: 'app-server',
    CODEX_APP_SERVER_PORT: '8796'
  });
  processes.push(bridge);
  await waitForOutput(bridge, '[bridge] app-server initialized', 15000);
  await waitForOutput(relay, '[relay] session snapshot', 10000);

  const client = spawnProcess('steer-client', 'node', ['tools/steer-client/index.mjs'], {
    ...process.env,
    RELAY_URL: relayUrl,
    STEER_CLIENT_TIMEOUT_MS: '60000'
  });
  processes.push(client);

  const exitCode = await waitForExit(client, 60000);
  if (exitCode !== 0) {
    throw new Error(`steer-client exited with code ${exitCode}`);
  }

  await waitForOutput(bridge, '[bridge] received prompt', 5000);
  await waitForOutput(client, 'steer event received', 5000);
  console.log('[verify] App Server turn/steer prompt routed through Relay.');
} finally {
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

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for process exit after ${timeoutMs}ms`));
    }, timeoutMs);

    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

