import {
  DEFAULT_RELAY_URL,
  MessageType,
  decodeMessage,
  encodeMessage,
  createMessage
} from '../../packages/protocol/index.mjs';

const relayUrl = process.env.RELAY_URL ?? DEFAULT_RELAY_URL;
const devToken = process.env.RELAY_DEV_TOKEN ?? process.env.DEV_TOKEN ?? '';
const hostId = process.env.HOST_ID ?? 'local-dev-host';
const timeoutMs = Number.parseInt(process.env.STEER_CLIENT_TIMEOUT_MS ?? '60000', 10);
const firstPrompt = 'Wait briefly before answering. Final answer should be OK.';
const steerPrompt = 'Additional instruction: answer with exactly OK.';

const socket = new WebSocket(relayUrl);
const timer = setTimeout(() => {
  console.error(`[steer-client] timed out after ${timeoutMs}ms`);
  process.exit(1);
}, timeoutMs);

let selectedSessionId;
let firstPromptSent = false;
let steerPromptSent = false;

socket.addEventListener('open', () => {
  console.log(`[steer-client] connected to ${relayUrl}`);
  send(MessageType.SessionCreateEphemeral, {
    host_id: hostId,
    baseInstructions: 'You are being used for a Codex Mobile Companion steering integration test. Keep responses concise.'
  });
});

socket.addEventListener('message', (event) => {
  const message = decodeMessage(event.data);

  if (message.type === MessageType.Error) {
    console.error(`[steer-client] relay error: ${message.payload.detail}`);
    process.exit(1);
  }

  if (message.type === MessageType.SessionSnapshot && !firstPromptSent) {
    selectedSessionId = message.payload.session.session_id;
    console.log(`[steer-client] ephemeral session visible: ${selectedSessionId}`);
    send(MessageType.SessionSubscribe, { session_id: selectedSessionId });
    send(MessageType.SessionPrompt, {
      session_id: selectedSessionId,
      text: firstPrompt
    });
    firstPromptSent = true;
    console.log(`[steer-client] first prompt sent`);
    return;
  }

  if (message.type !== MessageType.TimelineEvent) {
    return;
  }

  const { event: timelineEvent } = message.payload;
  if (timelineEvent.session_id !== selectedSessionId) {
    return;
  }

  if (timelineEvent.type === 'turn_start_requested' && !steerPromptSent) {
    send(MessageType.SessionPrompt, {
      session_id: selectedSessionId,
      text: steerPrompt
    });
    steerPromptSent = true;
    console.log('[steer-client] steer prompt sent');
    return;
  }

  if (timelineEvent.type === 'turn_steer_requested') {
    console.log(`[steer-client] steer event received: ${timelineEvent.summary}`);
    clearTimeout(timer);
    socket.close();
    process.exit(0);
  }

  console.log(`[steer-client] ignoring timeline event: ${timelineEvent.type}`);
});

socket.addEventListener('error', () => {
  console.error('[steer-client] websocket error');
  process.exit(1);
});

function send(type, payload) {
  socket.send(encodeMessage(createMessage(type, payload, authOptions())));
}

function authOptions() {
  return devToken ? { auth: { dev_token: devToken } } : {};
}
