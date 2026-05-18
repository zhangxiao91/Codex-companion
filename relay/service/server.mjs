import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import {
  MessageType,
  SenderRole,
  createMessage,
  decodeMessage,
  encodeMessage,
  requirePayloadField
} from '../../packages/protocol/index.mjs';
import { createIdentityStore, snapshotIdentityState } from './identity-store.mjs';
import { handleWebSocketUpgrade } from './ws-server.mjs';

const port = Number.parseInt(process.env.RELAY_PORT ?? '8787', 10);
const host = process.env.RELAY_HOST ?? '127.0.0.1';
const timelineCacheLimit = Number.parseInt(process.env.RELAY_TIMELINE_CACHE_LIMIT ?? '2000', 10);
const devToken = process.env.RELAY_DEV_TOKEN ?? '';
const pairingToken = process.env.RELAY_PAIRING_TOKEN ?? devToken;
const hostToken = process.env.RELAY_HOST_TOKEN ?? devToken;
const maxMessageBytes = Number.parseInt(process.env.RELAY_MAX_MESSAGE_BYTES ?? '65536', 10);
const maxPromptLength = Number.parseInt(process.env.RELAY_MAX_PROMPT_LENGTH ?? '4000', 10);
const auditLogLimit = Number.parseInt(process.env.RELAY_AUDIT_LOG_LIMIT ?? '500', 10);
const gitAuditLogPath = resolve(process.env.RELAY_GIT_AUDIT_LOG_PATH ?? '.relay/git-audit.ndjson');
const publicHttpUrl = trimTrailingSlash(process.env.RELAY_PUBLIC_HTTP_URL ?? '');
const publicWsUrl = trimTrailingSlash(process.env.RELAY_PUBLIC_WS_URL ?? '');
const identityStore = createIdentityStore();

if (host === '0.0.0.0' && !hasAnyRelaySecret()) {
  console.error('[relay] refusing to listen on 0.0.0.0 without RELAY_DEV_TOKEN, RELAY_PAIRING_TOKEN, or RELAY_HOST_TOKEN');
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
  gitAuditEvents: [],
  deviceTokens: new Map(),
  nextTimelineCursor: 1
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://relay.local');
  const path = url.pathname;

  if (path === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(createHealthPayload(request)));
    return;
  }

  if (path === '/pair' && request.method === 'POST') {
    await handlePairRequest(request, response);
    return;
  }

  if (path === '/git/audit' && request.method === 'GET') {
    handleGitAuditQuery(request, response, url);
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

await loadGitAuditEvents();
loadIdentityState();

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
      case MessageType.GitRequest:
        handleGitRequest(connection, message);
        break;
      case MessageType.GitSnapshot:
        handleGitSnapshot(connection, message);
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
  const authRequired = hasAnyRelaySecret();
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
      public_websocket_url: publicWsUrl || null,
      public_health_url: publicHttpUrl ? `${publicHttpUrl}/health` : null,
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
      git_audit_events: state.gitAuditEvents.length,
      cached_timeline_sessions: state.timelineEvents.size,
      cached_timeline_events: cachedTimelineEvents
    },
    cache: {
      timeline_cache_limit: timelineCacheLimit,
      next_timeline_cursor: String(state.nextTimelineCursor)
    },
    audit: {
      git_audit_log_path: gitAuditLogPath,
      audit_log_limit: auditLogLimit,
      persistent_git_audit_enabled: true
    },
    identity: {
      identity_store_path: identityStore.path,
      persistent_identity_enabled: true,
      stored_devices: state.deviceTokens.size,
      stored_hosts: state.hosts.size
    },
    checked_at: new Date().toISOString()
  };
}

function isAuthorized(message) {
  if (!hasAnyRelaySecret()) {
    return true;
  }

  if (isHostMessage(message.type)) {
    return isAuthorizedHostToken(message.auth?.host_token)
      || isAuthorizedHostToken(message.auth?.dev_token)
      || isAuthorizedHostToken(message.auth?.token);
  }

  if (isClientMessage(message.type)) {
    return isAuthorizedDeviceToken(message.auth?.device_token)
      || isAuthorizedDeviceToken(message.auth?.token);
  }

  return false;
}

function isHealthRequestAuthorized(request) {
  if (!hasAnyRelaySecret()) {
    return true;
  }

  const authorization = request.headers.authorization ?? '';
  const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  return isAuthorizedRelaySecret(request.headers['x-relay-dev-token'])
    || isAuthorizedRelaySecret(request.headers['x-relay-pairing-token'])
    || isAuthorizedRelaySecret(request.headers['x-relay-host-token'])
    || isAuthorizedRelaySecret(request.headers['x-relay-auth-token'])
    || isAuthorizedDeviceToken(request.headers['x-relay-device-token'])
    || isAuthorizedDeviceToken(request.headers['x-relay-auth-token'])
    || isAuthorizedDeviceToken(bearerToken);
}

