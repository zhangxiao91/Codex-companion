import {
  DEFAULT_RELAY_URL,
  MessageType,
  createMessage,
  decodeMessage,
  encodeMessage
} from '../../packages/protocol/index.mjs';
import { createCodexAdapter } from './codex-adapter.mjs';
import { handleGitRequest } from './git-adapter.mjs';
import { createHostIdentityStore } from './host-identity-store.mjs';
import { createPowerController } from './power-controller.mjs';

const relayUrl = process.env.RELAY_URL ?? DEFAULT_RELAY_URL;
const hostIdentityStore = createHostIdentityStore();
const storedHostIdentity = hostIdentityStore.load();
const hostToken = process.env.RELAY_HOST_TOKEN
  ?? process.env.RELAY_DEV_TOKEN
  ?? process.env.DEV_TOKEN
  ?? '';
let hostDeviceToken = process.env.RELAY_HOST_DEVICE_TOKEN
  ?? (hostToken ? '' : storedHostIdentity.host_device_token)
  ?? '';
const hostId = process.env.HOST_ID ?? 'local-dev-host';
const displayName = process.env.HOST_NAME ?? 'Local Development Host';
const bridgeVersion = '0.0.1';
const powerController = createPowerController(hostId, displayName);
let socket;
let heartbeatTimer;
let reconnectTimer;
let reconnectAttempt = 0;
const adapter = createCodexAdapter(hostId, {
  onTimelineEvent: (event) => {
    send(MessageType.TimelineEvent, { event });
  },
  onApprovalRequest: (approval) => {
    send(MessageType.ApprovalRequest, { approval });
  }
});

connectRelay();

function connectRelay() {
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
    return;
  }

  const nextSocket = new WebSocket(relayUrl);
  socket = nextSocket;

  nextSocket.addEventListener('open', () => handleOpen(nextSocket));
  nextSocket.addEventListener('message', (event) => handleMessage(nextSocket, event));
  nextSocket.addEventListener('close', (event) => handleClose(nextSocket, event));
  nextSocket.addEventListener('error', (event) => handleError(nextSocket, event));
}

async function handleOpen(currentSocket) {
  if (currentSocket !== socket) {
    currentSocket.close(1000, 'stale connection');
    return;
  }

  reconnectAttempt = 0;
  clearReconnectTimer();
  console.log(`[bridge] connected to ${relayUrl}`);

  if (typeof adapter.start === 'function') {
    await adapter.start();
  }

  send(MessageType.HostRegister, {
    host_id: hostId,
    display_name: displayName,
    kind: 'local_pc',
    bridge_version: bridgeVersion,
    capabilities: ['session.list', 'session.prompt', 'session.prompt.queue', 'session.prompt.edit', 'session.turn.interrupt', 'timeline.event', 'git.status', 'git.diff', ...powerController.capabilities()]
  });

  console.log('[bridge] registered host capabilities: session.list, session.prompt, timeline.event, git.status, git.diff');
  console.log(`[bridge] host policy: ${powerController.policyPath}`);
  send(MessageType.PowerStatus, powerController.status());

  for (const session of adapter.listSessions()) {
    send(MessageType.SessionSnapshot, { session });
  }

  if (typeof adapter.listApprovals === 'function') {
    for (const approval of adapter.listApprovals()) {
      send(MessageType.ApprovalRequest, { approval });
    }
  }

  startHeartbeat();
}

