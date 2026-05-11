import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const relayPort = '8815';
const publicHttpUrl = 'https://relay.example.com';
const publicWsUrl = 'wss://relay.example.com';
const relay = spawn('node', ['relay/service/server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    RELAY_PORT: relayPort,
    RELAY_DEV_TOKEN: 'public-url-token',
    RELAY_PUBLIC_HTTP_URL: `${publicHttpUrl}/`,
    RELAY_PUBLIC_WS_URL: `${publicWsUrl}/`
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
  const response = await fetch(`http://127.0.0.1:${relayPort}/health`, {
    headers: {
      'X-Relay-Dev-Token': 'public-url-token'
    }
  });
  if (!response.ok) {
    throw new Error(`Health failed with HTTP ${response.status}`);
  }

  const health = await response.json();
  if (health.listen.public_websocket_url !== publicWsUrl) {
    throw new Error(`Unexpected public_websocket_url: ${health.listen.public_websocket_url}`);
  }
  if (health.listen.public_health_url !== `${publicHttpUrl}/health`) {
    throw new Error(`Unexpected public_health_url: ${health.listen.public_health_url}`);
  }

  console.log('[verify] Relay public URL health metadata verified.');
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