function hasAnyRelaySecret() {
  return Boolean(devToken || pairingToken || hostToken);
}

function isAuthorizedRelaySecret(token) {
  return isAuthorizedPairingToken(token) || isAuthorizedHostToken(token);
}

function isAuthorizedPairingToken(token) {
  return Boolean(token && pairingToken && token === pairingToken);
}

function isAuthorizedHostToken(token) {
  return Boolean(token && hostToken && token === hostToken);
}

function isAuthorizedDeviceToken(token) {
  if (!token || !state.deviceTokens.has(token)) {
    return false;
  }

  state.deviceTokens.get(token).last_seen_at = new Date().toISOString();
  persistIdentityState();
  return true;
}

function isHostMessage(type) {
  return type === MessageType.HostRegister
    || type === MessageType.HostHeartbeat
    || type === MessageType.ApprovalRequest
    || type === MessageType.GitSnapshot
    || type === MessageType.SessionSnapshot
    || type === MessageType.TimelineEvent;
}

function isClientMessage(type) {
  return type === MessageType.ApprovalDecision
    || type === MessageType.GitRequest
    || type === MessageType.SessionCreateEphemeral
    || type === MessageType.SessionSubscribe
    || type === MessageType.SessionPrompt
    || type === MessageType.SessionTimelineRequest;
}