async function handleMessage(currentSocket, event) {
  if (currentSocket !== socket) {
    return;
  }

  let message;
  try {
    message = decodeMessage(event.data);

    if (message.type === MessageType.SessionPrompt) {
      const { session_id: sessionId } = message.payload;
      console.log(`[bridge] received prompt for ${sessionId}`);
      const response = await adapter.sendPrompt(sessionId, message.payload);
      sendMessage(withAuth(response));
      return;
    }

    if (message.type === MessageType.SessionPromptQueue) {
      const { session_id: sessionId } = message.payload;
      console.log(`[bridge] received queued prompt for ${sessionId}`);
      const response = await adapter.queuePrompt(sessionId, message.payload);
      sendMessage(withAuth(response));
      return;
    }

    if (message.type === MessageType.SessionPromptEdit) {
      const { session_id: sessionId } = message.payload;
      console.log(`[bridge] received prompt edit for ${sessionId}`);
      const response = await adapter.editPrompt(sessionId, message.payload);
      sendMessage(withAuth(response));
      return;
    }

    if (message.type === MessageType.SessionTurnInterrupt) {
      const { session_id: sessionId } = message.payload;
      console.log(`[bridge] received turn interrupt for ${sessionId}`);
      const response = await adapter.interruptTurn(sessionId, message.payload);
      sendMessage(withAuth(response));
      return;
    }

    if (message.type === MessageType.HostTrusted) {
      const token = message.payload.host_device_token;
      if (typeof token === 'string' && token) {
        hostDeviceToken = token;
        hostIdentityStore.save({
          host_id: message.payload.host_id ?? hostId,
          host_device_id: message.payload.host_device_id ?? '',
          host_device_token: token,
          relay_url: relayUrl,
          display_name: displayName
        });
        console.log(`[bridge] saved host device trust at ${hostIdentityStore.path}`);
      }
      return;
    }

    if (message.type === MessageType.SessionTimelineRequest) {
      const { session_id: sessionId } = message.payload;
      console.log(`[bridge] received timeline request for ${sessionId}`);

      if (typeof adapter.readTimeline !== 'function') {
        sendTimelineErrorPage(message, 'Host adapter does not support timeline reads.');
        return;
      }

      try {
        const responses = await adapter.readTimeline(sessionId, {
          afterCursor: message.payload.after_cursor,
          beforeCursor: message.payload.before_cursor,
          limit: message.payload.limit,
          page: message.payload.page === true
        });
        for (const response of responses) {
          sendMessage(withAuth(response));
        }
      } catch (error) {
        console.error(`[bridge] timeline request failed for ${sessionId}: ${error.message}`);
        sendTimelineErrorPage(message, error.message);
      }
      return;
    }

    if (message.type === MessageType.ApprovalDecision) {
      if (typeof adapter.resolveApproval !== 'function') {
        return;
      }

      console.log(`[bridge] received approval decision for ${message.payload.approval_id}: ${message.payload.decision}`);
      const response = await adapter.resolveApproval(message.payload);
      sendMessage(withAuth(response));
      return;
    }

    if (message.type === MessageType.GitRequest) {
      let session = adapter.listSessions().find((item) => item.session_id === message.payload.session_id);
      if (!session && typeof adapter.findSession === 'function') {
        session = await adapter.findSession(message.payload.session_id);
      }
      if (!session) {
        throw new Error(`Unknown session for git request: ${message.payload.session_id}`);
      }

      console.log(`[bridge] received git ${message.payload.action} for ${message.payload.session_id}`);
      const snapshot = await handleGitRequest(session, message.payload);
      send(MessageType.GitSnapshot, { snapshot });
      return;
    }

    if (message.type === MessageType.PowerTrustRequest) {
      const challenge = powerController.createTrustChallenge(
        message.payload.device_id ?? '',
        message.payload.device_display_name ?? ''
      );
      send(MessageType.PowerTrustChallenge, challenge);
      return;
    }

    if (message.type === MessageType.PowerTrustVerify) {
      const result = powerController.verifyTrustChallenge(
        message.payload.challenge_id,
        message.payload.code,
        message.payload.device_id ?? '',
        message.payload.device_display_name ?? ''
      );
      if (result.ok) {
        send(MessageType.PowerTrustGranted, result.trust);
      } else {
        send(MessageType.PowerResult, {
          host_id: hostId,
          device_id: message.payload.device_id ?? '',
          action: 'power.trust',
          status: 'rejected',
          reason: result.reason
        });
      }
      return;
    }

    if (message.type === MessageType.PowerRequest) {
      const result = await powerController.handlePowerRequest(message.payload);
      send(MessageType.PowerResult, {
        host_id: hostId,
        device_id: message.payload.device_id ?? '',
        action: message.payload.action,
        audit_id: message.payload.audit_id,
        ...result
      });
      send(MessageType.PowerStatus, powerController.status());
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
    if (message && isPowerMessage(message.type)) {
      send(MessageType.PowerResult, {
        host_id: hostId,
        device_id: message.payload?.device_id ?? '',
        action: message.payload?.action ?? message.type,
        status: 'rejected',
        reason: error.message
      });
    }
  }
}

function handleClose(currentSocket, event) {
  if (currentSocket !== socket) {
    return;
  }

  stopHeartbeat();
  socket = undefined;
  const reason = event.reason ? ` reason=${event.reason}` : '';
  console.log(`[bridge] disconnected from relay code=${event.code} was_clean=${event.wasClean}${reason}`);
  scheduleReconnect();
}

function sendTimelineErrorPage(message, detail) {
  send(MessageType.TimelinePage, {
    session_id: message.payload?.session_id ?? '',
    events: [],
    before_cursor: message.payload?.before_cursor ?? null,
    after_cursor: message.payload?.after_cursor ?? null,
    oldest_cursor: null,
    newest_cursor: null,
    has_more_before: false,
    has_more_after: false,
    source: 'host_error',
    error: detail
  });
}

function handleError(currentSocket, event) {
  if (currentSocket !== socket) {
    return;
  }

  const message = event.message ? `: ${event.message}` : '';
  const errorCause = event.error?.message ? ` (${event.error.message})` : '';
  console.error(`[bridge] websocket error${message}${errorCause}`);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    const heartbeatSent = send(MessageType.HostHeartbeat, {
      host_id: hostId,
      bridge_version: bridgeVersion
    });
    const statusSent = send(MessageType.PowerStatus, powerController.status());
    if (!heartbeatSent || !statusSent) {
      console.error('[bridge] heartbeat send failed; reconnecting');
      forceReconnect();
    }
  }, 5000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectAttempt += 1;
  const delayMs = reconnectAttempt === 1
    ? 1000
    : reconnectAttempt === 2
      ? 2000
      : reconnectAttempt === 3
        ? 5000
        : 30000;

  console.log(`[bridge] reconnecting in ${delayMs}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectRelay();
  }, delayMs);
}

function forceReconnect() {
  stopHeartbeat();
  const currentSocket = socket;
  socket = undefined;
  try {
    currentSocket?.close();
  } catch {
    // Ignore close failures; reconnect scheduling is the recovery path.
  }
  scheduleReconnect();
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
}

function send(type, payload) {
  return sendMessage(createRelayMessage(type, payload));
}

function sendMessage(message) {
  if (socket?.readyState !== WebSocket.OPEN) {
    return false;
  }

  try {
    socket.send(encodeMessage(message));
    return true;
  } catch (error) {
    console.error(`[bridge] websocket send failed: ${error.message}`);
    forceReconnect();
    return false;
  }
}

function createRelayMessage(type, payload) {
  return createMessage(type, payload, authOptions());
}

function withAuth(message) {
  if (!hostDeviceToken && !hostToken) {
    return message;
  }

  return {
    ...message,
    auth: {
      ...(message.auth ?? {}),
      ...(hostDeviceToken ? { host_device_token: hostDeviceToken } : { host_token: hostToken })
    }
  };
}

function authOptions() {
  if (hostDeviceToken) {
    return { auth: { host_device_token: hostDeviceToken } };
  }
  return hostToken ? { auth: { host_token: hostToken } } : {};
}

function isPowerMessage(type) {
  return type === MessageType.PowerTrustRequest
    || type === MessageType.PowerTrustVerify
    || type === MessageType.PowerRequest;
}
