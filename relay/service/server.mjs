import { createServer } from 'node:http';
import {
  MessageType,
  SenderRole,
  createMessage,
  decodeMessage,
  encodeMessage,
  requirePayloadField
} from '../../packages/protocol/index.mjs';
import { handleWebSocketUpgrade } from './ws-server.mjs';

const port = Number.parseInt(process.env.RELAY_PORT ?? '8787', 10);
const host = process.env.RELAY_HOST ?? '127.0.0.1';
const timelineCacheLimit = Number.parseInt(process.env.RELAY_TIMELINE_CACHE_LIMIT ?? '200', 10);

const state = {
  hosts: new Map(),
  hostConnections: new Map(),
  sessions: new Map(),
  clients: new Set(),
  subscriptions: new Map(),
  timelineEvents: new Map(),
  nextTimelineCursor: 1
};

const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(createHealthPayload()));
    return;
  }

  response.writeHead(404);
  response.end('not found');
});

server.on('upgrade', (request, socket, head) => {
  handleWebSocketUpgrade(request, socket, head, (connection) => {
    connection.role = undefined;
    connection.hostId = undefined;

    connection.on('message', (raw) => handleMessage(connection, raw));
    connection.on('close', () => handleClose(connection));
    connection.on('error', (error) => {
      console.error('[relay] websocket error', error.message);
      handleClose(connection);
    });
  });
});

server.listen(port, host, () => {
  console.log(`[relay] listening on ws://${host}:${port}`);
});

function handleMessage(connection, raw) {
  try {
    const message = decodeMessage(raw);

    switch (message.type) {
      case MessageType.HostRegister:
        handleHostRegister(connection, message);
        break;
      case MessageType.HostHeartbeat:
        handleHostHeartbeat(connection, message);
        break;
      case MessageType.SessionCreateEphemeral:
        handleSessionCreateEphemeral(connection, message);
        break;
      case MessageType.SessionSnapshot:
        handleSessionSnapshot(connection, message);
        break;
      case MessageType.SessionSubscribe:
        handleSessionSubscribe(connection, message);
        break;
      case MessageType.SessionPrompt:
        handleSessionPrompt(connection, message);
        break;
      case MessageType.SessionTimelineRequest:
        handleSessionTimelineRequest(connection, message);
        break;
      case MessageType.TimelineEvent:
        handleTimelineEvent(connection, message);
        break;
      default:
        sendError(connection, `Unsupported message type: ${message.type}`);
    }
  } catch (error) {
    sendError(connection, error.message);
  }
}

function createHealthPayload() {
  const cachedTimelineEvents = [...state.timelineEvents.values()]
    .reduce((total, events) => total + events.length, 0);

  return {
    ok: true,
    service: 'codex-mobile-companion-relay',
    listen: {
      host,
      port,
      websocket_url: `ws://${host}:${port}`,
      health_url: `http://${host}:${port}/health`,
      lan_access_enabled: host === '0.0.0.0'
    },
    counts: {
      hosts: state.hosts.size,
      online_hosts: state.hostConnections.size,
      sessions: state.sessions.size,
      clients: state.clients.size,
      subscriptions: state.subscriptions.size,
      cached_timeline_sessions: state.timelineEvents.size,
      cached_timeline_events: cachedTimelineEvents
    },
    cache: {
      timeline_cache_limit: timelineCacheLimit,
      next_timeline_cursor: String(state.nextTimelineCursor)
    },
    checked_at: new Date().toISOString()
  };
}

function handleHostRegister(connection, message) {
  requirePayloadField(message, 'host_id');
  requirePayloadField(message, 'display_name');

  const host = {
    ...message.payload,
    status: 'online',
    last_seen_at: new Date().toISOString()
  };

  connection.role = SenderRole.Host;
  connection.hostId = host.host_id;
  state.hosts.set(host.host_id, host);
  state.hostConnections.set(host.host_id, connection);

  console.log(`[relay] host registered: ${host.host_id}`);
}

function handleHostHeartbeat(connection, message) {
  requirePayloadField(message, 'host_id');

  const host = state.hosts.get(message.payload.host_id);
  if (!host) {
    sendError(connection, `Unknown host: ${message.payload.host_id}`);
    return;
  }

  host.last_seen_at = new Date().toISOString();
  host.status = 'online';
}

function handleSessionCreateEphemeral(connection, message) {
  requirePayloadField(message, 'host_id');

  connection.role = SenderRole.Client;
  state.clients.add(connection);

  const hostConnection = state.hostConnections.get(message.payload.host_id);
  if (!hostConnection) {
    sendError(connection, `Host is offline: ${message.payload.host_id}`);
    return;
  }

  console.log(`[relay] routing ephemeral session create to host ${message.payload.host_id}`);
  send(hostConnection, message);
}

function handleSessionSnapshot(connection, message) {
  requirePayloadField(message, 'session');

  const { session } = message.payload;
  state.sessions.set(session.session_id, session);

  console.log(`[relay] session snapshot: ${session.session_id}`);
  broadcastToClients(message);
}

