import {
  DEFAULT_RELAY_URL,
  MessageType,
  decodeMessage,
  encodeMessage,
  createMessage
} from '../../packages/protocol/index.mjs';

const relayUrl = process.env.RELAY_URL ?? DEFAULT_RELAY_URL;
const timeoutMs = Number.parseInt(process.env.TIMELINE_CLIENT_TIMEOUT_MS ?? '15000', 10);
const socket = new WebSocket(relayUrl);
const timer = setTimeout(() => {
  console.error(`[timeline-client] timed out after ${timeoutMs}ms`);
  process.exit(1);
}, timeoutMs);

let selectedSessionId;

socket.addEventListener('open', () => {
  console.log(`[timeline-client] connected to ${relayUrl}`);
  send(MessageType.SessionSubscribe, { session_id: '*' });
});

socket.addEventListener('message', (event) => {
  const message = decodeMessage(event.data);

  if (message.type === MessageType.Error) {
    console.error(`[timeline-client] relay error: ${message.payload.detail}`);
    process.exit(1);
  }

  if (message.type === MessageType.SessionSnapshot && !selectedSessionId) {
    selectedSessionId = message.payload.session.session_id;
    console.log(`[timeline-client] session visible: ${selectedSessionId}`);
    send(MessageType.SessionTimelineRequest, { session_id: selectedSessionId, limit: 1 });
    return;
  }

  if (message.type === MessageType.TimelineEvent) {
    const { event: timelineEvent } = message.payload;
    if (timelineEvent.session_id !== selectedSessionId) {
      return;
    }

    console.log(`[timeline-client] timeline event received: ${timelineEvent.type} ${timelineEvent.title}`);
    console.log(`[timeline-client] summary: ${timelineEvent.summary}`);
    clearTimeout(timer);
    socket.close();
    process.exit(0);
  }
});

socket.addEventListener('error', () => {
  console.error('[timeline-client] websocket error');
  process.exit(1);
});

function send(type, payload) {
  socket.send(encodeMessage(createMessage(type, payload)));
}
