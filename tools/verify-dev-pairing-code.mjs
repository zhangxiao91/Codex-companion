import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createPairingCode, createPairingPayload } from './pairing-code.mjs';

const child = spawn('node', ['tools/dev-pairing-start.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    RELAY_PORT: '8814',
    RELAY_LAN_HOST: '192.0.2.10'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  output += chunk.toString();
});

try {
  await waitForOutput('[pairing] Pairing code:', 5000);
  const code = output.split(/\r?\n/).find((line) => line.startsWith('cmc1.'));
  if (!code) {
    throw new Error('Pairing code was not printed.');
  }

  const payload = JSON.parse(Buffer.from(code.slice('cmc1.'.length), 'base64url').toString('utf8'));
  if (payload.relay_url !== 'ws://192.0.2.10:8814') {
    throw new Error(`Unexpected relay URL in pairing code: ${payload.relay_url}`);
  }
  if (typeof payload.pairing_token !== 'string' || payload.pairing_token.length < 40) {
    throw new Error('Pairing token is missing or too short.');
  }
  if (!payload.pairing_token.startsWith('cmc_')) {
    throw new Error('Pairing token prefix is missing.');
  }

  const regenerated = createPairingCode(createPairingPayload({
    relayUrl: 'ws://192.0.2.10:8814',
    pairingToken: payload.pairing_token,
    createdAt: payload.created_at
  }));
  if (regenerated !== code) {
    throw new Error('Pairing code helper is not stable.');
  }

  console.log('[verify] Dev pairing code generation verified.');
} finally {
  if (!child.killed) {
    child.kill();
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