function handleSessionSubscribe(connection, message) {
  requirePayloadField(message, 'session_id');

  connection.role = SenderRole.Client;
  state.clients.add(connection);

  const sessionId = message.payload.session_id;
  const subscriptions = state.subscriptions.get(connection) ?? new Set();
  subscriptions.add(sessionId);
  state.subscriptions.set(connection, subscriptions);

  if (sessionId === '*') {
    for (const session of state.sessions.values()) {
      send(connection, createMessage(MessageType.SessionSnapshot, { session }));
    }
    return;
  }

  const session = state.sessions.get(sessionId);
  if (session) {
    send(connection, createMessage(MessageType.SessionSnapshot, { session }));
    sendCachedTimeline(connection, sessionId, {
      afterCursor: message.payload.after_cursor,
      limit: message.payload.limit
    });
  }
}

function handleSessionPrompt(connection, message) {
  requirePayloadField(message, 'session_id');
  requirePayloadField(message, 'text');

  connection.role = SenderRole.Client;
  state.clients.add(connection);

  const session = state.sessions.get(message.payload.session_id);
  if (!session) {
    sendError(connection, `Unknown session: ${message.payload.session_id}`);
    return;
  }

  const hostConnection = state.hostConnections.get(session.host_id);
  if (!hostConnection) {
    sendError(connection, `Host is offline: ${session.host_id}`);
    return;
  }

  console.log(`[relay] routing prompt to host ${session.host_id}: ${message.payload.text}`);
  send(hostConnection, message);
}

function handleSessionTimelineRequest(connection, message) {
  requirePayloadField(message, 'session_id');

  connection.role = SenderRole.Client;
  state.clients.add(connection);

  const session = state.sessions.get(message.payload.session_id);
  if (!session) {
    sendError(connection, `Unknown session: ${message.payload.session_id}`);
    return;
  }

  const subscriptions = state.subscriptions.get(connection) ?? new Set();
  subscriptions.add(message.payload.session_id);
  state.subscriptions.set(connection, subscriptions);

  sendCachedTimeline(connection, message.payload.session_id, {
    afterCursor: message.payload.after_cursor,
    limit: message.payload.limit
  });

  if (message.payload.cache_only === true) {
    return;
  }

  const hostConnection = state.hostConnections.get(session.host_id);
  if (!hostConnection) {
    sendError(connection, `Host is offline: ${session.host_id}`);
    return;
  }

  console.log(`[relay] routing timeline request to host ${session.host_id}: ${message.payload.session_id}`);
  send(hostConnection, message);
}

function handleTimelineEvent(connection, message) {
  requirePayloadField(message, 'event');
  const event = cacheTimelineEvent(message.payload.event);
  console.log(`[relay] timeline event: ${event.title}`);
  broadcastToClients(createMessage(MessageType.TimelineEvent, { event }));
}

function handleClose(connection) {
  state.clients.delete(connection);
  state.subscriptions.delete(connection);

  if (connection.hostId) {
    const host = state.hosts.get(connection.hostId);
    if (host) {
      host.status = 'offline';
      host.last_seen_at = new Date().toISOString();
    }

    state.hostConnections.delete(connection.hostId);
    console.log(`[relay] host disconnected: ${connection.hostId}`);
  }
}

function broadcastToClients(message) {
  for (const client of state.clients) {
    const eventSessionId = message.payload?.event?.session_id;
    const snapshotSessionId = message.payload?.session?.session_id;
    const sessionId = eventSessionId ?? snapshotSessionId;
    const subscriptions = state.subscriptions.get(client);

    if (!sessionId || !subscriptions || subscriptions.has(sessionId)) {
      send(client, message);
    }
  }
}

function cacheTimelineEvent(event) {
  const cursor = state.nextTimelineCursor;
  state.nextTimelineCursor += 1;

  const cachedEvent = {
    ...event,
    cursor: String(cursor),
    cached_at: new Date().toISOString()
  };

  const events = state.timelineEvents.get(cachedEvent.session_id) ?? [];
  events.push(cachedEvent);

  while (events.length > timelineCacheLimit) {
    events.shift();
  }

  state.timelineEvents.set(cachedEvent.session_id, events);
  return cachedEvent;
}

function sendCachedTimeline(connection, sessionId, options = {}) {
  const cachedEvents = state.timelineEvents.get(sessionId) ?? [];
  if (cachedEvents.length === 0) {
    return;
  }

  const afterCursor = parseCursor(options.afterCursor);
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : cachedEvents.length;
  const selectedEvents = cachedEvents
    .filter((event) => parseCursor(event.cursor) > afterCursor)
    .slice(0, limit);

  for (const event of selectedEvents) {
    send(connection, createMessage(MessageType.TimelineEvent, {
      event: {
        ...event,
        replayed_from_cache: true
      }
    }));
  }
}

function parseCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') {
    return 0;
  }

  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function send(connection, message) {
  try {
    connection.sendText(encodeMessage(message));
  } catch (error) {
    console.error('[relay] failed to send websocket message', error.message);
    handleClose(connection);
  }
}

function sendError(connection, detail) {
  send(connection, createMessage(MessageType.Error, { detail }));
}
