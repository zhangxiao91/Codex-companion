import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageType, createMessage, decodeMessage, encodeMessage } from '../packages/protocol/index.mjs';

const port = 9910 + Math.floor(Math.random() * 300);
const url = `ws://127.0.0.1:${port}`;
const httpUrl = `http://127.0.0.1:${port}`;
const hostToken = 'rich-host-token';
const pairingToken = 'rich-pair-token';
const hostId = 'rich-host';
const sessionId = 'rich-session';
const tmp = mkdtempSync(join(tmpdir(), 'cmc-rich-prompt-'));

const relay = spawn('node', ['relay/service/server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    RELAY_PORT: String(port),
    RELAY_HOST: '127.0.0.1',
    RELAY_PAIRING_TOKEN: pairingToken,
    RELAY_HOST_TOKEN: hostToken,
    RELAY_SQLITE_PATH: join(tmp, 'relay.sqlite'),
    RELAY_MAX_MESSAGE_BYTES: '3000000'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

try {
  await waitForOutput(relay, '[relay] listening', 5000);
  const pair = await pairDevice();
  const host = await connect(url);
  const client = await connect(url);

  send(host, MessageType.HostRegister, {
    host_id: hostId,
    display_name: 'Rich Prompt Host',
    capabilities: ['session.prompt', 'session.prompt.edit', 'session.turn.interrupt']
  }, { host_token: hostToken });
  send(host, MessageType.SessionSnapshot, {
    session: {
      session_id: sessionId,
      host_id: hostId,
      project_name: 'Rich Prompt',
      repo_path: process.cwd(),
      branch: 'main',
      status: 'waiting_for_input',
      summary: 'Rich prompt verifier session',
      updated_at: new Date().toISOString()
    }
  }, { host_token: hostToken });
  await waitForMessage(client, (message) => message.type === MessageType.SessionSnapshot, 5000, pair.device_token);

  const imageDataUrl = `data:image/jpeg;base64,${Buffer.from('fake-jpeg').toString('base64')}`;
  send(client, MessageType.SessionPrompt, {
    session_id: sessionId,
    text: 'Summarize this image',
    input: [
      { type: 'text', text: 'Summarize this image' },
      { type: 'image', data_url: imageDataUrl, mime_type: 'image/jpeg', name: 'sample.jpg', size_bytes: 9 }
    ],
    options: {
      reasoning_effort: 'high',
      plan_mode: true,
      goal: { objective: 'Produce a concise image summary.' }
    },
    client_request_id: 'rich-prompt-1'
  }, { device_token: pair.device_token });

  const routedPrompt = await waitForMessage(host, (message) => message.type === MessageType.SessionPrompt, 5000);
  assertEqual(routedPrompt.payload.options.reasoning_effort, 'high', 'reasoning effort');
  assertEqual(routedPrompt.payload.options.plan_mode, true, 'plan mode');
  assertEqual(routedPrompt.payload.options.goal.objective, 'Produce a concise image summary.', 'goal objective');
  assertEqual(routedPrompt.payload.input[1].type, 'image', 'image input type');

  send(client, MessageType.SessionPromptEdit, {
    session_id: sessionId,
    base_event_id: `${sessionId}:turn-1:item-1:user_prompt`,
    base_turn_id: 'turn-1',
    text: 'Use this revised prompt.',
    input: [{ type: 'text', text: 'Use this revised prompt.' }],
    options: { reasoning_effort: 'medium', plan_mode: false },
    client_request_id: 'rich-edit-1'
  }, { device_token: pair.device_token });
  const routedEdit = await waitForMessage(host, (message) => message.type === MessageType.SessionPromptEdit, 5000);
  assertEqual(routedEdit.payload.base_turn_id, 'turn-1', 'edit base turn');

  send(client, MessageType.SessionTurnInterrupt, {
    session_id: sessionId,
    client_request_id: 'rich-stop-1'
  }, { device_token: pair.device_token });
  const routedInterrupt = await waitForMessage(host, (message) => message.type === MessageType.SessionTurnInterrupt, 5000);
  assertEqual(routedInterrupt.payload.session_id, sessionId, 'interrupt session');

  send(client, MessageType.SessionPromptQueue, {
    session_id: sessionId,
    text: 'Run this after the current turn.',
    client_request_id: 'rich-queue-1'
  }, { device_token: pair.device_token });
  const routedQueue = await waitForMessage(host, (message) => message.type === MessageType.SessionPromptQueue, 5000);
  assertEqual(routedQueue.payload.text, 'Run this after the current turn.', 'queued prompt text');

  host.close();
  client.close();
  console.log('[verify] Rich prompt, edit, interrupt, options, and image routing verified.');
} finally {
  relay.kill();
}

async function pairDevice() {
  const response = await fetch(`${httpUrl}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-relay-pairing-token': pairingToken
    },
    body: JSON.stringify({
      device_id: 'rich-prompt-device',
      display_name: 'Rich Prompt Device'
    })
  });
  if (!response.ok) {
    throw new Error(`Pair failed: HTTP ${response.status}`);
  }
  return response.json();
}

function connect(socketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    socket.messages = [];
    socket.addEventListener('open', () => resolve(socket));
    socket.addEventListener('error', () => reject(new Error('WebSocket connection failed.')));
    socket.addEventListener('message', (event) => {
      socket.messages.push(decodeMessage(event.data));
    });
  });
}

function send(socket, type, payload, auth = undefined) {
  socket.send(encodeMessage(createMessage(type, payload, { auth })));
}

async function waitForMessage(socket, predicate, timeoutMs, deviceToken = null) {
  const started = Date.now();
  if (deviceToken) {
    send(socket, MessageType.SessionSubscribe, { session_id: '*' }, { device_token: deviceToken });
  }
  while (Date.now() - started < timeoutMs) {
    const index = socket.messages.findIndex(predicate);
    if (index >= 0) {
      const [message] = socket.messages.splice(index, 1);
      return message;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for WebSocket message. Saw: ${JSON.stringify(socket.messages)}`);
}

function waitForOutput(child, needle, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for output: ${needle}\n${output}`)), timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(needle)) {
        clearTimeout(timer);
        resolve(output);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Relay exited early with code ${code}\n${output}`));
    });
  });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}
