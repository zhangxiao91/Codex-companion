import {
  DEFAULT_RELAY_URL,
  MessageType,
  createMessage,
  decodeMessage,
  encodeMessage
} from '../../packages/protocol/index.mjs';
import { createCodexAdapter } from './codex-adapter.mjs';

const relayUrl = process.env.RELAY_URL ?? DEFAULT_RELAY_URL;
const devToken = process.env.RELAY_DEV_TOKEN ?? process.env.DEV_TOKEN ?? '';
const hostId = process.env.HOST_ID ?? 'local-dev-host';
const displayName = process.env.HOST_NAME ?? 'Local Development Host';
const bridgeVersion = '0.0.1';
const adapter = createCodexAdapter(hostId, {
  onTimelineEvent: (event) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(encodeMessage(createRelayMessage(MessageType.TimelineEvent, { event })));
    }
  }
});

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

  console.log('[bridge] registered host capabilities: session.list, session.prompt, timeline.event');

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
      console.log(`[bridge] received prompt for ${sessionId}`);
      const response = await adapter.sendPrompt(sessionId, text);
      socket.send(encodeMessage(withAuth(response)));
      return;
    }

    if (message.type === MessageType.SessionTimelineRequest) {
      const { session_id: sessionId } = message.payload;
      console.log(`[bridge] received timeline request for ${sessionId}`);

      if (typeof adapter.readTimeline !== 'function') {
        return;
      }

      const responses = await adapter.readTimeline(sessionId, {
        limit: message.payload.limit
      });
      for (const response of responses) {
        socket.send(encodeMessage(withAuth(response)));
      }
      return;
    }

    if (message.type === MessageType.SessionCreateEphemeral) {
      if (typeof adapter.createEphemeralSession !== 'function') {
        return;
      }

      const session = await adapter.createEphemeralSession(message.payload);
      console.log(`[bridge] created ephemeral session ${session.session_id}`);
      send(MessageType.SessionSnapshot, { session });
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
  socket.send(encodeMessage(createRelayMessage(type, payload)));
}

function createRelayMessage(type, payload) {
  return createMessage(type, payload, authOptions());
}

function withAuth(message) {
  if (!devToken) {
    return message;
  }

  return {
    ...message,
    auth: {
      ...(message.auth ?? {}),
      dev_token: devToken
    }
  };
}

function authOptions() {
  return devToken ? { auth: { dev_token: devToken } } : {};
}
