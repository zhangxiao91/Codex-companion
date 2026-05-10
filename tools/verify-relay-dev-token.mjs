import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MessageType,
  createMessage,
  decodeMessage,
  encodeMessage
} from '../packages/protocol/index.mjs';

const processes = [];
const relayPort = '8799';
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const devToken = 'relay-dev-token-test';

try {
  const rejectedLanRelay = spawnProcess('relay-no-token', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_HOST: '0.0.0.0',
    RELAY_PORT: '8800',
    RELAY_DEV_TOKEN: ''
  });
  const rejectedExitCode = await waitForExit(rejectedLanRelay, 5000);
  if (rejectedExitCode === 0 || !rejectedLanRelay.output.includes('without RELAY_DEV_TOKEN')) {
    throw new Error('Expected RELAY_HOST=0.0.0.0 without token to be rejected.');
  }

  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_PORT: relayPort,
    RELAY_DEV_TOKEN: devToken
  });
  processes.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);

  const publicHealthResponse = await fetch(`http://127.0.0.1:${relayPort}/health`);
  const publicHealth = await publicHealthResponse.json();
  if (!publicHealth.auth_required || publicHealth.counts) {
    throw new Error('Expected unauthenticated health to hide detailed diagnostics.');
  }

  const privateHealthResponse = await fetch(`http://127.0.0.1:${relayPort}/health`, {
    headers: {
      'X-Relay-Dev-Token': devToken
    }
  });
  const privateHealth = await privateHealthResponse.json();
  if (!privateHealth.auth_required || typeof privateHealth.counts?.sessions !== 'number') {
    throw new Error('Expected authenticated health to include detailed diagnostics.');
  }

  const pairResponse = await fetch(`http://127.0.0.1:${relayPort}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Relay-Dev-Token': devToken
    },
    body: JSON.stringify({
      device_id: 'verify-android-device',
      display_name: 'Verify Android Device'
    })
  });
  if (!pairResponse.ok) {
    throw new Error(`Expected pairing to succeed, received HTTP ${pairResponse.status}`);
  }

  const pair = await pairResponse.json();
  if (!pair.ok || !pair.device_token) {
    throw new Error('Expected pair response to include a device token.');
  }

  const deviceHealthResponse = await fetch(`http://127.0.0.1:${relayPort}/health`, {
    headers: {
      authorization: `Bearer ${pair.device_token}`
    }
  });
  const deviceHealth = await deviceHealthResponse.json();
  if (typeof deviceHealth.counts?.paired_devices !== 'number') {
    throw new Error('Expected paired device token to authorize health diagnostics.');
  }

  const host = await connect(relayUrl);
  send(host, MessageType.HostRegister, {
    host_id: 'secure-test-host',
    display_name: 'Secure Test Host',
    bridge_version: 'test',
    capabilities: ['session.list', 'session.prompt', 'timeline.event']
  }, devToken);
  send(host, MessageType.SessionSnapshot, {
    session: {
      session_id: 'secure-session-001',
      host_id: 'secure-test-host',
      project_name: 'Relay Token Test',
      repo_path: process.cwd(),
      branch: 'main',
      status: 'waiting_for_input',
      summary: 'Session for Relay dev-token verification.',
      updated_at: new Date().toISOString()
    }
  }, devToken);
  await waitForOutput(relay, 'session snapshot: secure-session-001', 5000);

  const unauthenticatedClient = await connect(relayUrl);
  send(unauthenticatedClient, MessageType.SessionPrompt, {
    session_id: 'secure-session-001',
    text: 'must be rejected'
  });
  const rejected = await waitForMessage(unauthenticatedClient, MessageType.Error, 5000);
  if (!rejected.payload.detail.includes('Unauthorized')) {
    throw new Error(`Expected unauthorized error, received: ${rejected.payload.detail}`);
  }

  const authenticatedClient = await connect(relayUrl);
  send(authenticatedClient, MessageType.SessionPrompt, {
    session_id: 'secure-session-001',
    text: 'must be routed'
  }, pair.device_token);
  const routedPrompt = await waitForMessage(host, MessageType.SessionPrompt, 5000);
  if (routedPrompt.payload.text !== 'must be routed') {
    throw new Error(`Expected routed prompt, received: ${routedPrompt.payload.text}`);
  }

  host.close();
  unauthenticatedClient.close();
  authenticatedClient.close();
  console.log('[verify] Relay dev-token guard verified.');
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

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out opening WebSocket ${url}`));
    }, 2000);

    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket connection failed for ${url}`));
    });
  });
}

function waitForMessage(socket, expectedType, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${expectedType}`));
    }, timeoutMs);

    socket.addEventListener('message', (event) => {
      const message = decodeMessage(event.data);
      if (message.type !== expectedType) {
        return;
      }

      clearTimeout(timer);
      resolve(message);
    });
  });
}

function send(socket, type, payload, token = '') {
  socket.send(encodeMessage(createMessage(type, payload, token ? {
    auth: {
      token
    }
  } : {})));
}