async function handlePairRequest(request, response) {
  try {
    console.log(`[relay] pair request from ${request.socket.remoteAddress ?? 'unknown'}`);
    if (!pairingToken) {
      writeJson(response, 400, {
        ok: false,
        error: 'pairing_disabled',
        detail: 'Set RELAY_PAIRING_TOKEN before pairing devices.'
      });
      return;
    }

    if (!isAuthorizedPairingToken(request.headers['x-relay-pairing-token'])
      && !isAuthorizedPairingToken(request.headers['x-relay-dev-token'])
      && !isAuthorizedPairingToken(request.headers['x-relay-auth-token'])) {
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
    persistIdentityState();

    console.log(`[relay] paired device: ${deviceId}`);
    writeJson(response, 200, {
      ok: true,
      device_id: deviceId,
      device_token: deviceToken,
      paired_at: pairedAt
    });
  } catch (error) {
    console.error(`[relay] pair request failed: ${error.message}`);
    writeJson(response, 400, {
      ok: false,
      error: 'pairing_failed',
      detail: error.message
    });
  }
}

function handleGitAuditQuery(request, response, url) {
  if (!isHealthRequestAuthorized(request)) {
    writeJson(response, 401, {
      ok: false,
      error: 'unauthorized',
      detail: 'Missing or invalid Relay auth token.'
    });
    return;
  }

  const sessionId = url.searchParams.get('session_id') ?? '';
  const hostId = url.searchParams.get('host_id') ?? '';
  const action = url.searchParams.get('action') ?? '';
  const phase = url.searchParams.get('phase') ?? '';
  const limit = clampInteger(url.searchParams.get('limit'), 1, auditLogLimit, 100);
  const events = state.gitAuditEvents
    .filter((event) => !sessionId || event.session_id === sessionId)
    .filter((event) => !hostId || event.host_id === hostId)
    .filter((event) => !action || event.action === action)
    .filter((event) => !phase || event.phase === phase)
    .slice(-limit)
    .reverse();

  writeJson(response, 200, {
    ok: true,
    events,
    count: events.length,
    total_in_memory: state.gitAuditEvents.length,
    audit_log_path: gitAuditLogPath
  });
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

async function loadGitAuditEvents() {
  try {
    const content = await readFile(gitAuditLogPath, 'utf8');
    const events = content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(isGitAuditEvent);
    state.gitAuditEvents = events.slice(-auditLogLimit);
    console.log(`[relay] loaded ${state.gitAuditEvents.length} git audit event(s) from ${gitAuditLogPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`[relay] failed to load git audit log: ${error.message}`);
    }
  }
}

function persistGitAuditEvent(event) {
  try {
    mkdirSync(dirname(gitAuditLogPath), { recursive: true });
    appendFileSync(gitAuditLogPath, `${JSON.stringify(event)}\n`, 'utf8');
  } catch (error) {
    console.error(`[relay] failed to persist git audit event: ${error.message}`);
  }
}

function loadIdentityState() {
  try {
    const snapshot = identityStore.load();
    for (const device of snapshot.devices) {
      state.deviceTokens.set(device.token, {
        device_id: device.device_id,
        display_name: device.display_name,
        paired_at: device.paired_at ?? new Date().toISOString(),
        last_seen_at: device.last_seen_at ?? device.paired_at ?? new Date().toISOString()
      });
    }

    for (const host of snapshot.hosts) {
      state.hosts.set(host.host_id, {
        ...host,
        status: 'offline',
        last_seen_at: host.last_seen_at ?? new Date().toISOString()
      });
    }

    if (snapshot.devices.length > 0 || snapshot.hosts.length > 0) {
      console.log(`[relay] loaded ${snapshot.devices.length} device(s) and ${snapshot.hosts.length} host(s) from ${identityStore.path}`);
    }
  } catch (error) {
    console.error(`[relay] failed to load identity store: ${error.message}`);
  }
}

function persistIdentityState() {
  try {
    identityStore.save(snapshotIdentityState(state));
  } catch (error) {
    console.error(`[relay] failed to persist identity store: ${error.message}`);
  }
}

function isGitAuditEvent(event) {
  return event
    && typeof event.event_id === 'string'
    && typeof event.audit_id === 'string'
    && typeof event.phase === 'string'
    && typeof event.session_id === 'string'
    && typeof event.host_id === 'string'
    && typeof event.action === 'string';
}

function writeJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    connection: 'close'
  });
  response.end(body);
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
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
  persistIdentityState();

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
  persistIdentityState();
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

function handleGitRequest(connection, message) {
  requirePayloadField(message, 'session_id');
  requirePayloadField(message, 'action');

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

  const subscriptions = state.subscriptions.get(connection) ?? new Set();
  subscriptions.add(message.payload.session_id);
  state.subscriptions.set(connection, subscriptions);

  const auditId = randomUUID();
  appendGitAuditEvent({
    audit_id: auditId,
    phase: 'requested',
    session_id: session.session_id,
    host_id: session.host_id,
    action: message.payload.action,
    file_path: sanitizeAuditFilePath(message.payload.file_path),
    device: deviceInfoForMessage(message),
    requested_at: new Date().toISOString()
  });

  console.log(`[relay] routing git ${message.payload.action} to host ${session.host_id}: ${message.payload.session_id}`);
  send(hostConnection, {
    ...message,
    payload: {
      ...message.payload,
      audit_id: auditId
    }
  });
}

function handleGitSnapshot(connection, message) {
  requirePayloadField(message, 'snapshot');

  const snapshot = message.payload.snapshot;
  console.log(`[relay] git snapshot: ${snapshot.session_id} ${snapshot.action}`);
  appendGitAuditEvent({
    audit_id: snapshot.audit_id || randomUUID(),
    phase: 'completed',
    session_id: snapshot.session_id,
    host_id: snapshot.host_id,
    action: snapshot.action,
    file_path: sanitizeAuditFilePath(snapshot.selected_file_path),
    result_ok: snapshot.result?.ok ?? null,
    result_message: summarizeAuditMessage(snapshot.result?.message),
    changed_file_count: Array.isArray(snapshot.files) ? snapshot.files.length : 0,
    completed_at: new Date().toISOString()
  });
  broadcastToClients(message);
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
      if (!state.hostConnections.has(session.host_id)) {
        continue;
      }
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
  if (session && state.hostConnections.has(session.host_id)) {
    send(connection, createMessage(MessageType.SessionSnapshot, { session }));
    for (const approval of state.approvals.values()) {
      if (approval.session_id === sessionId && approval.status === 'pending') {
        send(connection, createMessage(MessageType.ApprovalRequest, { approval }));
      }
    }
    sendCachedTimeline(connection, sessionId, {
      afterCursor: message.payload.after_cursor,
      beforeCursor: message.payload.before_cursor,
      limit: message.payload.limit,
      page: message.payload.page === true
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
    beforeCursor: message.payload.before_cursor,
    limit: message.payload.limit,
    page: message.payload.page === true
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
    clearSessionsForHost(connection.hostId);
    console.log(`[relay] host disconnected: ${connection.hostId}`);
  }
}

function clearSessionsForHost(hostId) {
  for (const [sessionId, session] of state.sessions.entries()) {
    if (session.host_id === hostId) {
      state.sessions.delete(sessionId);
    }
  }
}

function broadcastToClients(message) {
  for (const client of state.clients) {
    const eventSessionId = message.payload?.event?.session_id;
    const snapshotSessionId = message.payload?.session?.session_id;
    const gitSessionId = message.payload?.snapshot?.session_id;
    const sessionId = eventSessionId ?? snapshotSessionId ?? gitSessionId;
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

function appendGitAuditEvent(event) {
  const auditEvent = {
    event_id: randomUUID(),
    created_at: new Date().toISOString(),
    ...event
  };

  state.gitAuditEvents.push(auditEvent);
  while (state.gitAuditEvents.length > auditLogLimit) {
    state.gitAuditEvents.shift();
  }
  persistGitAuditEvent(auditEvent);

  const timelineEvent = cacheTimelineEvent(createGitAuditTimelineEvent(auditEvent));
  broadcastToClients(createMessage(MessageType.TimelineEvent, { event: timelineEvent }));
}

function createGitAuditTimelineEvent(auditEvent) {
  const fileSuffix = auditEvent.file_path ? ` ${auditEvent.file_path}` : '';
  const result = auditEvent.result_ok === null || auditEvent.result_ok === undefined
    ? ''
    : ` result=${auditEvent.result_ok ? 'ok' : 'blocked'}`;

  return {
    event_id: randomUUID(),
    session_id: auditEvent.session_id,
    created_at: auditEvent.created_at,
    type: 'git_audit',
    title: `Git ${auditEvent.phase}: ${auditEvent.action}`,
    summary: `${auditEvent.phase} git ${auditEvent.action}${fileSuffix}${result}`.trim(),
    payload: {
      audit_id: auditEvent.audit_id,
      phase: auditEvent.phase,
      action: auditEvent.action,
      file_path: auditEvent.file_path ?? '',
      host_id: auditEvent.host_id,
      device_id: auditEvent.device?.device_id ?? '',
      device_display_name: auditEvent.device?.display_name ?? '',
      result_ok: auditEvent.result_ok ?? null,
      result_message: auditEvent.result_message ?? '',
      changed_file_count: auditEvent.changed_file_count ?? null
    },
    redaction_level: 'metadata'
  };
}

function deviceInfoForMessage(message) {
  const token = message.auth?.device_token ?? message.auth?.token;
  const device = token ? state.deviceTokens.get(token) : undefined;
  if (!device) {
    return {
      device_id: 'unknown',
      display_name: 'Unknown device'
    };
  }

  return {
    device_id: device.device_id,
    display_name: device.display_name
  };
}

function sanitizeAuditFilePath(filePath) {
  return typeof filePath === 'string' ? filePath.slice(0, 240) : '';
}

function summarizeAuditMessage(message) {
  return typeof message === 'string' ? message.slice(0, 240) : '';
}

function sendCachedTimeline(connection, sessionId, options = {}) {
  const cachedEvents = state.timelineEvents.get(sessionId) ?? [];
  if (cachedEvents.length === 0 && options.page !== true) {
    return;
  }

  const afterCursor = parseCursor(options.afterCursor);
  const beforeCursor = parseCursor(options.beforeCursor);
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : cachedEvents.length;
  const selectedEvents = beforeCursor > 0
    ? cachedEvents
      .filter((event) => parseCursor(event.cursor) < beforeCursor)
      .slice(-limit)
    : cachedEvents
      .filter((event) => parseCursor(event.cursor) > afterCursor)
      .slice(0, limit);
  const replayedEvents = selectedEvents.map((event) => ({
    ...event,
    replayed_from_cache: true
  }));
  const selectedCursors = selectedEvents
    .map((event) => parseCursor(event.cursor))
    .filter((cursor) => cursor > 0);
  const oldestSelectedCursor = selectedCursors.length > 0 ? Math.min(...selectedCursors) : 0;
  const newestSelectedCursor = selectedCursors.length > 0 ? Math.max(...selectedCursors) : 0;
  const hasMoreBefore = oldestSelectedCursor > 0
    ? cachedEvents.some((event) => parseCursor(event.cursor) < oldestSelectedCursor)
    : false;
  const hasMoreAfter = newestSelectedCursor > 0
    ? cachedEvents.some((event) => parseCursor(event.cursor) > newestSelectedCursor)
    : false;

  if (options.page === true) {
    send(connection, createMessage(MessageType.TimelinePage, {
      session_id: sessionId,
      events: replayedEvents,
      before_cursor: options.beforeCursor ?? null,
      after_cursor: options.afterCursor ?? null,
      oldest_cursor: oldestSelectedCursor > 0 ? String(oldestSelectedCursor) : null,
      newest_cursor: newestSelectedCursor > 0 ? String(newestSelectedCursor) : null,
      has_more_before: hasMoreBefore,
      has_more_after: hasMoreAfter
    }));
    return;
  }

  for (const event of replayedEvents) {
    send(connection, createMessage(MessageType.TimelineEvent, {
      event
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
