import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const processes = [];
const devToken = 'delivery-strategy-test-token';

try {
  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_DEV_TOKEN: devToken
  });
  processes.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);
  const deviceToken = await pairDevice(8787, devToken);

  const bridge = spawnProcess('bridge', 'node', ['bridge/host-bridge/index.mjs'], {
    ...process.env,
    RELAY_DEV_TOKEN: devToken
  });
  processes.push(bridge);
  await waitForOutput(bridge, '[bridge] connected', 5000);
  await waitForOutput(relay, '[relay] session snapshot', 5000);

  const client = spawnProcess('test-client', 'node', ['tools/test-client/index.mjs', '总结当前进度'], {
    ...process.env,
    RELAY_DEVICE_TOKEN: deviceToken
  });
  processes.push(client);

  const exitCode = await waitForExit(client, 10000);
  if (exitCode !== 0) {
    throw new Error(`test-client exited with code ${exitCode}`);
  }

  await waitForOutput(bridge, '[bridge] received prompt', 5000);
  console.log('[verify] Delivery Strategy main path verified.');
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

async function pairDevice(port, pairingToken) {
  const response = await fetch(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Relay-Dev-Token': pairingToken
    },
    body: JSON.stringify({
      device_id: 'delivery-strategy-test-client',
      display_name: 'Delivery Strategy Test Client'
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
