import { randomBytes, randomUUID } from 'node:crypto';
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
import { deriveSessionStage } from './session-stage.mjs';
import { createRelaySqliteStore } from './sqlite-store.mjs';
import { handleWebSocketUpgrade } from './ws-server.mjs';

const port = Number.parseInt(process.env.RELAY_PORT ?? '8787', 10);
const host = process.env.RELAY_HOST ?? '127.0.0.1';
const timelineCacheLimit = Number.parseInt(process.env.RELAY_TIMELINE_CACHE_LIMIT ?? '20000', 10);
const devToken = process.env.RELAY_DEV_TOKEN ?? '';
const pairingToken = process.env.RELAY_PAIRING_TOKEN ?? devToken;
const hostToken = process.env.RELAY_HOST_TOKEN ?? devToken;
const maxMessageBytes = Number.parseInt(process.env.RELAY_MAX_MESSAGE_BYTES ?? '3000000', 10);
const maxPromptLength = Number.parseInt(process.env.RELAY_MAX_PROMPT_LENGTH ?? '4000', 10);
const maxPromptImages = Number.parseInt(process.env.RELAY_MAX_PROMPT_IMAGES ?? '4', 10);
const maxPromptImageDataUrlBytes = Number.parseInt(process.env.RELAY_MAX_PROMPT_IMAGE_DATA_URL_BYTES ?? '1500000', 10);
const auditLogLimit = Number.parseInt(process.env.RELAY_AUDIT_LOG_LIMIT ?? '500', 10);
const notificationLogLimit = Number.parseInt(process.env.RELAY_NOTIFICATION_LOG_LIMIT ?? '200', 10);
const processedMessageTtlMs = Number.parseInt(process.env.RELAY_PROCESSED_MESSAGE_TTL_MS ?? '120000', 10);
const wsPingIntervalMs = Number.parseInt(process.env.RELAY_WS_PING_INTERVAL_MS ?? '25000', 10);
const wsStaleTimeoutMs = Number.parseInt(process.env.RELAY_WS_STALE_TIMEOUT_MS ?? '75000', 10);
const approvalPendingTtlMs = Number.parseInt(process.env.RELAY_APPROVAL_PENDING_TTL_MS ?? String(7 * 24 * 60 * 60 * 1000), 10);
const approvalResolvedTtlMs = Number.parseInt(process.env.RELAY_APPROVAL_RESOLVED_TTL_MS ?? String(24 * 60 * 60 * 1000), 10);
const approvalCleanupIntervalMs = Number.parseInt(process.env.RELAY_APPROVAL_CLEANUP_INTERVAL_MS ?? String(60 * 60 * 1000), 10);
const gitAuditLogPath = resolve(process.env.RELAY_GIT_AUDIT_LOG_PATH ?? '.relay/git-audit.ndjson');
const publicHttpUrl = trimTrailingSlash(process.env.RELAY_PUBLIC_HTTP_URL ?? '');
const publicWsUrl = trimTrailingSlash(process.env.RELAY_PUBLIC_WS_URL ?? '');
const identityStore = createIdentityStore();
const relayStore = createRelaySqliteStore({ path: resolveRelaySqlitePath() });

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
  gitSnapshots: new Map(),
  promptQueueStates: new Map(),
  notificationEvents: [],
  deviceTokens: new Map(),
  processedMessageIds: new Map(),
  connections: new Set(),
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

  if (path === '/devices' && request.method === 'GET') {
    handleDevicesQuery(request, response, url);
    return;
  }

  if (path === '/devices/revoke' && request.method === 'POST') {
    await handleDeviceRevoke(request, response);
    return;
  }

  response.writeHead(404);
  response.end('not found');
});

function resolveRelaySqlitePath() {
  if (process.env.RELAY_SQLITE_PATH) {
    return process.env.RELAY_SQLITE_PATH;
  }

  if (process.env.RELAY_IDENTITY_STORE_PATH) {
    return resolve(dirname(process.env.RELAY_IDENTITY_STORE_PATH), 'relay.sqlite');
  }

  if (process.env.RELAY_GIT_AUDIT_LOG_PATH) {
    return resolve(dirname(process.env.RELAY_GIT_AUDIT_LOG_PATH), 'relay.sqlite');
  }

  return '.relay/relay.sqlite';
}

server.on('upgrade', (request, socket, head) => {
  handleWebSocketUpgrade(request, socket, head, (connection) => {
    connection.role = undefined;
    connection.hostId = undefined;
    state.connections.add(connection);

    connection.on('message', (raw) => handleMessage(connection, raw));
    connection.on('close', () => handleClose(connection));
    connection.on('error', (error) => {
      console.error('[relay] websocket error', error.message);
      handleClose(connection);
    });
  });
});

await loadPersistentState();
startApprovalCleanupTimer();
startWebSocketKeepAlive();

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
    if (isDuplicateClientMessage(message)) {
      sendAck(connection, message, 'duplicate');
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
      case MessageType.PowerStatus:
        handlePowerStatus(connection, message);
        break;
      case MessageType.PowerTrustRequest:
        handlePowerTrustRequest(connection, message);
        break;
      case MessageType.PowerTrustChallenge:
        handlePowerTrustChallenge(connection, message);
        break;
      case MessageType.PowerTrustVerify:
        handlePowerTrustVerify(connection, message);
        break;
      case MessageType.PowerTrustGranted:
        handlePowerTrustGranted(connection, message);
        break;
      case MessageType.PowerRequest:
        handlePowerRequest(connection, message);
        break;
      case MessageType.PowerResult:
        handlePowerResult(connection, message);
        break;
      case MessageType.SessionCreate:
      case MessageType.SessionCreateEphemeral:
        handleSessionCreate(connection, message);
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
      case MessageType.SessionPromptQueue:
        handleSessionPromptQueue(connection, message);
        break;
      case MessageType.SessionPromptEdit:
        handleSessionPromptEdit(connection, message);
        break;
      case MessageType.SessionTurnInterrupt:
        handleSessionTurnInterrupt(connection, message);
        break;
      case MessageType.SessionTimelineRequest:
        handleSessionTimelineRequest(connection, message);
        break;
      case MessageType.SessionSyncIndex:
        handleSessionSyncIndex(connection, message);
        break;
      case MessageType.SessionSyncAck:
        handleSessionSyncAck(connection, message);
        break;
      case MessageType.SessionArchiveUpdate:
        handleSessionArchiveUpdate(connection, message);
        break;
      case MessageType.SessionPinUpdate:
        handleSessionPinUpdate(connection, message);
        break;
      case MessageType.TimelineEvent:
        handleTimelineEvent(connection, message);
        break;
      case MessageType.TimelinePage:
        handleTimelinePage(connection, message);
        break;
      default:
        sendError(connection, `Unsupported message type: ${message.type}`);
    }
  } catch (error) {
    sendError(connection, error.message);
  }
}

