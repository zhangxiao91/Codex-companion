import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MessageType,
  createMessage,
  createMockSession,
  createTimelineEvent
} from '../../packages/protocol/index.mjs';
import {
  mapAppServerNotificationToTimelineEvents,
  mapThreadToTimelineEvents
} from './timeline-mapper.mjs';

export class MockCodexAdapter {
  constructor(hostId) {
    this.hostId = hostId;
    this.session = {
      ...createMockSession(hostId),
      repo_path: process.env.MOCK_SESSION_REPO_PATH || process.cwd()
    };
    this.approvals = new Map([
      [
        'mock-approval-001',
        {
          approval_id: 'mock-approval-001',
          session_id: this.session.session_id,
          kind: 'shell',
          title: 'Run test command',
          summary: 'Mock approval for validating mobile approval routing.',
          command: 'npm test',
          cwd: process.cwd(),
          risk_level: 'medium',
          allowed_decisions: ['approve_once', 'deny'],
          status: 'pending',
          requested_at: new Date().toISOString()
        }
      ]
    ]);
  }

  listSessions() {
    return [this.session];
  }

  listApprovals() {
    return [...this.approvals.values()].filter((approval) => approval.status === 'pending');
  }

  async resolveApproval({ approval_id: approvalId, decision }) {
    const approval = this.approvals.get(approvalId);
    if (!approval) {
      throw new Error(`Unknown mock approval: ${approvalId}`);
    }

    const resolvedApproval = {
      ...approval,
      status: decision,
      decided_at: new Date().toISOString()
    };
    this.approvals.set(approvalId, resolvedApproval);

    return createMessage(MessageType.TimelineEvent, {
      event: {
        event_id: `${approval.session_id}:${approvalId}:approval_resolved`,
        session_id: approval.session_id,
        created_at: new Date().toISOString(),
        type: 'approval_resolved',
        title: 'Approval resolved',
        summary: `Decision: ${decision}`,
        payload: {
          approval_id: approvalId,
          decision
        },
        redaction_level: 'none'
      }
    });
  }

  async sendPrompt(sessionId, text) {
    if (sessionId !== this.session.session_id) {
      throw new Error(`Unknown mock session: ${sessionId}`);
    }

    const event = createTimelineEvent(
      sessionId,
      'Prompt routed to Host Bridge',
      `Host Bridge received prompt: ${text}`,
      {
        adapter: 'mock',
        received_prompt: text
      }
    );

    return createMessage(MessageType.TimelineEvent, { event });
  }

  async readTimeline(sessionId, options = {}) {
    if (sessionId !== this.session.session_id) {
      throw new Error(`Unknown mock session: ${sessionId}`);
    }

    return [
      createMessage(MessageType.TimelineEvent, {
        event: createTimelineEvent(
          sessionId,
          'Mock timeline loaded',
          'Mock Codex session timeline is available.',
          { adapter: 'mock' }
        )
      })
    ].slice(0, options.limit ?? 1);
  }
}

export class AppServerCodexAdapter {
  constructor(hostId, options = {}) {
    this.hostId = hostId;
    this.port = options.port ?? Number.parseInt(process.env.CODEX_APP_SERVER_PORT ?? '8791', 10);
    this.listenUrl = `ws://127.0.0.1:${this.port}`;
    this.codexCli = options.codexCli ?? resolveCodexCli();
    this.child = undefined;
    this.socket = undefined;
    this.pending = new Map();
    this.pendingApprovals = new Map();
    this.nextId = 1;
    this.cachedSessions = [];
    this.activeTurnsByThread = new Map();
    this.onTimelineEvent = options.onTimelineEvent;
    this.onApprovalRequest = options.onApprovalRequest;
    this.approvalPolicy = process.env.CODEX_APPROVAL_POLICY ?? 'never';
  }

