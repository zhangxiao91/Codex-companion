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
const promptText = process.argv.slice(2).join(' ') || 'Reply with exactly: OK';
const timeoutMs = Number.parseInt(process.env.EPHEMERAL_CLIENT_TIMEOUT_MS ?? '60000', 10);
const expectedEventTypes = (process.env.EPHEMERAL_CLIENT_EXPECT_EVENT_TYPES ?? 'turn_start_requested')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const socket = new WebSocket(relayUrl);
const timer = setTimeout(() => {
  console.error(`[ephemeral-client] timed out after ${timeoutMs}ms`);
  process.exit(1);
}, timeoutMs);

let selectedSessionId;
let promptSent = false;

socket.addEventListener('open', () => {
  console.log(`[ephemeral-client] connected to ${relayUrl}`);
  send(MessageType.SessionCreateEphemeral, {
    host_id: hostId,
    baseInstructions: 'You are being used for a Codex Mobile Companion integration test. Reply briefly.'
  });
});

socket.addEventListener('message', (event) => {
  const message = decodeMessage(event.data);

  if (message.type === MessageType.Error) {
    console.error(`[ephemeral-client] relay error: ${message.payload.detail}`);
    process.exit(1);
  }

  if (message.type === MessageType.SessionSnapshot && !promptSent) {
    selectedSessionId = message.payload.session.session_id;
    console.log(`[ephemeral-client] ephemeral session visible: ${selectedSessionId}`);
    send(MessageType.SessionSubscribe, { session_id: selectedSessionId });
    send(MessageType.SessionPrompt, {
      session_id: selectedSessionId,
      text: promptText
    });
    promptSent = true;
    console.log(`[ephemeral-client] prompt sent: ${promptText}`);
    return;
  }

  if (message.type === MessageType.TimelineEvent) {
    const { event: timelineEvent } = message.payload;
    if (timelineEvent.session_id !== selectedSessionId) {
      return;
    }

    if (timelineEvent.type === 'error') {
      console.error(`[ephemeral-client] timeline error: ${timelineEvent.summary}`);
      process.exit(1);
    }

    if (!expectedEventTypes.includes(timelineEvent.type)) {
      console.log(`[ephemeral-client] ignoring timeline event: ${timelineEvent.type}`);
      return;
    }

    console.log(`[ephemeral-client] expected timeline event received: ${timelineEvent.type}`);
    console.log(`[ephemeral-client] title: ${timelineEvent.title}`);
    console.log(`[ephemeral-client] summary: ${timelineEvent.summary}`);
    clearTimeout(timer);
    socket.close();
    process.exit(0);
  }
});

socket.addEventListener('error', () => {
  console.error('[ephemeral-client] websocket error');
  process.exit(1);
});

function send(type, payload) {
  socket.send(encodeMessage(createMessage(type, payload, authOptions())));
}

function authOptions() {
  return devToken ? { auth: { dev_token: devToken } } : {};
}
