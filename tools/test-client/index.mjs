import {
  DEFAULT_RELAY_URL,
  MessageType,
  decodeMessage,
  encodeMessage,
  createMessage
} from '../../packages/protocol/index.mjs';

const relayUrl = process.env.RELAY_URL ?? DEFAULT_RELAY_URL;
const promptText = process.argv.slice(2).join(' ') || '总结当前进度';
const timeoutMs = Number.parseInt(process.env.TEST_CLIENT_TIMEOUT_MS ?? '10000', 10);

const socket = new WebSocket(relayUrl);
const timer = setTimeout(() => {
  console.error(`[test-client] timed out after ${timeoutMs}ms`);
  process.exit(1);
}, timeoutMs);

let selectedSessionId;
let promptSent = false;

socket.addEventListener('open', () => {
  console.log(`[test-client] connected to ${relayUrl}`);
  send(MessageType.SessionSubscribe, { session_id: '*' });
});

socket.addEventListener('message', (event) => {
  const message = decodeMessage(event.data);

  if (message.type === MessageType.Error) {
    console.error(`[test-client] relay error: ${message.payload.detail}`);
    process.exit(1);
  }

  if (message.type === MessageType.SessionSnapshot && !promptSent) {
    selectedSessionId = message.payload.session.session_id;
    console.log(`[test-client] session visible: ${selectedSessionId}`);

    send(MessageType.SessionSubscribe, { session_id: selectedSessionId });
    send(MessageType.SessionPrompt, {
      session_id: selectedSessionId,
      text: promptText
    });
    promptSent = true;
    console.log(`[test-client] prompt sent: ${promptText}`);
    return;
  }

  if (message.type === MessageType.TimelineEvent) {
    const { event: timelineEvent } = message.payload;

    if (timelineEvent.session_id !== selectedSessionId) {
      return;
    }

    console.log(`[test-client] timeline event received: ${timelineEvent.title}`);
    console.log(`[test-client] summary: ${timelineEvent.summary}`);
    clearTimeout(timer);
    socket.close();
    process.exit(0);
  }
});

socket.addEventListener('error', () => {
  console.error('[test-client] websocket error');
  process.exit(1);
});

function send(type, payload) {
  socket.send(encodeMessage(createMessage(type, payload)));
}