  async start() {
    if (this.socket) {
      return;
    }

    this.child = spawn(this.codexCli, ['app-server', '--listen', this.listenUrl], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.child.stdout.on('data', (chunk) => {
      process.stdout.write(`[codex-app-server] ${chunk.toString()}`);
    });
    this.child.stderr.on('data', (chunk) => {
      process.stderr.write(`[codex-app-server:err] ${chunk.toString()}`);
    });

    this.socket = await connectWithRetry(this.listenUrl, 10000);
    this.socket.addEventListener('message', (event) => this.handleMessage(event.data));

    const initialize = await this.request('initialize', {
      clientInfo: {
        name: 'codex-mobile-companion-bridge',
        title: 'Codex Mobile Companion Bridge',
        version: '0.0.1'
      },
      capabilities: {
        experimentalApi: true
      }
    });

    console.log(`[bridge] app-server initialized: ${initialize.userAgent}`);
    await this.refreshSessions();
  }

  async stop() {
    if (this.socket) {
      this.socket.close();
      this.socket = undefined;
    }

    if (this.child && !this.child.killed) {
      this.child.kill();
      await delay(250);
    }
  }

  listSessions() {
    return this.cachedSessions;
  }

  async refreshSessions() {
    const response = await this.request('thread/list', {
      limit: 20,
      archived: false,
      useStateDbOnly: true
    });

    this.cachedSessions = response.data.map((thread) => mapThreadToSession(thread, this.hostId));
    return this.cachedSessions;
  }

  async sendPrompt(sessionId, text) {
    try {
      await this.ensureThreadLoaded(sessionId);
      const activeTurnId = this.activeTurnsByThread.get(sessionId);

      if (activeTurnId) {
        const response = await this.request('turn/steer', {
          threadId: sessionId,
          expectedTurnId: activeTurnId,
          input: [
            {
              type: 'text',
              text,
              text_elements: []
            }
          ],
          responsesapiClientMetadata: {
            source: 'codex-mobile-companion'
          }
        });

        return createMessage(MessageType.TimelineEvent, {
          event: {
            event_id: `${sessionId}:${response.turnId}:turn_steer_requested:${Date.now()}`,
            session_id: sessionId,
            created_at: new Date().toISOString(),
            type: 'turn_steer_requested',
            title: 'Prompt steered active Codex turn',
            summary: `Steered turn ${response.turnId}.`,
            payload: {
              turn_id: response.turnId,
              prompt: text
            },
            redaction_level: 'none'
          }
        });
      }

      const response = await this.request('turn/start', {
        threadId: sessionId,
        input: [
          {
            type: 'text',
            text,
            text_elements: []
          }
        ],
        approvalPolicy: this.approvalPolicy,
        sandboxPolicy: {
          type: 'readOnly',
          networkAccess: false
        },
        responsesapiClientMetadata: {
          source: 'codex-mobile-companion'
        }
      });

      const turn = response.turn;
      this.activeTurnsByThread.set(sessionId, turn.id);
      return createMessage(MessageType.TimelineEvent, {
        event: {
          event_id: `${sessionId}:${turn.id}:turn_start_requested`,
          session_id: sessionId,
          created_at: new Date().toISOString(),
          type: 'turn_start_requested',
          title: 'Prompt sent to Codex',
          summary: `Started turn ${turn.id}.`,
          payload: {
            turn_id: turn.id,
            status: turn.status,
            prompt: text
          },
          redaction_level: 'none'
        }
      });
    } catch (error) {
      return createMessage(MessageType.TimelineEvent, {
        event: {
          event_id: `${sessionId}:prompt_failed:${Date.now()}`,
          session_id: sessionId,
          created_at: new Date().toISOString(),
          type: 'error',
          title: 'Prompt failed',
          summary: error.message,
          payload: {
            prompt: text,
            error: error.message
          },
          redaction_level: 'none'
        }
      });
    }
  }

  async readTimeline(sessionId, options = {}) {
    const response = await this.request('thread/read', {
      threadId: sessionId,
      includeTurns: true
    });

    return mapThreadToTimelineEvents(response.thread, options).map((event) => (
      createMessage(MessageType.TimelineEvent, { event })
    ));
  }

  async createEphemeralSession(options = {}) {
    const response = await this.request('thread/start', {
      cwd: options.cwd ?? process.cwd(),
      approvalPolicy: this.approvalPolicy,
      sandbox: 'read-only',
      ephemeral: true,
      threadSource: 'user',
      serviceName: 'codex-mobile-companion-test',
      baseInstructions: options.baseInstructions ?? 'You are being used for a Codex Mobile Companion integration test. Keep responses concise.',
      developerInstructions: options.developerInstructions ?? null,
      experimentalRawEvents: false,
      persistExtendedHistory: false
    });

    const session = mapThreadToSession(response.thread, this.hostId);
    this.cachedSessions = [session, ...this.cachedSessions.filter((item) => item.session_id !== session.session_id)];
    return session;
  }

  handleMessage(raw) {
    const message = JSON.parse(raw);

    if (message.id !== undefined && this.pending.has(message.id)) {
      this.pending.get(message.id)(message);
      this.pending.delete(message.id);
      return;
    }

    if (message.id !== undefined && message.method && isAppServerApprovalMethod(message.method)) {
      this.handleApprovalServerRequest(message);
      return;
    }

    if (message.method) {
      console.log(`[bridge] app-server notification: ${message.method}`);
      this.updateActiveTurnState(message);
      for (const event of mapAppServerNotificationToTimelineEvents(message)) {
        this.onTimelineEvent?.(event);
      }
    }
  }

  listApprovals() {
    return [...this.pendingApprovals.values()].map((entry) => entry.approval);
  }

  async resolveApproval({ approval_id: approvalId, decision }) {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      throw new Error(`Unknown app-server approval: ${approvalId}`);
    }

    const response = createAppServerApprovalResponse(pending.method, pending.params, decision);
    this.socket.send(JSON.stringify({
      id: pending.requestId,
      result: response
    }));
    this.pendingApprovals.delete(approvalId);

    return createMessage(MessageType.TimelineEvent, {
      event: {
        event_id: `${pending.approval.session_id}:${approvalId}:approval_resolved:${Date.now()}`,
        session_id: pending.approval.session_id,
        created_at: new Date().toISOString(),
        type: 'approval_resolved',
        title: 'Approval resolved',
        summary: `Decision: ${decision}`,
        payload: {
          approval_id: approvalId,
          decision,
          app_server_method: pending.method
        },
        redaction_level: 'none'
      }
    });
  }

