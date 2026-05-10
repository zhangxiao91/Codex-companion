import { randomBytes, randomUUID } from 'node:crypto';
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
const devToken = process.env.RELAY_DEV_TOKEN ?? '';
const maxMessageBytes = Number.parseInt(process.env.RELAY_MAX_MESSAGE_BYTES ?? '65536', 10);
const maxPromptLength = Number.parseInt(process.env.RELAY_MAX_PROMPT_LENGTH ?? '4000', 10);

if (host === '0.0.0.0' && !devToken) {
  console.error('[relay] refusing to listen on 0.0.0.0 without RELAY_DEV_TOKEN');
  process.exit(1);
}

const state = {
  hosts: new Map(),
  hostConnections: new Map(),
  sessions: new Map(),
  approvals: new Map(),
  clients: new Set(),
  subscriptions: new Map(),
  timelineEvents: new Map(),
  deviceTokens: new Map(),
  nextTimelineCursor: 1
};

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://relay.local').pathname;

  if (path === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(createHealthPayload(request)));
    return;
  }

  if (path === '/pair' && request.method === 'POST') {
    await handlePairRequest(request, response);
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
    if (Buffer.byteLength(raw, 'utf8') > maxMessageBytes) {
      sendError(connection, `Message is too large. Maximum is ${maxMessageBytes} bytes.`);
      return;
    }

    const message = decodeMessage(raw);
    if (!isAuthorized(message)) {
      sendError(connection, 'Unauthorized: missing or invalid Relay auth token.');
      return;
    }

    switch (message.type) {
      case MessageType.HostRegister:
        handleHostRegister(connection, message);
        break;
      case MessageType.HostHeartbeat:
        handleHostHeartbeat(connection, message);
        break;
      case MessageType.ApprovalRequest:
        handleApprovalRequest(connection, message);
        break;
      case MessageType.ApprovalDecision:
        handleApprovalDecision(connection, message);
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

function createHealthPayload(request) {
  const authRequired = Boolean(devToken);
  const authorized = isHealthRequestAuthorized(request);

  if (authRequired && !authorized) {
    return {
      ok: true,
      service: 'codex-mobile-companion-relay',
      auth_required: true,
      detail: 'Set X-Relay-Dev-Token to receive detailed diagnostics.',
      checked_at: new Date().toISOString()
    };
  }

  const cachedTimelineEvents = [...state.timelineEvents.values()]
    .reduce((total, events) => total + events.length, 0);

  return {
    ok: true,
    service: 'codex-mobile-companion-relay',
    auth_required: authRequired,
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
      approvals: state.approvals.size,
      clients: state.clients.size,
      subscriptions: state.subscriptions.size,
      paired_devices: state.deviceTokens.size,
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

function isAuthorized(message) {
  if (!devToken) {
    return true;
  }

  if (isHostMessage(message.type)) {
    return isAuthorizedToken(message.auth?.dev_token)
      || isAuthorizedToken(message.auth?.token);
  }

  if (isClientMessage(message.type)) {
    return isAuthorizedDeviceToken(message.auth?.device_token)
      || isAuthorizedDeviceToken(message.auth?.token);
  }

  return false;
}

function isHealthRequestAuthorized(request) {
  if (!devToken) {
    return true;
  }

  const authorization = request.headers.authorization ?? '';
  const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  return isAuthorizedToken(request.headers['x-relay-dev-token'])
    || isAuthorizedToken(request.headers['x-relay-auth-token'])
    || isAuthorizedDeviceToken(request.headers['x-relay-device-token'])
    || isAuthorizedDeviceToken(request.headers['x-relay-auth-token'])
    || isAuthorizedDeviceToken(bearerToken);
}

function isAuthorizedToken(token) {
  return Boolean(devToken && token === devToken);
}

function isAuthorizedDeviceToken(token) {
  if (!token || !state.deviceTokens.has(token)) {
    return false;
  }

  state.deviceTokens.get(token).last_seen_at = new Date().toISOString();
  return true;
}

function isHostMessage(type) {
  return type === MessageType.HostRegister
    || type === MessageType.HostHeartbeat
    || type === MessageType.ApprovalRequest
    || type === MessageType.SessionSnapshot
    || type === MessageType.TimelineEvent;
}

function isClientMessage(type) {
  return type === MessageType.ApprovalDecision
    || type === MessageType.SessionCreateEphemeral
    || type === MessageType.SessionSubscribe
    || type === MessageType.SessionPrompt
    || type === MessageType.SessionTimelineRequest;
}

async function handlePairRequest(request, response) {
  try {
    if (!devToken) {
      writeJson(response, 400, {
        ok: false,
        error: 'pairing_disabled',
        detail: 'Set RELAY_DEV_TOKEN before pairing devices.'
      });
      return;
    }

    if (!isAuthorizedToken(request.headers['x-relay-dev-token'])
      && !isAuthorizedToken(request.headers['x-relay-auth-token'])) {
      writeJson(response, 401, {
        ok: false,
        error: 'unauthorized',
        detail: 'Missing or invalid pairing token.'
      });
      return;
    }

    const rawBody = await readRequestBody(request, 4096);
    const body = rawBody ? JSON.parse(rawBody) : {};
    const deviceId = typeof body.device_id === 'string' && body.device_id.trim()
      ? body.device_id.trim()
      : randomUUID();
    const displayName = typeof body.display_name === 'string' && body.display_name.trim()
      ? body.display_name.trim().slice(0, 80)
      : 'Android device';
    const deviceToken = `cmc_dev_${randomBytes(32).toString('base64url')}`;
    const pairedAt = new Date().toISOString();

    state.deviceTokens.set(deviceToken, {
      device_id: deviceId,
      display_name: displayName,
      paired_at: pairedAt,
      last_seen_at: pairedAt
    });

    console.log(`[relay] paired device: ${deviceId}`);
    writeJson(response, 200, {
      ok: true,
      device_id: deviceId,
      device_token: deviceToken,
      paired_at: pairedAt
    });
  } catch (error) {
    writeJson(response, 400, {
      ok: false,
      error: 'pairing_failed',
      detail: error.message
    });
  }
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function readRequestBody(request, limitBytes) {
  return new Promise((resolve, reject) => {
    let body = '';

    request.on('data', (chunk) => {
      body += chunk.toString('utf8');
      if (Buffer.byteLength(body, 'utf8') > limitBytes) {
        reject(new Error(`Request body is too large. Maximum is ${limitBytes} bytes.`));
        request.destroy();
      }
    });

    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
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

function handleApprovalRequest(connection, message) {
  requirePayloadField(message, 'approval');

  const { approval } = message.payload;
  requireApprovalField(approval, 'approval_id');
  requireApprovalField(approval, 'session_id');

  state.approvals.set(approval.approval_id, {
    ...approval,
    status: approval.status ?? 'pending',
    updated_at: new Date().toISOString()
  });

  console.log(`[relay] approval requested: ${approval.approval_id}`);
  broadcastToClients(createMessage(MessageType.ApprovalRequest, {
    approval: state.approvals.get(approval.approval_id)
  }));
}

function handleApprovalDecision(connection, message) {
  requirePayloadField(message, 'approval_id');
  requirePayloadField(message, 'decision');

  connection.role = SenderRole.Client;
  state.clients.add(connection);

  const approval = state.approvals.get(message.payload.approval_id);
  if (!approval) {
    sendError(connection, `Unknown approval: ${message.payload.approval_id}`);
    return;
  }

  if (approval.status && approval.status !== 'pending') {
    sendError(connection, `Approval is already resolved: ${message.payload.approval_id}`);
    return;
  }

  const session = state.sessions.get(approval.session_id);
  if (!session) {
    sendError(connection, `Unknown session for approval: ${approval.session_id}`);
    return;
  }

  const hostConnection = state.hostConnections.get(session.host_id);
  if (!hostConnection) {
    sendError(connection, `Host is offline: ${session.host_id}`);
    return;
  }

  const resolvedApproval = {
    ...approval,
    status: message.payload.decision,
    decided_at: new Date().toISOString()
  };
  state.approvals.set(approval.approval_id, resolvedApproval);

  console.log(`[relay] routing approval decision to host ${session.host_id}: ${approval.approval_id}`);
  send(hostConnection, message);
  broadcastToClients(createMessage(MessageType.ApprovalRequest, { approval: resolvedApproval }));
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
    for (const approval of state.approvals.values()) {
      if (approval.status === 'pending') {
        send(connection, createMessage(MessageType.ApprovalRequest, { approval }));
      }
    }
    return;
  }

  const session = state.sessions.get(sessionId);
  if (session) {
    send(connection, createMessage(MessageType.SessionSnapshot, { session }));
    for (const approval of state.approvals.values()) {
      if (approval.session_id === sessionId && approval.status === 'pending') {
        send(connection, createMessage(MessageType.ApprovalRequest, { approval }));
      }
    }
    sendCachedTimeline(connection, sessionId, {
      afterCursor: message.payload.after_cursor,
      limit: message.payload.limit
    });
  }
}

function handleSessionPrompt(connection, message) {
  requirePayloadField(message, 'session_id');
  requirePayloadField(message, 'text');
  if (message.payload.text.length > maxPromptLength) {
    sendError(connection, `Prompt is too long. Maximum is ${maxPromptLength} characters.`);
    return;
  }

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

  console.log(`[relay] routing prompt to host ${session.host_id}: ${message.payload.session_id}`);
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

    if (!sessionId || !subscriptions || subscriptions.has('*') || subscriptions.has(sessionId)) {
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

function requireApprovalField(approval, field) {
  if (!approval || approval[field] === undefined || approval[field] === null) {
    throw new Error(`Approval is missing ${field}.`);
  }
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
