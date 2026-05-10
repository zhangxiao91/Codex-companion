import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MessageType,
  createMessage,
  decodeMessage,
  encodeMessage
} from '../packages/protocol/index.mjs';

const processes = [];
const devToken = 'relay-cache-test-token';

try {
  const relayPort = '8797';
  const relayUrl = `ws://127.0.0.1:${relayPort}`;
  const relay = spawnProcess('relay', 'node', ['relay/service/server.mjs'], {
    ...process.env,
    RELAY_PORT: relayPort,
    RELAY_TIMELINE_CACHE_LIMIT: '10',
    RELAY_DEV_TOKEN: devToken
  });
  processes.push(relay);
  await waitForOutput(relay, '[relay] listening', 5000);

  const host = await connect(relayUrl);
  await send(host, MessageType.HostRegister, {
    host_id: 'cache-test-host',
    display_name: 'Cache Test Host',
    bridge_version: 'test',
    capabilities: ['session.list', 'timeline.event']
  });
  await send(host, MessageType.SessionSnapshot, {
    session: {
      session_id: 'cache-session-001',
      host_id: 'cache-test-host',
      project_name: 'Relay Cache Test',
      repo_path: process.cwd(),
      branch: 'main',
      status: 'running',
      summary: 'Session for Relay timeline cache verification.',
      updated_at: new Date().toISOString()
    }
  });

  await waitForOutput(relay, 'session snapshot: cache-session-001', 5000);

  await send(host, MessageType.TimelineEvent, {
    event: createEvent('cache-session-001', 'first_cached_event', 'First cached event')
  });
  await send(host, MessageType.TimelineEvent, {
    event: createEvent('cache-session-001', 'second_cached_event', 'Second cached event')
  });

  await waitForOutput(relay, 'timeline event: Second cached event', 5000);

  const client = await connect(relayUrl);
  await send(client, MessageType.SessionTimelineRequest, {
    session_id: 'cache-session-001',
    after_cursor: '1',
    cache_only: true
  });

  const replayed = await waitForTimelineEvent(client, 5000);
  if (replayed.type !== 'second_cached_event') {
    throw new Error(`Expected second_cached_event, received ${replayed.type}`);
  }

  if (replayed.cursor !== '2') {
    throw new Error(`Expected cursor 2, received ${replayed.cursor}`);
  }

  if (replayed.replayed_from_cache !== true) {
    throw new Error('Expected replayed_from_cache marker.');
  }

  host.close();
  client.close();
  console.log('[verify] Relay timeline cache cursor replay verified.');
} finally {
  for (const child of processes.reverse()) {
    if (!child.killed) {
      child.kill();
    }
  }

  await delay(250);
}

function createEvent(sessionId, type, title) {
  return {
    event_id: `${sessionId}:${type}`,
    session_id: sessionId,
    created_at: new Date().toISOString(),
    type,
    title,
    summary: title,
    payload: { source: 'verify-relay-timeline-cache' },
    redaction_level: 'none'
  };
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

function waitForTimelineEvent(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for cached timeline event after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.addEventListener('message', (event) => {
      const message = decodeMessage(event.data);
      if (message.type === MessageType.Error) {
        clearTimeout(timer);
        reject(new Error(message.payload.detail));
        return;
      }

      if (message.type === MessageType.TimelineEvent) {
        clearTimeout(timer);
        resolve(message.payload.event);
      }
    });
  });
}

function send(socket, type, payload) {
  socket.send(encodeMessage(createMessage(type, payload, {
    auth: {
      dev_token: devToken
    }
  })));
}
