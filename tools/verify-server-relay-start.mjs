import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const relayPort = '8816';
const token = 'server-relay-start-token';
const publicWsUrl = 'wss://relay.example.com';
const publicHttpUrl = 'https://relay.example.com';

const relay = spawn('node', ['tools/server-relay-start.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    RELAY_PORT: relayPort,
    RELAY_DEV_TOKEN: token,
    RELAY_PUBLIC_WS_URL: publicWsUrl,
    RELAY_PUBLIC_HTTP_URL: publicHttpUrl
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
relay.stdout.on('data', (chunk) => {
  output += chunk.toString();
});
relay.stderr.on('data', (chunk) => {
  output += chunk.toString();
});

try {
  await waitForOutput('[relay] listening', 5000);
  const code = output.split(/\r?\n/).find((line) => line.startsWith('cmc1.'));
  if (!code) {
    throw new Error('Server relay start did not print a pairing code.');
  }

  const payload = JSON.parse(Buffer.from(code.slice('cmc1.'.length), 'base64url').toString('utf8'));
  if (payload.relay_url !== publicWsUrl) {
    throw new Error(`Unexpected relay_url: ${payload.relay_url}`);
  }

  const healthResponse = await fetch(`http://127.0.0.1:${relayPort}/health`, {
    headers: {
      'X-Relay-Dev-Token': token
    }
  });
  if (!healthResponse.ok) {
    throw new Error(`Health failed with HTTP ${healthResponse.status}`);
  }

  const health = await healthResponse.json();
  if (health.listen.public_websocket_url !== publicWsUrl) {
    throw new Error(`Unexpected public_websocket_url: ${health.listen.public_websocket_url}`);
  }
  if (health.listen.public_health_url !== `${publicHttpUrl}/health`) {
    throw new Error(`Unexpected public_health_url: ${health.listen.public_health_url}`);
  }

  console.log('[verify] Server Relay startup helper verified.');
} finally {
  if (!relay.killed) {
    relay.kill();
  }
  await delay(250);
}

async function waitForOutput(needle, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (output.includes(needle)) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for output: ${needle}`);
}