function isAckableClientMessage(type) {
  return type === MessageType.ApprovalDecision
    || type === MessageType.GitRequest
    || type === MessageType.PowerTrustRequest
    || type === MessageType.PowerTrustVerify
    || type === MessageType.PowerRequest
    || type === MessageType.SessionCreate
    || type === MessageType.SessionCreateEphemeral
    || type === MessageType.SessionPrompt
    || type === MessageType.SessionPromptQueue
    || type === MessageType.SessionPromptEdit
    || type === MessageType.SessionTurnInterrupt
    || type === MessageType.SessionSyncAck
    || type === MessageType.SessionArchiveUpdate
    || type === MessageType.SessionPinUpdate;
}

function isDuplicateClientMessage(message) {
  pruneProcessedMessageIds();
  return isAckableClientMessage(message.type)
    && typeof message.id === 'string'
    && state.processedMessageIds.has(message.id);
}

function rememberProcessedMessage(message) {
  if (typeof message.id !== 'string' || message.id.length === 0) {
    return;
  }
  state.processedMessageIds.set(message.id, Date.now());
  pruneProcessedMessageIds();
}

function pruneProcessedMessageIds() {
  const cutoff = Date.now() - processedMessageTtlMs;
  for (const [messageId, seenAt] of state.processedMessageIds) {
    if (seenAt < cutoff) {
      state.processedMessageIds.delete(messageId);
    }
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
      cached_timeline_events: cachedTimelineEvents,
      prompt_queue_states: state.promptQueueStates.size,
      notification_events: state.notificationEvents.length
    },
    sync: {
      session_sync_index_enabled: true,
      device_session_sync_rows: relayStore.counts().device_session_sync
    },
    cache: {
      timeline_cache_limit: timelineCacheLimit,
      next_timeline_cursor: String(state.nextTimelineCursor)
    },
    websocket: {
      connections: state.connections.size,
      ping_interval_ms: wsPingIntervalMs,
      stale_timeout_ms: wsStaleTimeoutMs
    },
    audit: {
      git_audit_log_path: gitAuditLogPath,
      sqlite_path: relayStore.path,
      audit_log_limit: auditLogLimit,
      persistent_git_audit_enabled: true
    },
    identity: {
      identity_store_path: relayStore.path,
      persistent_identity_enabled: true,
      stored_devices: state.deviceTokens.size,
      stored_hosts: state.hosts.size,
      trusted_host_devices: relayStore.counts().host_devices
    },
    storage: {
      kind: 'sqlite',
      path: relayStore.path,
      counts: relayStore.counts()
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
      || isAuthorizedHostToken(message.auth?.token)
      || isAuthorizedHostDeviceToken(message.auth?.host_device_token)
      || isAuthorizedHostDeviceToken(message.auth?.token);
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
    || isAuthorizedHostDeviceToken(request.headers['x-relay-host-device-token'])
    || isAuthorizedDeviceToken(request.headers['x-relay-device-token'])
    || isAuthorizedDeviceToken(request.headers['x-relay-auth-token'])
    || isAuthorizedDeviceToken(bearerToken);
}

function isAdminRequestAuthorized(request) {
  if (!hasAnyRelaySecret()) {
    return true;
  }

  const authorization = request.headers.authorization ?? '';
  const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  return isAuthorizedRelaySecret(request.headers['x-relay-dev-token'])
    || isAuthorizedRelaySecret(request.headers['x-relay-pairing-token'])
    || isAuthorizedRelaySecret(request.headers['x-relay-host-token'])
    || isAuthorizedRelaySecret(request.headers['x-relay-auth-token'])
    || isAuthorizedRelaySecret(bearerToken);
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

function isAuthorizedHostDeviceToken(token) {
  if (!token) {
    return false;
  }

  const hostDevice = relayStore.findHostDeviceByToken(token);
  if (!hostDevice) {
    return false;
  }

  relayStore.touchHostDevice(token);
  return true;
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
    || type === MessageType.PowerStatus
    || type === MessageType.PowerTrustChallenge
    || type === MessageType.PowerTrustGranted
    || type === MessageType.PowerResult
    || type === MessageType.SessionSnapshot
    || type === MessageType.TimelineEvent
    || type === MessageType.TimelinePage;
}

function isClientMessage(type) {
  return type === MessageType.ApprovalDecision
    || type === MessageType.GitRequest
    || type === MessageType.PowerTrustRequest
    || type === MessageType.PowerTrustVerify
    || type === MessageType.PowerRequest
    || type === MessageType.SessionCreate
    || type === MessageType.SessionCreateEphemeral
    || type === MessageType.SessionSubscribe
    || type === MessageType.SessionPrompt
    || type === MessageType.SessionPromptQueue
    || type === MessageType.SessionPromptEdit
    || type === MessageType.SessionTurnInterrupt
    || type === MessageType.SessionTimelineRequest
    || type === MessageType.SessionSyncIndex
    || type === MessageType.SessionSyncAck
    || type === MessageType.SessionArchiveUpdate
    || type === MessageType.SessionPinUpdate;
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

function handleDevicesQuery(request, response, url) {
  if (!isAdminRequestAuthorized(request)) {
    writeJson(response, 401, {
      ok: false,
      error: 'unauthorized',
      detail: 'Missing or invalid Relay admin token.'
    });
    return;
  }

  const includeRevoked = url.searchParams.get('include_revoked') === '1';
  writeJson(response, 200, {
    ok: true,
    devices: relayStore.listDevices({ includeRevoked }),
    host_devices: relayStore.listHostDevices({ includeRevoked }),
    counts: relayStore.counts()
  });
}

async function handleDeviceRevoke(request, response) {
  if (!isAdminRequestAuthorized(request)) {
    writeJson(response, 401, {
      ok: false,
      error: 'unauthorized',
      detail: 'Missing or invalid Relay admin token.'
    });
    return;
  }

  try {
    const rawBody = await readRequestBody(request, 4096);
    const body = rawBody ? JSON.parse(rawBody) : {};
    const type = String(body.type ?? body.kind ?? '').trim();
    const now = new Date().toISOString();

    if (type === 'android') {
      const deviceId = String(body.device_id ?? '').trim();
      if (!deviceId) {
        throw new Error('device_id is required for android revoke.');
      }
      const revoked = relayStore.revokeDeviceById(deviceId);
      for (const [token, device] of state.deviceTokens.entries()) {
        if (device.device_id === deviceId) {
          state.deviceTokens.delete(token);
        }
      }
      writeJson(response, 200, {
        ok: true,
        type,
        device_id: deviceId,
        revoked,
        revoked_at: now
      });
      return;
    }

    if (type === 'host') {
      const hostDeviceId = String(body.host_device_id ?? '').trim();
      if (!hostDeviceId) {
        throw new Error('host_device_id is required for host revoke.');
      }
      const revoked = relayStore.revokeHostDevice(hostDeviceId);
      writeJson(response, 200, {
        ok: true,
        type,
        host_device_id: hostDeviceId,
        revoked,
        revoked_at: now
      });
      return;
    }

    throw new Error('type must be android or host.');
  } catch (error) {
    writeJson(response, 400, {
      ok: false,
      error: 'device_revoke_failed',
      detail: error.message
    });
  }
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

async function loadPersistentState() {
  loadSqliteState();
  await migrateLegacyIdentityState();
  await migrateLegacyGitAuditEvents();
}

function loadSqliteState() {
  const devices = relayStore.loadDevices();
  for (const device of devices) {
    state.deviceTokens.set(device.token, {
      device_id: device.device_id,
      display_name: device.display_name,
      paired_at: device.paired_at ?? new Date().toISOString(),
      last_seen_at: device.last_seen_at ?? device.paired_at ?? new Date().toISOString()
    });
  }

  const hosts = relayStore.loadHosts();
  for (const host of hosts) {
    state.hosts.set(host.host_id, {
      ...host,
      status: 'offline',
      last_seen_at: host.last_seen_at ?? new Date().toISOString()
    });
  }

  const sessions = relayStore.loadSessions();
  for (const session of sessions) {
    state.sessions.set(session.session_id, session);
  }

  cleanupExpiredApprovals();
  const approvals = relayStore.loadApprovals();
  for (const approval of approvals) {
    state.approvals.set(approval.approval_id, approval);
  }

  const timelineEvents = relayStore.loadTimelineEvents(timelineCacheLimit);
  for (const event of timelineEvents) {
    const events = state.timelineEvents.get(event.session_id) ?? [];
    events.push(event);
    events.sort((a, b) => parseCursor(a.cursor) - parseCursor(b.cursor));
    state.timelineEvents.set(event.session_id, events);
    state.nextTimelineCursor = Math.max(state.nextTimelineCursor, parseCursor(event.cursor) + 1);
  }

  state.gitAuditEvents = relayStore.loadGitAuditEvents(auditLogLimit);
  state.notificationEvents = relayStore.loadNotificationEvents(notificationLogLimit);
  for (const queueState of relayStore.loadPromptQueueStates()) {
    state.promptQueueStates.set(queueState.session_id, queueState);
  }

  for (const session of [...state.sessions.values()]) {
    const stagedSession = withDerivedSessionStage(session);
    state.sessions.set(stagedSession.session_id, stagedSession);
    relayStore.saveSession(stagedSession);
  }

  const counts = relayStore.counts();
  if (counts.devices || counts.hosts || counts.sessions || counts.timeline_events || counts.git_audit_events || counts.prompt_queue_states || counts.approvals || counts.notification_events) {
    if (counts.devices || counts.hosts) {
      console.log(`[relay] loaded ${counts.devices} device(s) and ${counts.hosts} host(s) from ${relayStore.path}`);
    }
    console.log(`[relay] loaded sqlite state from ${relayStore.path}: devices=${counts.devices}, hosts=${counts.hosts}, sessions=${counts.sessions}, timeline_events=${counts.timeline_events}, prompt_queue_states=${counts.prompt_queue_states}, approvals=${counts.approvals}, notification_events=${counts.notification_events}, git_audit_events=${counts.git_audit_events}`);
  }
}

async function migrateLegacyGitAuditEvents() {
  if (state.gitAuditEvents.length > 0) {
    return;
  }

  try {
    const content = await readFile(gitAuditLogPath, 'utf8');
    const events = content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(isGitAuditEvent);
    state.gitAuditEvents = events.slice(-auditLogLimit);
    for (const event of state.gitAuditEvents) {
      relayStore.saveGitAuditEvent(event);
    }
    relayStore.trimGitAuditEvents(auditLogLimit);
    console.log(`[relay] migrated ${state.gitAuditEvents.length} git audit event(s) from ${gitAuditLogPath} to ${relayStore.path}`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`[relay] failed to load git audit log: ${error.message}`);
    }
  }
}

function persistGitAuditEvent(event) {
  try {
    relayStore.saveGitAuditEvent(event);
    relayStore.trimGitAuditEvents(auditLogLimit);
  } catch (error) {
    console.error(`[relay] failed to persist git audit event: ${error.message}`);
  }
}

function persistApproval(approval) {
  try {
    relayStore.saveApproval(approval);
  } catch (error) {
    console.error(`[relay] failed to persist approval ${approval?.approval_id ?? ''}: ${error.message}`);
  }
}

function cleanupExpiredApprovals() {
  try {
    const removed = relayStore.cleanupExpiredApprovals({
      pendingTtlMs: approvalPendingTtlMs,
      resolvedTtlMs: approvalResolvedTtlMs
    });
    if (removed > 0) {
      for (const [approvalId, approval] of state.approvals.entries()) {
        if (isApprovalExpired(approval)) {
          state.approvals.delete(approvalId);
        }
      }
      console.log(`[relay] cleaned ${removed} expired approval(s) from ${relayStore.path}`);
    }
    return removed;
  } catch (error) {
    console.error(`[relay] failed to clean expired approvals: ${error.message}`);
    return 0;
  }
}

function startApprovalCleanupTimer() {
  if (!Number.isFinite(approvalCleanupIntervalMs) || approvalCleanupIntervalMs <= 0) {
    return;
  }
  const timer = setInterval(cleanupExpiredApprovals, approvalCleanupIntervalMs);
  timer.unref?.();
}

function startWebSocketKeepAlive() {
  if (!Number.isFinite(wsPingIntervalMs) || wsPingIntervalMs <= 0) {
    return;
  }
  const timer = setInterval(() => {
    const now = Date.now();
    for (const connection of state.connections) {
      if (connection.closed) {
        state.connections.delete(connection);
        continue;
      }
      const lastPongAt = connection.lastPongAt ?? connection.lastActivityAt ?? now;
      const lastActivityAt = connection.lastActivityAt ?? lastPongAt;
      const staleForMs = now - Math.max(lastPongAt, lastActivityAt);
      if (Number.isFinite(wsStaleTimeoutMs) && wsStaleTimeoutMs > 0 && staleForMs > wsStaleTimeoutMs) {
        console.log(`[relay] websocket stale for ${staleForMs}ms; closing ${connection.role ?? 'unknown'} ${connection.hostId ?? ''}`.trim());
        connection.terminate();
        continue;
      }
      try {
        connection.sendPing();
      } catch (error) {
        console.error(`[relay] websocket ping failed: ${error.message}`);
        connection.terminate();
      }
    }
  }, wsPingIntervalMs);
  timer.unref?.();
}

function isApprovalExpired(approval) {
  const now = Date.now();
  const status = approval?.status ?? 'pending';
  if (status === 'pending') {
    return isOlderThan(approval.requested_at ?? approval.updated_at, approvalPendingTtlMs, now);
  }
  return isOlderThan(approval.decided_at ?? approval.updated_at, approvalResolvedTtlMs, now);
}

function isOlderThan(isoTimestamp, ttlMs, nowMs) {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    return false;
  }
  const timestamp = Date.parse(isoTimestamp ?? '');
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  return timestamp < nowMs - ttlMs;
}

async function migrateLegacyIdentityState() {
  if (state.deviceTokens.size > 0 || state.hosts.size > 0) {
    return;
  }

  try {
    const snapshot = identityStore.load();
    for (const device of snapshot.devices) {
      const storedDevice = {
        device_id: device.device_id,
        display_name: device.display_name,
        paired_at: device.paired_at ?? new Date().toISOString(),
        last_seen_at: device.last_seen_at ?? device.paired_at ?? new Date().toISOString()
      };
      state.deviceTokens.set(device.token, storedDevice);
      relayStore.saveDevice(device.token, storedDevice);
    }

    for (const host of snapshot.hosts) {
      const storedHost = {
        ...host,
        status: 'offline',
        last_seen_at: host.last_seen_at ?? new Date().toISOString()
      };
      state.hosts.set(host.host_id, storedHost);
      relayStore.saveHost(storedHost);
    }

    if (snapshot.devices.length > 0 || snapshot.hosts.length > 0) {
      console.log(`[relay] migrated ${snapshot.devices.length} device(s) and ${snapshot.hosts.length} host(s) from ${identityStore.path} to ${relayStore.path}`);
    }
  } catch (error) {
    console.error(`[relay] failed to load identity store: ${error.message}`);
  }
}

function persistIdentityState() {
  try {
    const snapshot = snapshotIdentityState(state);
    for (const device of snapshot.devices) {
      relayStore.saveDevice(device.token, device);
    }
    for (const host of snapshot.hosts) {
      relayStore.saveHost(host);
    }
  } catch (error) {
    console.error(`[relay] failed to persist sqlite identity state: ${error.message}`);
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

  const trustedHostDevice = trustHostDeviceForRegister(message);
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
  if (trustedHostDevice) {
    send(connection, createMessage(MessageType.HostTrusted, trustedHostDevice));
  }
  broadcastHostSnapshot(host.host_id);
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
  broadcastHostSnapshot(host.host_id);
}

function trustHostDeviceForRegister(message) {
  const existingToken = message.auth?.host_device_token;
  if (existingToken && isAuthorizedHostDeviceToken(existingToken)) {
    return null;
  }

  const bootstrapToken = message.auth?.host_token ?? message.auth?.dev_token ?? message.auth?.token;
  if (!isAuthorizedHostToken(bootstrapToken)) {
    return null;
  }

  const now = new Date().toISOString();
  const hostDeviceId = `hostdev_${randomBytes(16).toString('base64url')}`;
  const hostDeviceToken = `cmc_hostdev_${randomBytes(32).toString('base64url')}`;
  relayStore.saveHostDevice(hostDeviceToken, {
    host_device_id: hostDeviceId,
    host_id: message.payload.host_id,
    display_name: message.payload.display_name,
    trusted_at: now,
    last_seen_at: now
  });

  return {
    host_id: message.payload.host_id,
    host_device_id: hostDeviceId,
    host_device_token: hostDeviceToken,
    trusted_at: now
  };
}

function handleSessionCreate(connection, message) {
  requirePayloadField(message, 'host_id');

  connection.role = SenderRole.Client;
  state.clients.add(connection);

  const hostConnection = state.hostConnections.get(message.payload.host_id);
  if (!hostConnection) {
    sendError(connection, `Host is offline: ${message.payload.host_id}`);
    return;
  }

  const ephemeral = message.payload.ephemeral !== false;
  const legacy = message.type === MessageType.SessionCreateEphemeral ? ' legacy=session.create_ephemeral' : '';
  console.log(`[relay] routing ${ephemeral ? 'ephemeral' : 'persistent'} session create to host ${message.payload.host_id}${legacy}`);
  if (send(hostConnection, message)) {
    sendAck(connection, message, 'accepted');
  } else {
    sendError(connection, `Host connection failed: ${message.payload.host_id}`);
  }
}

function handleApprovalRequest(connection, message) {
  requirePayloadField(message, 'approval');

  const { approval } = message.payload;
  requireApprovalField(approval, 'approval_id');
  requireApprovalField(approval, 'session_id');

  const storedApproval = {
    ...approval,
    status: approval.status ?? 'pending',
    updated_at: new Date().toISOString()
  };
  state.approvals.set(approval.approval_id, storedApproval);
  persistApproval(storedApproval);

  console.log(`[relay] approval requested: ${approval.approval_id}`);
  emitNotification({
    kind: 'approval_pending',
    session_id: approval.session_id,
    host_id: state.sessions.get(approval.session_id)?.host_id ?? null,
    title: 'Approval requested',
    summary: approval.summary || approval.title,
    payload: { approval_id: approval.approval_id }
  });
  broadcastToClients(createMessage(MessageType.ApprovalRequest, {
    approval: state.approvals.get(approval.approval_id)
  }));
  refreshSessionStage(approval.session_id);
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

  console.log(`[relay] routing approval decision to host ${session.host_id}: ${approval.approval_id}`);
  if (send(hostConnection, message)) {
    const resolvedApproval = {
      ...approval,
      status: message.payload.decision,
      decided_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    state.approvals.set(approval.approval_id, resolvedApproval);
    persistApproval(resolvedApproval);
    sendAck(connection, message, 'accepted');
    broadcastToClients(createMessage(MessageType.ApprovalRequest, { approval: resolvedApproval }));
    refreshSessionStage(approval.session_id);
  } else {
    sendError(connection, `Host connection failed: ${session.host_id}`);
  }
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
  if (send(hostConnection, {
    ...message,
    payload: {
      ...message.payload,
      audit_id: auditId
    }
  })) {
    sendAck(connection, message, 'accepted');
  } else {
    sendError(connection, `Host connection failed: ${session.host_id}`);
  }
}

function handleGitSnapshot(connection, message) {
  requirePayloadField(message, 'snapshot');

  const snapshot = message.payload.snapshot;
  state.gitSnapshots.set(snapshot.session_id, snapshot);
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
  refreshSessionStage(snapshot.session_id);
}

function handlePowerStatus(connection, message) {
  requirePayloadField(message, 'host_id');
  connection.role = SenderRole.Host;
  connection.hostId = message.payload.host_id;

  const host = state.hosts.get(message.payload.host_id);
  if (host) {
    host.power_status = message.payload.status ?? message.payload;
    host.last_seen_at = new Date().toISOString();
    state.hosts.set(host.host_id, host);
    relayStore.saveHost(host);
  }

  broadcastToClients(createMessage(MessageType.PowerStatus, {
    ...message.payload,
    trusted_devices: relayStore.listPowerTrusts()
      .filter((trust) => trust.host_id === message.payload.host_id)
      .map((trust) => ({
        device_id: trust.device_id,
        capabilities: trust.capabilities,
        expires_at: trust.expires_at
      }))
  }));
  if (message.payload.host_id) {
    broadcastHostSnapshot(message.payload.host_id);
  }
}

function handlePowerTrustRequest(connection, message) {
  requirePayloadField(message, 'host_id');
  const device = deviceInfoForMessage(message);
  const hostConnection = state.hostConnections.get(message.payload.host_id);
  connection.role = SenderRole.Client;
  state.clients.add(connection);

  if (!hostConnection) {
    sendError(connection, `Host is offline: ${message.payload.host_id}`);
    return;
  }

  appendPowerAuditEvent({
    audit_id: randomUUID(),
    phase: 'trust_requested',
    host_id: message.payload.host_id,
    device_id: device.device_id,
    action: 'power.trust',
    device,
    requested_at: new Date().toISOString()
  });
  if (send(hostConnection, withPowerDevice(message, device))) {
    sendAck(connection, message, 'accepted');
  } else {
    sendError(connection, `Host connection failed: ${message.payload.host_id}`);
  }
}

function handlePowerTrustChallenge(connection, message) {
  requirePayloadField(message, 'host_id');
  requirePayloadField(message, 'challenge_id');
  connection.role = SenderRole.Host;
  connection.hostId = message.payload.host_id;
  broadcastToClients(createMessage(MessageType.PowerTrustChallenge, message.payload));
}

function handlePowerTrustVerify(connection, message) {
  requirePayloadField(message, 'host_id');
  requirePayloadField(message, 'challenge_id');
  requirePayloadField(message, 'code');
  const device = deviceInfoForMessage(message);
  const hostConnection = state.hostConnections.get(message.payload.host_id);
  connection.role = SenderRole.Client;
  state.clients.add(connection);

  if (!hostConnection) {
    sendError(connection, `Host is offline: ${message.payload.host_id}`);
    return;
  }

  if (send(hostConnection, withPowerDevice(message, device))) {
    sendAck(connection, message, 'accepted');
  } else {
    sendError(connection, `Host connection failed: ${message.payload.host_id}`);
  }
}

function handlePowerTrustGranted(connection, message) {
  requirePayloadField(message, 'host_id');
  requirePayloadField(message, 'device_id');
  const now = new Date().toISOString();
  const capabilities = Array.isArray(message.payload.capabilities)
    ? message.payload.capabilities
    : ['power.keep_awake', 'power.lock'];
  const trust = {
    trust_id: message.payload.trust_id ?? randomUUID(),
    host_id: message.payload.host_id,
    device_id: message.payload.device_id,
    device_display_name: message.payload.device_display_name ?? '',
    capabilities,
    granted_at: message.payload.granted_at ?? now,
    expires_at: message.payload.expires_at ?? null
  };
  relayStore.savePowerTrust(trust);
  appendPowerAuditEvent({
    audit_id: message.payload.audit_id ?? randomUUID(),
    phase: 'trust_granted',
    host_id: trust.host_id,
    device_id: trust.device_id,
    action: 'power.trust',
    device: {
      device_id: trust.device_id,
      display_name: trust.device_display_name
    },
    expires_at: trust.expires_at,
    completed_at: now
  });
  broadcastToClients(createMessage(MessageType.PowerTrustGranted, { trust }));
  broadcastHostSnapshot(trust.host_id);
}

function handlePowerRequest(connection, message) {
  requirePayloadField(message, 'host_id');
  requirePayloadField(message, 'action');
  const device = deviceInfoForMessage(message);
  const hostConnection = state.hostConnections.get(message.payload.host_id);
  connection.role = SenderRole.Client;
  state.clients.add(connection);

  if (!hostConnection) {
    sendError(connection, `Host is offline: ${message.payload.host_id}`);
    return;
  }

  const capability = capabilityForPowerAction(message.payload.action);
  const trust = relayStore.findPowerTrust(message.payload.host_id, device.device_id);
  if (!trust || !trust.capabilities.includes(capability)) {
    appendPowerAuditEvent({
      audit_id: randomUUID(),
      phase: 'rejected',
      host_id: message.payload.host_id,
      device_id: device.device_id,
      action: message.payload.action,
      device,
      reason: 'missing_power_control_trust',
      requested_at: new Date().toISOString()
    });
    sendError(connection, `Power control is not trusted for ${device.device_id} on ${message.payload.host_id}.`);
    return;
  }

  const auditId = randomUUID();
  appendPowerAuditEvent({
    audit_id: auditId,
    phase: 'requested',
    host_id: message.payload.host_id,
    device_id: device.device_id,
    action: message.payload.action,
    duration_seconds: message.payload.duration_seconds ?? null,
    device,
    requested_at: new Date().toISOString()
  });
  if (send(hostConnection, {
    ...withPowerDevice(message, device),
    payload: {
      ...message.payload,
      audit_id: auditId
    }
  })) {
    sendAck(connection, message, 'accepted');
  } else {
    sendError(connection, `Host connection failed: ${message.payload.host_id}`);
  }
}

function handlePowerResult(connection, message) {
  requirePayloadField(message, 'host_id');
  requirePayloadField(message, 'action');
  appendPowerAuditEvent({
    audit_id: message.payload.audit_id ?? randomUUID(),
    phase: 'completed',
    host_id: message.payload.host_id,
    device_id: message.payload.device_id ?? 'unknown',
    action: message.payload.action,
    result_status: message.payload.status ?? '',
    result_reason: message.payload.reason ?? '',
    expires_at: message.payload.expires_at ?? null,
    completed_at: new Date().toISOString()
  });
  broadcastToClients(createMessage(MessageType.PowerResult, message.payload));
}

function handleSessionSnapshot(connection, message) {
  requirePayloadField(message, 'session');

  const session = withDerivedSessionStage(message.payload.session);
  state.sessions.set(session.session_id, session);
  relayStore.saveSession(session);

  console.log(`[relay] session snapshot: ${session.session_id}`);
  broadcastToClients(createMessage(MessageType.SessionSnapshot, { session }));
  emitNotificationForSessionStage(session);
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
    for (const host of state.hosts.values()) {
      send(connection, createMessage(MessageType.HostSnapshot, createHostSnapshotPayload(host.host_id)));
    }
    for (const session of state.sessions.values()) {
      send(connection, createMessage(MessageType.SessionSnapshot, { session }));
      sendPromptQueueStateReplay(connection, session.session_id);
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
    sendPromptQueueStateReplay(connection, sessionId);
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

function sendPromptQueueStateReplay(connection, sessionId) {
  const queueState = state.promptQueueStates.get(sessionId);
  if (!queueState || queueState.depth <= 0) {
    return;
  }

  send(connection, createMessage(MessageType.TimelineEvent, {
    event: {
      event_id: `${sessionId}:prompt_queue_state:${queueState.updated_at}`,
      session_id: sessionId,
      created_at: queueState.updated_at,
      type: 'prompt_queued',
      title: 'Prompt queue restored',
      summary: `Queued prompt ${queueState.depth}/${queueState.max_depth}.`,
      cursor: null,
      payload: {
        queue_depth: queueState.depth,
        max_queue_depth: queueState.max_depth,
        active_turn_id: queueState.active_turn_id ?? null,
        replayed_from_state: true
      },
      redaction_level: 'metadata'
    }
  }));
}

function handleSessionPrompt(connection, message) {
  requirePayloadField(message, 'session_id');
  const validationError = validatePromptDraftPayload(message.payload);
  if (validationError) {
    sendError(connection, validationError);
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
  if (send(hostConnection, message)) {
    sendAck(connection, message, 'accepted');
  } else {
    sendError(connection, `Host connection failed: ${session.host_id}`);
  }
}

function handleSessionPromptQueue(connection, message) {
  requirePayloadField(message, 'session_id');
  requirePayloadField(message, 'text');
  if (typeof message.payload.text !== 'string' || message.payload.text.trim().length === 0) {
    sendError(connection, 'Queued prompt cannot be empty.');
    return;
  }
  if (message.payload.text.length > maxPromptLength) {
    sendError(connection, `Queued prompt is too long. Maximum is ${maxPromptLength} characters.`);
    return;
  }

  routeSessionControlMessage(connection, message, 'queued prompt');
}

function handleSessionPromptEdit(connection, message) {
  requirePayloadField(message, 'session_id');
  requirePayloadField(message, 'base_event_id');
  const validationError = validatePromptDraftPayload(message.payload);
  if (validationError) {
    sendError(connection, validationError);
    return;
  }

  routeSessionControlMessage(connection, message, 'prompt edit');
}

function handleSessionTurnInterrupt(connection, message) {
  requirePayloadField(message, 'session_id');
  routeSessionControlMessage(connection, message, 'turn interrupt');
}

function routeSessionControlMessage(connection, message, label) {
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

  console.log(`[relay] routing ${label} to host ${session.host_id}: ${message.payload.session_id}`);
  if (send(hostConnection, message)) {
    sendAck(connection, message, 'accepted');
  } else {
    sendError(connection, `Host connection failed: ${session.host_id}`);
  }
}

function validatePromptDraftPayload(payload) {
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (text.length > maxPromptLength) {
    return `Prompt is too long. Maximum is ${maxPromptLength} characters.`;
  }

  const input = Array.isArray(payload.input) ? payload.input : [];
  const textParts = input.filter((item) => item?.type === 'text');
  const imageParts = input.filter((item) => item?.type === 'image');
  const hasText = text.trim().length > 0 || textParts.some((item) => typeof item.text === 'string' && item.text.trim().length > 0);
  const hasImage = imageParts.length > 0;

  if (!hasText && !hasImage) {
    return 'Prompt cannot be empty.';
  }

  for (const item of textParts) {
    if (typeof item.text !== 'string') {
      return 'Prompt text input must be a string.';
    }
    if (item.text.length > maxPromptLength) {
      return `Prompt text input is too long. Maximum is ${maxPromptLength} characters.`;
    }
  }

  if (imageParts.length > maxPromptImages) {
    return `Too many prompt images. Maximum is ${maxPromptImages}.`;
  }

  for (const item of imageParts) {
    const dataUrl = item.data_url;
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      return 'Prompt image input must include a data:image data_url.';
    }
    if (Buffer.byteLength(dataUrl, 'utf8') > maxPromptImageDataUrlBytes) {
      return `Prompt image is too large. Maximum data URL size is ${maxPromptImageDataUrlBytes} bytes.`;
    }
  }

  const options = payload.options && typeof payload.options === 'object' ? payload.options : {};
  const allowedReasoning = new Set(['auto', 'low', 'medium', 'high', 'xhigh']);
  if (options.reasoning_effort && !allowedReasoning.has(options.reasoning_effort)) {
    return 'Unsupported reasoning effort.';
  }

  if (options.goal && typeof options.goal === 'object') {
    const objective = typeof options.goal.objective === 'string' ? options.goal.objective.trim() : '';
    if (objective.length === 0) {
      return 'Goal objective cannot be empty.';
    }
    if (objective.length > maxPromptLength) {
      return `Goal objective is too long. Maximum is ${maxPromptLength} characters.`;
    }
  }

  return null;
}

function handleSessionTimelineRequest(connection, message) {
  requirePayloadField(message, 'session_id');

  connection.role = SenderRole.Client;
  state.clients.add(connection);

  const session = state.sessions.get(message.payload.session_id);
  if (!session) {
    if (message.payload.cache_only === true || message.payload.page === true) {
      send(connection, createMessage(MessageType.TimelinePage, {
        session_id: message.payload.session_id,
        events: [],
        before_cursor: message.payload.before_cursor ?? null,
        after_cursor: message.payload.after_cursor ?? null,
        oldest_cursor: null,
        newest_cursor: null,
        has_more_before: false,
        has_more_after: false,
        source: 'cache'
      }));
      return;
    }

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
    console.log(`[relay] timeline request satisfied from cache; host offline: ${session.host_id}`);
    return;
  }

  console.log(`[relay] routing timeline request to host ${session.host_id}: ${message.payload.session_id}`);
  if (send(hostConnection, message)) {
    sendAck(connection, message, 'accepted');
  } else {
    sendError(connection, `Host connection failed: ${session.host_id}`);
  }
}

function handleSessionSyncIndex(connection, message) {
  const device = deviceInfoForMessage(message);
  if (device.device_id === 'unknown') {
    sendError(connection, 'Device token is required for session sync index.');
    return;
  }

  connection.role = SenderRole.Client;
  state.clients.add(connection);

  const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
  const result = relayStore.loadSessionSyncEntries({
    deviceId: device.device_id,
    limit: payload.limit,
    cursor: payload.cursor,
    includeArchived: payload.include_archived === true,
    includeClean: payload.include_clean === true,
    selectedSessionId: payload.selected_session_id,
    sessionIds: Array.isArray(payload.session_ids) ? payload.session_ids : []
  });
  const sessions = result.entries.map((entry) => {
    const dirtyReasons = syncDirtyReasons(entry);
    return {
      session: entry.session,
      snapshot_revision: entry.snapshot_revision,
      stage_revision: entry.stage_revision,
      sync_revision: entry.sync_revision,
      timeline_newest_cursor: entry.timeline_newest_cursor,
      timeline_oldest_cursor: entry.timeline_oldest_cursor,
      last_event_at: entry.last_event_at,
      sync_updated_at: entry.sync_updated_at,
      device_seen: entry.device_seen,
      dirty: dirtyReasons.length > 0,
      dirty_reasons: dirtyReasons,
      recommended_action: recommendedSyncAction(entry, dirtyReasons)
    };
  });

  send(connection, createMessage(MessageType.SessionSyncIndexResult, {
    server_sync_revision: String(Math.max(0, ...sessions.map((entry) => Number.parseInt(entry.sync_revision ?? '0', 10) || 0))),
    sessions,
    unchanged_count: result.unchanged_count,
    has_more: result.has_more,
    next_cursor: result.next_cursor
  }));
}

function handleSessionSyncAck(connection, message) {
  const device = deviceInfoForMessage(message);
  if (device.device_id === 'unknown') {
    sendError(connection, 'Device token is required for session sync ack.');
    return;
  }

  const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
  const sessions = Array.isArray(payload.sessions)
    ? payload.sessions
    : payload.session_id
      ? [payload]
      : [];
  if (sessions.length === 0) {
    sendError(connection, 'session.sync.ack requires payload.sessions.');
    return;
  }

  for (const ack of sessions) {
    relayStore.saveDeviceSessionSync(device.device_id, ack);
  }
  sendAck(connection, message, 'accepted');
}

function handleSessionArchiveUpdate(connection, message) {
  updateDeviceSessionUiStateFromMessage(connection, message, 'archived');
}

function handleSessionPinUpdate(connection, message) {
  updateDeviceSessionUiStateFromMessage(connection, message, 'pinned');
}

function updateDeviceSessionUiStateFromMessage(connection, message, field) {
  requirePayloadField(message, 'session_id');
  requirePayloadField(message, field);

  const device = deviceInfoForMessage(message);
  if (device.device_id === 'unknown') {
    sendError(connection, 'Device token is required for session UI state updates.');
    return;
  }

  connection.role = SenderRole.Client;
  state.clients.add(connection);

  const sessionId = message.payload.session_id;
  if (!state.sessions.has(sessionId)) {
    sendError(connection, `Unknown session: ${sessionId}`);
    return;
  }

  if (field === 'archived') {
    relayStore.updateDeviceSessionArchive(device.device_id, sessionId, message.payload.archived === true);
  } else {
    relayStore.updateDeviceSessionPin(device.device_id, sessionId, message.payload.pinned === true);
  }
  sendAck(connection, message, 'accepted');
}

function syncDirtyReasons(entry) {
  const reasons = [];
  const seen = entry.device_seen ?? {};
  if (!seen.seen_at) {
    reasons.push('missing_local');
  }
  if ((entry.snapshot_revision ?? 0) > (seen.seen_snapshot_revision ?? 0)) {
    reasons.push('snapshot');
  }
  if ((entry.stage_revision ?? 0) > (seen.seen_stage_revision ?? 0)) {
    reasons.push('stage');
  }
  if ((entry.timeline_newest_cursor ?? 0) > (seen.seen_timeline_cursor ?? 0)) {
    reasons.push('timeline');
  }
  if ((entry.timeline_oldest_cursor ?? 0) > 0
    && (seen.seen_timeline_cursor ?? 0) > 0
    && (seen.seen_timeline_cursor ?? 0) < (entry.timeline_oldest_cursor ?? 0)) {
    reasons.push('cursor_gap');
  }
  return [...new Set(reasons)];
}

function recommendedSyncAction(entry, dirtyReasons) {
  if (dirtyReasons.includes('cursor_gap')) {
    return 'resync_from_host';
  }
  if (dirtyReasons.includes('timeline') || dirtyReasons.includes('missing_local')) {
    return 'timeline_page';
  }
  if (dirtyReasons.includes('snapshot') || dirtyReasons.includes('stage')) {
    return 'snapshot_only';
  }
  return 'none';
}

function handleTimelineEvent(connection, message) {
  requirePayloadField(message, 'event');
  const event = cacheTimelineEvent(message.payload.event);
  maybeResolveApprovalFromTimelineEvent(event);
  console.log(`[relay] timeline event: ${event.title}`);
  broadcastToClients(createMessage(MessageType.TimelineEvent, { event }));
  refreshSessionStage(event.session_id);
}

function handleTimelinePage(connection, message) {
  requirePayloadField(message, 'session_id');
  const events = Array.isArray(message.payload.events) ? message.payload.events : [];
  const cachedEvents = events.map((event) => {
    const cachedEvent = cacheTimelineEvent(event);
    maybeResolveApprovalFromTimelineEvent(cachedEvent);
    return cachedEvent;
  });
  console.log(`[relay] timeline page: ${message.payload.session_id} ${cachedEvents.length} event(s)`);
  broadcastToClients(createMessage(MessageType.TimelinePage, {
    ...message.payload,
    events: cachedEvents,
    source: message.payload.source ?? 'host'
  }));
  refreshSessionStage(message.payload.session_id);
}

function maybeResolveApprovalFromTimelineEvent(event) {
  if (event.type !== 'approval_resolved') {
    return;
  }

  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const approvalId = payload.approval_id;
  if (!approvalId || !state.approvals.has(approvalId)) {
    return;
  }

  const approval = state.approvals.get(approvalId);
  if (approval.status && approval.status !== 'pending') {
    return;
  }

  const resolvedApproval = {
    ...approval,
    status: payload.decision ?? 'resolved',
    decided_at: event.created_at ?? new Date().toISOString(),
    updated_at: event.created_at ?? new Date().toISOString()
  };
  state.approvals.set(approvalId, resolvedApproval);
  persistApproval(resolvedApproval);
  broadcastToClients(createMessage(MessageType.ApprovalRequest, { approval: resolvedApproval }));
}

function handleClose(connection) {
  state.connections.delete(connection);
  state.clients.delete(connection);
  state.subscriptions.delete(connection);

  if (connection.hostId) {
    const host = state.hosts.get(connection.hostId);
    if (host) {
      host.status = 'offline';
      host.last_seen_at = new Date().toISOString();
    }

    emitHostOfflineNotifications(connection.hostId);
    state.hostConnections.delete(connection.hostId);
    persistIdentityState();
    broadcastHostSnapshot(connection.hostId);
    console.log(`[relay] host disconnected: ${connection.hostId}`);
  }
}

function broadcastHostSnapshot(hostId) {
  const host = state.hosts.get(hostId);
  if (!host) {
    return;
  }
  broadcastToClients(createMessage(MessageType.HostSnapshot, createHostSnapshotPayload(hostId)));
}

function createHostSnapshotPayload(hostId) {
  const host = state.hosts.get(hostId);
  const sessionCount = [...state.sessions.values()].filter((session) => session.host_id === hostId).length;
  return {
    host: {
      ...host,
      status: state.hostConnections.has(hostId) ? 'online' : (host?.status ?? 'offline')
    },
    session_count: sessionCount
  };
}

function broadcastToClients(message) {
  for (const client of state.clients) {
    const eventSessionId = message.payload?.event?.session_id;
    const snapshotSessionId = message.payload?.session?.session_id;
    const gitSessionId = message.payload?.snapshot?.session_id;
    const pageSessionId = message.payload?.session_id;
    const notificationSessionId = message.payload?.notification?.session_id;
    const notificationHostId = message.payload?.notification?.host_id;
    const hostId = message.payload?.host?.host_id;
    const sessionId = eventSessionId ?? snapshotSessionId ?? gitSessionId ?? pageSessionId ?? notificationSessionId;
    const effectiveHostId = hostId ?? notificationHostId;
    const subscriptions = state.subscriptions.get(client);

    if (effectiveHostId && subscriptions?.has('*')) {
      send(client, message);
      continue;
    }

    if (!sessionId || !subscriptions || subscriptions.has('*') || subscriptions.has(sessionId)) {
      send(client, message);
    }
  }
}

function cacheTimelineEvent(event) {
  const incomingCursor = parseCursor(event.cursor);
  const cursor = incomingCursor > 0 ? incomingCursor : state.nextTimelineCursor;
  state.nextTimelineCursor = Math.max(state.nextTimelineCursor, cursor + 1);

  const cachedEvent = {
    ...event,
    cursor: String(cursor),
    cached_at: new Date().toISOString()
  };

  const events = (state.timelineEvents.get(cachedEvent.session_id) ?? [])
    .filter((item) => item.event_id !== cachedEvent.event_id);
  events.push(cachedEvent);
  events.sort((a, b) => parseCursor(a.cursor) - parseCursor(b.cursor));

  while (events.length > timelineCacheLimit) {
    events.shift();
  }

  state.timelineEvents.set(cachedEvent.session_id, events);
  relayStore.saveTimelineEvent(cachedEvent);
  relayStore.trimTimelineEvents(timelineCacheLimit);
  updatePromptQueueStateFromTimelineEvent(cachedEvent);
  return cachedEvent;
}

function updatePromptQueueStateFromTimelineEvent(event) {
  if (event.type !== 'prompt_queued' && event.type !== 'prompt_queue_started') {
    return;
  }

  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const depth = Number.parseInt(payload.queue_depth ?? extractQueueDepth(event.summary), 10);
  const maxDepth = Number.parseInt(payload.max_queue_depth ?? extractMaxQueueDepth(event.summary), 10);
  const session = state.sessions.get(event.session_id);
  const queueState = {
    session_id: event.session_id,
    host_id: session?.host_id ?? payload.host_id ?? null,
    depth: Number.isFinite(depth) && depth > 0 ? depth : 0,
    max_depth: Number.isFinite(maxDepth) && maxDepth > 0 ? maxDepth : 5,
    active_turn_id: payload.active_turn_id ?? null,
    updated_at: event.created_at ?? new Date().toISOString(),
    latest_event_id: event.event_id
  };

  if (queueState.depth <= 0) {
    state.promptQueueStates.delete(event.session_id);
    relayStore.deletePromptQueueState(event.session_id);
    return;
  }

  state.promptQueueStates.set(event.session_id, queueState);
  relayStore.savePromptQueueState(queueState);
}

function extractQueueDepth(summary) {
  if (typeof summary !== 'string') {
    return 0;
  }
  const queued = summary.match(/(?:Queued prompt|Started queued prompt\.)\s+(\d+)\//);
  return queued ? Number.parseInt(queued[1], 10) : 0;
}

function extractMaxQueueDepth(summary) {
  if (typeof summary !== 'string') {
    return 5;
  }
  const queued = summary.match(/\/(\d+)/);
  return queued ? Number.parseInt(queued[1], 10) : 5;
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
  refreshSessionStage(auditEvent.session_id);
}

function appendPowerAuditEvent(event) {
  const auditEvent = {
    event_id: randomUUID(),
    created_at: new Date().toISOString(),
    ...event
  };

  relayStore.savePowerAuditEvent(auditEvent);
  relayStore.trimPowerAuditEvents(auditLogLimit);
}

function withPowerDevice(message, device) {
  return {
    ...message,
    payload: {
      ...message.payload,
      device_id: device.device_id,
      device_display_name: device.display_name
    }
  };
}

function capabilityForPowerAction(action) {
  if (action === 'lock') {
    return 'power.lock';
  }
  if (action === 'keep_awake') {
    return 'power.keep_awake';
  }
  return `power.${action}`;
}

function refreshSessionStage(sessionId) {
  const session = state.sessions.get(sessionId);
  if (!session) {
    return;
  }

  const stagedSession = withDerivedSessionStage(session);
  state.sessions.set(sessionId, stagedSession);
  relayStore.saveSession(stagedSession);
  broadcastToClients(createMessage(MessageType.SessionSnapshot, { session: stagedSession }));
  emitNotificationForSessionStage(stagedSession);
}

function emitNotificationForSessionStage(session) {
  if (!session?.stage) {
    return;
  }

  if (session.stage.type === 'needs_user' || session.stage.type === 'waiting_for_input') {
    emitNotification({
      kind: 'needs_input',
      session_id: session.session_id,
      host_id: session.host_id,
      title: session.stage.label,
      summary: session.stage.summary,
      payload: { stage_type: session.stage.type }
    });
  }
  if (session.stage.type === 'completed') {
    emitNotification({
      kind: 'session_completed',
      session_id: session.session_id,
      host_id: session.host_id,
      title: session.stage.label,
      summary: session.stage.summary,
      payload: { stage_type: session.stage.type }
    });
  }
}

function emitHostOfflineNotifications(hostId) {
  for (const session of state.sessions.values()) {
    if (session.host_id !== hostId) {
      continue;
    }
    emitNotification({
      kind: 'host_offline',
      session_id: session.session_id,
      host_id: hostId,
      title: 'Host offline',
      summary: `${session.project_name || session.session_id} is offline.`,
      payload: { session_id: session.session_id, host_id: hostId }
    });
  }
}

function emitNotification(notification) {
  if (!notification?.kind) {
    return;
  }

  const dedupeKey = [
    notification.kind,
    notification.session_id ?? '',
    notification.host_id ?? '',
    notification.payload?.approval_id ?? '',
    notification.payload?.stage_type ?? '',
    notification.payload?.action ?? ''
  ].join(':');

  if (state.notificationEvents.some((event) => event.dedupe_key === dedupeKey)) {
    return;
  }

  const event = {
    notification_id: randomUUID(),
    dedupe_key: dedupeKey,
    kind: notification.kind,
    session_id: notification.session_id ?? null,
    host_id: notification.host_id ?? null,
    created_at: new Date().toISOString(),
    title: notification.title,
    summary: notification.summary,
    payload: notification.payload ?? {}
  };
  state.notificationEvents.push(event);
  while (state.notificationEvents.length > notificationLogLimit) {
    state.notificationEvents.shift();
  }
  relayStore.saveNotificationEvent(event);
  relayStore.trimNotificationEvents(notificationLogLimit);
  broadcastToClients(createMessage(MessageType.NotificationEvent, { notification: event }));
}

function withDerivedSessionStage(session) {
  return {
    ...session,
    stage: deriveSessionStage(
      session,
      state.timelineEvents.get(session.session_id) ?? [],
      [...state.approvals.values()],
      [...state.gitSnapshots.values()]
    )
  };
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
      has_more_after: hasMoreAfter,
      source: 'cache'
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
    return connection.sendText(encodeMessage(message)) === true;
  } catch (error) {
    console.error('[relay] failed to send websocket message', error.message);
    handleClose(connection);
    return false;
  }
}

function sendError(connection, detail) {
  send(connection, createMessage(MessageType.Error, { detail }));
}

function sendAck(connection, originalMessage, status = 'accepted') {
  if (!originalMessage?.id || !isAckableClientMessage(originalMessage.type)) {
    return;
  }

  rememberProcessedMessage(originalMessage);
  send(connection, createMessage(MessageType.Ack, {
    message_id: originalMessage.id,
    message_type: originalMessage.type,
    status
  }));
}
