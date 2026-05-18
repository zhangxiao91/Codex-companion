import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const relayPort = '8816';
const pairingToken = 'server-relay-start-pairing-token';
const hostToken = 'server-relay-start-host-token';
const publicWsUrl = 'wss://relay.example.com';
const publicHttpUrl = 'https://relay.example.com';

const relay = spawn('node', ['tools/server-relay-start.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    RELAY_PORT: relayPort,
    RELAY_PAIRING_TOKEN: pairingToken,
    RELAY_HOST_TOKEN: hostToken,
    RELAY_PUBLIC_WS_URL: publicWsUrl,
    RELAY_PUBLIC_HTTP_URL: publicHttpUrl,
    CMC_PAIRING_QR: 'none'
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
  if (payload.pairing_token !== pairingToken) {
    throw new Error('Pairing code did not include the pairing token.');
  }
  if (payload.pairing_token === hostToken) {
    throw new Error('Pairing code must not include the host token.');
  }
  if (!output.includes(`ws://127.0.0.1:${relayPort}`)) {
    throw new Error('Server relay helper should bind the Node Relay to localhost by default.');
  }

  const healthResponse = await fetch(`http://127.0.0.1:${relayPort}/health`, {
    headers: {
      'X-Relay-Pairing-Token': pairingToken
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

  const hostHealthResponse = await fetch(`http://127.0.0.1:${relayPort}/health`, {
    headers: {
      'X-Relay-Host-Token': hostToken
    }
  });
  if (!hostHealthResponse.ok) {
    throw new Error(`Host-token health failed with HTTP ${hostHealthResponse.status}`);
  }
  const hostHealth = await hostHealthResponse.json();
  if (typeof hostHealth.counts?.hosts !== 'number') {
    throw new Error('Expected host token to authorize detailed health diagnostics.');
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