  handleApprovalServerRequest(message) {
    const approval = mapAppServerApprovalRequest(message);
    this.pendingApprovals.set(approval.approval_id, {
      requestId: message.id,
      method: message.method,
      params: message.params,
      approval
    });

    console.log(`[bridge] app-server approval requested: ${message.method} ${approval.approval_id}`);
    this.onApprovalRequest?.(approval);
  }

  request(method, params) {
    if (!this.socket) {
      throw new Error('App Server socket is not connected.');
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for app-server method ${method}`));
      }, 10000);

      this.pending.set(id, (response) => {
        clearTimeout(timer);

        if (response.error) {
          reject(new Error(JSON.stringify(response.error)));
          return;
        }

        resolve(response.result);
      });

      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async ensureThreadLoaded(sessionId) {
    const loaded = await this.request('thread/loaded/list', {
      limit: 100
    });

    if (loaded.data.includes(sessionId)) {
      return;
    }

    await this.request('thread/resume', {
      threadId: sessionId,
      approvalPolicy: this.approvalPolicy,
      sandbox: 'read-only',
      excludeTurns: true,
      persistExtendedHistory: false
    });
  }

  updateActiveTurnState(message) {
    if (message.method === 'turn/started') {
      this.activeTurnsByThread.set(message.params.threadId, message.params.turn.id);
      return;
    }

    if (message.method === 'turn/completed') {
      const activeTurnId = this.activeTurnsByThread.get(message.params.threadId);
      if (activeTurnId === message.params.turn.id) {
        this.activeTurnsByThread.delete(message.params.threadId);
      }
    }
  }
}

export function createCodexAdapter(hostId, options = {}) {
  if (process.env.CODEX_ADAPTER === 'app-server') {
    return new AppServerCodexAdapter(hostId, options);
  }

  return new MockCodexAdapter(hostId);
}

function mapThreadToSession(thread, hostId) {
  return {
    session_id: thread.id,
    host_id: hostId,
    project_name: thread.name ?? thread.preview?.slice(0, 48) ?? 'Codex Thread',
    repo_path: thread.cwd,
    branch: thread.gitInfo?.branch ?? 'unknown',
    status: mapThreadStatus(thread.status),
    summary: thread.preview ?? '',
    updated_at: new Date((thread.updatedAt ?? thread.createdAt ?? Date.now() / 1000) * 1000).toISOString()
  };
}

function mapThreadStatus(status) {
  if (!status || status.type === 'notLoaded') {
    return 'idle';
  }

  if (status.type === 'active') {
    return 'running';
  }

  if (status.type === 'systemError') {
    return 'failed';
  }

  return 'idle';
}

export function mapAppServerApprovalRequest(message) {
  const { method, params } = message;
  const sessionId = params.threadId ?? params.conversationId;
  const itemId = params.itemId ?? params.callId ?? 'request';
  const approvalId = params.approvalId ?? `${method}:${sessionId}:${itemId}:${message.id}`;
  const startedAt = params.startedAtMs
    ? new Date(params.startedAtMs).toISOString()
    : new Date().toISOString();

  if (method === 'item/commandExecution/requestApproval') {
    return {
      approval_id: approvalId,
      session_id: sessionId,
      kind: 'shell',
      title: 'Command approval requested',
      summary: params.reason ?? 'Codex wants to run a command.',
      command: params.command ?? summarizeCommandActions(params.commandActions),
      cwd: params.cwd ?? '',
      risk_level: riskForCommand(params),
      allowed_decisions: mapAllowedDecisions(params.availableDecisions),
      status: 'pending',
      requested_at: startedAt,
      payload: {
        app_server_method: method,
        request_id: message.id,
        turn_id: params.turnId,
        item_id: params.itemId,
        command_actions: params.commandActions,
        additional_permissions: params.additionalPermissions,
        proposed_execpolicy_amendment: params.proposedExecpolicyAmendment,
        proposed_network_policy_amendments: params.proposedNetworkPolicyAmendments
      }
    };
  }

  if (method === 'item/fileChange/requestApproval') {
    return {
      approval_id: approvalId,
      session_id: sessionId,
      kind: 'file_write',
      title: 'File change approval requested',
      summary: params.reason ?? (params.grantRoot ? `Allow writes under ${params.grantRoot}` : 'Codex wants to modify files.'),
      command: params.grantRoot ?? '',
      cwd: params.grantRoot ?? '',
      risk_level: 'medium',
      allowed_decisions: ['approve_once', 'approve_session', 'deny'],
      status: 'pending',
      requested_at: startedAt,
      payload: {
        app_server_method: method,
        request_id: message.id,
        turn_id: params.turnId,
        item_id: params.itemId,
        grant_root: params.grantRoot
      }
    };
  }

  if (method === 'item/permissions/requestApproval') {
    return {
      approval_id: approvalId,
      session_id: sessionId,
      kind: 'permissions',
      title: 'Permission approval requested',
      summary: params.reason ?? 'Codex requested additional permissions.',
      command: summarizePermissions(params.permissions),
      cwd: params.cwd ?? '',
      risk_level: 'high',
      allowed_decisions: ['approve_once', 'approve_session', 'deny'],
      status: 'pending',
      requested_at: startedAt,
      payload: {
        app_server_method: method,
        request_id: message.id,
        turn_id: params.turnId,
        item_id: params.itemId,
        permissions: params.permissions
      }
    };
  }

  if (method === 'execCommandApproval') {
    return {
      approval_id: approvalId,
      session_id: sessionId,
      kind: 'shell',
      title: 'Command approval requested',
      summary: params.reason ?? 'Codex wants to run a command.',
      command: (params.command ?? []).join(' '),
      cwd: params.cwd ?? '',
      risk_level: 'medium',
      allowed_decisions: ['approve_once', 'approve_session', 'deny'],
      status: 'pending',
      requested_at: startedAt,
      payload: {
        app_server_method: method,
        request_id: message.id,
        call_id: params.callId,
        parsed_command: params.parsedCmd
      }
    };
  }

  if (method === 'applyPatchApproval') {
    return {
      approval_id: approvalId,
      session_id: sessionId,
      kind: 'file_write',
      title: 'Patch approval requested',
      summary: params.reason ?? `${Object.keys(params.fileChanges ?? {}).length} file change(s).`,
      command: Object.keys(params.fileChanges ?? {}).join(', '),
      cwd: params.grantRoot ?? '',
      risk_level: 'medium',
      allowed_decisions: ['approve_once', 'approve_session', 'deny'],
      status: 'pending',
      requested_at: startedAt,
      payload: {
        app_server_method: method,
        request_id: message.id,
        call_id: params.callId,
        file_changes: params.fileChanges,
        grant_root: params.grantRoot
      }
    };
  }

  throw new Error(`Unsupported app-server approval method: ${method}`);
}

export function createAppServerApprovalResponse(method, params, decision) {
  if (method === 'item/commandExecution/requestApproval') {
    return {
      decision: mapCommandExecutionDecision(decision, params)
    };
  }

  if (method === 'item/fileChange/requestApproval') {
    return {
      decision: mapAcceptDeclineDecision(decision)
    };
  }

  if (method === 'item/permissions/requestApproval') {
    if (decision === 'deny') {
      return {
        permissions: {
          network: undefined,
          fileSystem: undefined
        },
        scope: 'turn',
        strictAutoReview: true
      };
    }

    return {
      permissions: {
        ...(params.permissions?.network ? { network: params.permissions.network } : {}),
        ...(params.permissions?.fileSystem ? { fileSystem: params.permissions.fileSystem } : {})
      },
      scope: decision === 'approve_session' ? 'session' : 'turn',
      strictAutoReview: false
    };
  }

  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    return {
      decision: mapReviewDecision(decision)
    };
  }

  throw new Error(`Unsupported app-server approval method: ${method}`);
}

function isAppServerApprovalMethod(method) {
  return method === 'item/commandExecution/requestApproval'
    || method === 'item/fileChange/requestApproval'
    || method === 'item/permissions/requestApproval'
    || method === 'execCommandApproval'
    || method === 'applyPatchApproval';
}

function mapCommandExecutionDecision(decision, params) {
  if (decision === 'approve_session') {
    return 'acceptForSession';
  }

  if (decision === 'deny') {
    return 'decline';
  }

  if (decision === 'approve_once') {
    return 'accept';
  }

  const available = params.availableDecisions ?? [];
  return available.includes('accept') ? 'accept' : available[0] ?? 'decline';
}

function mapAcceptDeclineDecision(decision) {
  if (decision === 'approve_session') {
    return 'acceptForSession';
  }

  return decision === 'deny' ? 'decline' : 'accept';
}

function mapReviewDecision(decision) {
  if (decision === 'approve_session') {
    return 'approved_for_session';
  }

  return decision === 'deny' ? 'denied' : 'approved';
}

function mapAllowedDecisions(availableDecisions = []) {
  const mapped = new Set();

  for (const decision of availableDecisions ?? []) {
    if (decision === 'accept') {
      mapped.add('approve_once');
    } else if (decision === 'acceptForSession') {
      mapped.add('approve_session');
    } else if (decision === 'decline' || decision === 'cancel') {
      mapped.add('deny');
    }
  }

  if (mapped.size === 0) {
    mapped.add('approve_once');
    mapped.add('deny');
  }

  return [...mapped];
}

function riskForCommand(params) {
  if (params.networkApprovalContext || params.additionalPermissions?.network) {
    return 'high';
  }

  if (params.additionalPermissions?.fileSystem || params.proposedExecpolicyAmendment) {
    return 'medium';
  }

  return 'medium';
}

function summarizeCommandActions(actions = []) {
  return (actions ?? []).map((action) => action.command ?? action.cmd ?? action.type).filter(Boolean).join(' && ');
}

function summarizePermissions(permissions) {
  if (!permissions) {
    return '';
  }

  const parts = [];
  if (permissions.network) {
    parts.push(`network=${JSON.stringify(permissions.network)}`);
  }
  if (permissions.fileSystem) {
    parts.push(`fileSystem=${JSON.stringify(permissions.fileSystem)}`);
  }
  return parts.join('; ');
}

function resolveCodexCli() {
  if (process.env.CODEX_CLI_PATH) {
    return process.env.CODEX_CLI_PATH;
  }

  const userProfile = process.env.USERPROFILE;
  const extensionCodexCli = findLatestVsCodeCodexCli(userProfile);
  const candidates = [
    extensionCodexCli,
    'codex'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'codex' || existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('Unable to find Codex CLI. Set CODEX_CLI_PATH.');
}

function findLatestVsCodeCodexCli(userProfile) {
  if (!userProfile) {
    return undefined;
  }

  const extensionsDir = `${userProfile}\\.vscode\\extensions`;
  if (!existsSync(extensionsDir)) {
    return undefined;
  }

  const candidates = readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'))
    .map((entry) => `${extensionsDir}\\${entry.name}\\bin\\windows-x86_64\\codex.exe`)
    .filter((candidate) => existsSync(candidate))
    .sort()
    .reverse();

  return candidates[0];
}

async function connectWithRetry(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await connect(url);
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }

  throw lastError ?? new Error(`Timed out connecting to ${url}`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out opening WebSocket ${url}`));
    }, 2000);

    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket connection failed for ${url}`));
    });
  });
}
