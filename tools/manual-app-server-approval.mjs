import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const processes = [];
const relayPort = process.env.MANUAL_RELAY_PORT ?? '8810';
const appServerPort = process.env.MANUAL_APP_SERVER_PORT ?? '8811';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const pairingToken = process.env.RELAY_DEV_TOKEN ?? `manual-${randomBytes(12).toString('base64url')}`;
const prompt = process.argv.slice(2).join(' ') || [
  'Run the harmless read-only command `node --version`.',
  'Wait for approval if prompted.',
  'After it completes, reply with a one-line summary.'
].join(' ');

try {
  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_HOST: process.env.RELAY_HOST ?? '0.0.0.0',
    RELAY_PORT: relayPort,
    RELAY_DEV_TOKEN: pairingToken
  });
  processes.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);

  const bridge = spawnProcess('bridge', 'node', ['bridge/host-bridge/index.mjs'], {
    ...process.env,
    RELAY_URL: relayUrl,
    RELAY_DEV_TOKEN: pairingToken,
    CODEX_ADAPTER: 'app-server',
    CODEX_APPROVAL_POLICY: process.env.CODEX_APPROVAL_POLICY ?? 'on-request',
    CODEX_APP_SERVER_PORT: appServerPort
  });
  processes.push(bridge);
  await waitForOutput(bridge, '[bridge] app-server initialized', 20000);
  await waitForOutput(relay, '[relay] session snapshot', 15000);

  const deviceToken = await pairDevice(relayPort, pairingToken);

  printManualInstructions();

  const client = spawnProcess(
    'trigger-client',
    'node',
    ['tools/ephemeral-prompt-client/index.mjs', prompt],
    {
      ...process.env,
      RELAY_URL: relayUrl,
      RELAY_DEVICE_TOKEN: deviceToken,
      EPHEMERAL_CLIENT_TIMEOUT_MS: process.env.EPHEMERAL_CLIENT_TIMEOUT_MS ?? '300000',
      EPHEMERAL_CLIENT_EXPECT_EVENT_TYPES: process.env.EPHEMERAL_CLIENT_EXPECT_EVENT_TYPES ?? 'approval_resolved,assistant_delta,turn_completed,any'
    }
  );
  processes.push(client);

  const exitCode = await waitForExit(client, 300000);
  if (exitCode !== 0) {
    throw new Error(`trigger-client exited with code ${exitCode}`);
  }

  console.log('[manual] Approval manual flow completed. Stop the app manually if you want to inspect state, or rerun to test again.');
} finally {
  for (const child of processes.reverse()) {
    if (!child.killed) {
      child.kill();
    }
  }

  await delay(250);
}

function printManualInstructions() {
  const lanUrls = lanAddresses().map((address) => `ws://${address}:${relayPort}`);

  console.log('\n[manual] Android setup');
  console.log(`[manual] Emulator Relay URL: ws://10.0.2.2:${relayPort}`);
  if (lanUrls.length > 0) {
    console.log(`[manual] Phone Relay URL: ${lanUrls[0]}`);
    for (const extra of lanUrls.slice(1)) {
      console.log(`[manual] Alternate LAN URL: ${extra}`);
    }
  } else {
    console.log('[manual] Phone Relay URL: ws://<PC LAN IP>:' + relayPort);
  }
  console.log(`[manual] Pairing token: ${pairingToken}`);
  console.log('[manual] In Android: Save -> Pair -> Test -> Connect/Refresh.');
  console.log('[manual] The trigger client is creating an ephemeral session and asking Codex to run `node --version`.');
  console.log('[manual] When a Needs attention card appears, tap Approve or Deny.\n');
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

async function pairDevice(port, token) {
  const response = await fetch(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Relay-Dev-Token': token
    },
    body: JSON.stringify({
      device_id: 'manual-approval-trigger-client',
      display_name: 'Manual Approval Trigger Client'
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

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}
