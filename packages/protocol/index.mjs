import { randomUUID } from 'node:crypto';

export const DEFAULT_RELAY_URL = process.env.RELAY_URL ?? 'ws://127.0.0.1:8787';

export const MessageType = Object.freeze({
  Ack: 'message.ack',
  Error: 'error',
  HostRegister: 'host.register',
  HostTrusted: 'host.trusted',
  HostHeartbeat: 'host.heartbeat',
  HostSnapshot: 'host.snapshot',
  ApprovalRequest: 'approval.request',
  ApprovalDecision: 'approval.decision',
  GitRequest: 'git.request',
  GitSnapshot: 'git.snapshot',
  PowerStatus: 'power.status',
  PowerTrustRequest: 'power.trust.request',
  PowerTrustChallenge: 'power.trust.challenge',
  PowerTrustVerify: 'power.trust.verify',
  PowerTrustGranted: 'power.trust.granted',
  PowerRequest: 'power.request',
  PowerResult: 'power.result',
  SessionCreate: 'session.create',
  SessionCreateEphemeral: 'session.create_ephemeral',
  SessionSnapshot: 'session.snapshot',
  SessionSubscribe: 'session.subscribe',
  SessionPrompt: 'session.prompt',
  SessionPromptQueue: 'session.prompt.queue',
  SessionPromptEdit: 'session.prompt.edit',
  SessionTurnInterrupt: 'session.turn.interrupt',
  SessionTimelineRequest: 'session.timeline.request',
  SessionSyncIndex: 'session.sync.index',
  SessionSyncIndexResult: 'session.sync.index.result',
  SessionSyncAck: 'session.sync.ack',
  SessionArchiveUpdate: 'session.archive.update',
  SessionPinUpdate: 'session.pin.update',
  TimelineEvent: 'timeline.event',
  TimelinePage: 'timeline.page',
  NotificationEvent: 'notification.event'
});

export const SenderRole = Object.freeze({
  Host: 'host',
  Client: 'client',
  Relay: 'relay'
});

export const SessionStatus = Object.freeze({
  Running: 'running',
  WaitingForInput: 'waiting_for_input',
  Completed: 'completed'
});

export function createMessage(type, payload, options = {}) {
  const message = {
    id: options.id ?? randomUUID(),
    type,
    sent_at: new Date().toISOString(),
    payload
  };

  if (options.auth) {
    message.auth = options.auth;
  }

  return message;
}

export function createMockSession(hostId) {
  return {
    session_id: 'mock-session-001',
    host_id: hostId,
    project_name: 'Delivery Strategy Spike',
    repo_path: process.cwd(),
    branch: 'main',
    status: SessionStatus.WaitingForInput,
    summary: 'Mock Codex session for validating mobile-to-host prompt routing.',
    updated_at: new Date().toISOString()
  };
}

export function createTimelineEvent(sessionId, title, summary, payload = {}) {
  return {
    event_id: randomUUID(),
    session_id: sessionId,
    created_at: new Date().toISOString(),
    type: 'assistant_message',
    title,
    summary,
    payload,
    redaction_level: 'none'
  };
}

export function encodeMessage(message) {
  return JSON.stringify(message);
}

export function decodeMessage(raw) {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  const message = JSON.parse(text);

  if (!message || typeof message !== 'object') {
    throw new Error('Message must be an object.');
  }

  if (typeof message.type !== 'string') {
    throw new Error('Message type is required.');
  }

  return message;
}

export function requirePayloadField(message, field) {
  if (!message.payload || message.payload[field] === undefined || message.payload[field] === null) {
    throw new Error(`Message ${message.type} is missing payload.${field}.`);
  }
}
