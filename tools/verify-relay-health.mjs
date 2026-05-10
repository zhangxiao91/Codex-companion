import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

let relay;

try {
  const relayPort = '8798';
  relay = spawn('node', ['relay/service/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RELAY_PORT: relayPort,
      RELAY_HOST: '127.0.0.1',
      RELAY_DEV_TOKEN: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  relay.output = '';
  relay.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    relay.output += text;
    process.stdout.write(`[relay] ${text}`);
  });
  relay.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    relay.output += text;
    process.stderr.write(`[relay:err] ${text}`);
  });

  await waitForOutput(relay, '[relay] listening', 5000);

  const response = await fetch(`http://127.0.0.1:${relayPort}/health`);
  if (!response.ok) {
    throw new Error(`Health endpoint returned HTTP ${response.status}`);
  }

  const health = await response.json();
  if (health.ok !== true) {
    throw new Error('Health endpoint did not report ok=true.');
  }

  if (health.service !== 'codex-mobile-companion-relay') {
    throw new Error(`Unexpected service: ${health.service}`);
  }

  if (health.listen?.port !== Number.parseInt(relayPort, 10)) {
    throw new Error(`Unexpected health listen port: ${health.listen?.port}`);
  }

  if (typeof health.counts?.sessions !== 'number') {
    throw new Error('Health endpoint is missing counts.sessions.');
  }

  console.log('[verify] Relay health endpoint verified.');
} finally {
  if (relay && !relay.killed) {
    relay.kill();
  }

  await delay(250);
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
