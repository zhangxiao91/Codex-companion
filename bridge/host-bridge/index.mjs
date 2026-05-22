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

const relayUrl = process.env.RELAY_URL ?? DEFAULT_RELAY_URL;
const hostIdentityStore = createHostIdentityStore();
const storedHostIdentity = hostIdentityStore.load();
let hostDeviceToken = process.env.RELAY_HOST_DEVICE_TOKEN
  ?? storedHostIdentity.host_device_token
  ?? '';
const hostToken = process.env.RELAY_HOST_TOKEN
  ?? process.env.RELAY_DEV_TOKEN
  ?? process.env.DEV_TOKEN
  ?? '';
const hostId = process.env.HOST_ID ?? 'local-dev-host';
const displayName = process.env.HOST_NAME ?? 'Local Development Host';
const bridgeVersion = '0.0.1';
const adapter = createCodexAdapter(hostId, {
  onTimelineEvent: (event) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(encodeMessage(createRelayMessage(MessageType.TimelineEvent, { event })));
    }
  },
  onApprovalRequest: (approval) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(encodeMessage(createRelayMessage(MessageType.ApprovalRequest, { approval })));
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
    capabilities: ['session.list', 'session.prompt', 'timeline.event', 'git.status', 'git.diff']
  });

  console.log('[bridge] registered host capabilities: session.list, session.prompt, timeline.event, git.status, git.diff');

  for (const session of adapter.listSessions()) {
    send(MessageType.SessionSnapshot, { session });
  }

  if (typeof adapter.listApprovals === 'function') {
    for (const approval of adapter.listApprovals()) {
      send(MessageType.ApprovalRequest, { approval });
    }
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
        return;
      }

      const responses = await adapter.readTimeline(sessionId, {
        afterCursor: message.payload.after_cursor,
        beforeCursor: message.payload.before_cursor,
        limit: message.payload.limit,
        page: message.payload.page === true
      });
      for (const response of responses) {
        socket.send(encodeMessage(withAuth(response)));
      }
      return;
    }

    if (message.type === MessageType.ApprovalDecision) {
      if (typeof adapter.resolveApproval !== 'function') {
        return;
      }

      console.log(`[bridge] received approval decision for ${message.payload.approval_id}: ${message.payload.decision}`);
      const response = await adapter.resolveApproval(message.payload);
      socket.send(encodeMessage(withAuth(response)));
      return;
    }

    if (message.type === MessageType.GitRequest) {
      const session = adapter.listSessions().find((item) => item.session_id === message.payload.session_id);
      if (!session) {
        throw new Error(`Unknown session for git request: ${message.payload.session_id}`);
      }

      console.log(`[bridge] received git ${message.payload.action} for ${message.payload.session_id}`);
      const snapshot = await handleGitRequest(session, message.payload);
      socket.send(encodeMessage(createRelayMessage(MessageType.GitSnapshot, { snapshot })));
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

socket.addEventListener('close', (event) => {
  const reason = event.reason ? ` reason=${event.reason}` : '';
  console.log(`[bridge] disconnected from relay code=${event.code} was_clean=${event.wasClean}${reason}`);
  if (typeof adapter.stop === 'function') {
    adapter.stop();
  }
});

socket.addEventListener('error', (event) => {
  const message = event.message ? `: ${event.message}` : '';
  const errorCause = event.error?.message ? ` (${event.error.message})` : '';
  console.error(`[bridge] websocket error${message}${errorCause}`);
});

function send(type, payload) {
  socket.send(encodeMessage(createRelayMessage(type, payload)));
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
