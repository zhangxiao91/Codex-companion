import {
  DEFAULT_RELAY_URL,
  MessageType,
  createMessage,
  decodeMessage,
  encodeMessage
} from '../../packages/protocol/index.mjs';
import { createCodexAdapter } from './codex-adapter.mjs';

const relayUrl = process.env.RELAY_URL ?? DEFAULT_RELAY_URL;
const hostId = process.env.HOST_ID ?? 'local-dev-host';
const displayName = process.env.HOST_NAME ?? 'Local Development Host';
const bridgeVersion = '0.0.1';
const adapter = createCodexAdapter(hostId);

const socket = new WebSocket(relayUrl);

socket.addEventListener('open', async () => {
  console.log(`[bridge] connected to ${relayUrl}`);

  if (typeof adapter.start === 'function') {
    await adapter.start();
  }

  send(MessageType.HostRegister, {
    host_id: hostId,
    display_name: displayName,
    kind: 'local_pc',
    bridge_version: bridgeVersion,
    capabilities: ['session.list', 'session.prompt', 'timeline.event']
  });

  for (const session of adapter.listSessions()) {
    send(MessageType.SessionSnapshot, { session });
  }

  setInterval(() => {
    send(MessageType.HostHeartbeat, {
      host_id: hostId,
      bridge_version: bridgeVersion
    });
  }, 5000);
});

socket.addEventListener('message', async (event) => {
  try {
    const message = decodeMessage(event.data);

    if (message.type === MessageType.SessionPrompt) {
      const { session_id: sessionId, text } = message.payload;
      console.log(`[bridge] received prompt for ${sessionId}: ${text}`);
      const response = await adapter.sendPrompt(sessionId, text);
      socket.send(encodeMessage(response));
      return;
    }

    if (message.type === MessageType.Error) {
      console.error(`[bridge] relay error: ${message.payload.detail}`);
    }
  } catch (error) {
    console.error(`[bridge] failed to handle message: ${error.message}`);
  }
});

socket.addEventListener('close', () => {
  console.log('[bridge] disconnected from relay');
  if (typeof adapter.stop === 'function') {
    adapter.stop();
  }
});

socket.addEventListener('error', () => {
  console.error('[bridge] websocket error');
});

function send(type, payload) {
  socket.send(encodeMessage(createMessage(type, payload)));
}
