import { existsSync } from 'node:fs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MessageType,
  createMessage,
  createMockSession,
  createTimelineEvent
} from '../../packages/protocol/index.mjs';
import { StdioJsonTransport } from './app-server-stdio-transport.mjs';
import {
  mapAppServerNotificationToTimelineEvents,
  mapThreadToTimelineEvents,
  mapThreadToTimelinePage
} from './timeline-mapper.mjs';

const MAX_PROMPT_QUEUE_LENGTH = 5;

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

  async sendPrompt(sessionId, draft) {
    if (sessionId !== this.session.session_id) {
      throw new Error(`Unknown mock session: ${sessionId}`);
    }

    const normalized = normalizePromptDraft(draft);
    const event = createTimelineEvent(
      sessionId,
      'Prompt routed to Host Bridge',
      `Host Bridge received prompt: ${summarizePromptDraft(normalized)}`,
      {
        adapter: 'mock',
        received_prompt: normalized.text,
        input_count: normalized.input.length,
        options: normalized.options
      }
    );

    return createMessage(MessageType.TimelineEvent, { event });
  }

  async queuePrompt(sessionId, draft) {
    if (sessionId !== this.session.session_id) {
      throw new Error(`Unknown mock session: ${sessionId}`);
    }

    const normalized = normalizePromptDraft(draft);
    const event = createTimelineEvent(
      sessionId,
      'Prompt queued',
      `Queued prompt: ${summarizePromptDraft(normalized)}`,
      {
        adapter: 'mock',
        queued_prompt: normalized.text,
        queue_depth: 1
      }
    );
    event.type = 'prompt_queued';

    return createMessage(MessageType.TimelineEvent, { event });
  }

  async editPrompt(sessionId, draft) {
    if (sessionId !== this.session.session_id) {
      throw new Error(`Unknown mock session: ${sessionId}`);
    }

    const normalized = normalizePromptDraft(draft);
    const event = createTimelineEvent(
      sessionId,
      'Prompt edit routed to Host Bridge',
      `Host Bridge received edited prompt: ${summarizePromptDraft(normalized)}`,
      {
        adapter: 'mock',
        base_event_id: draft.base_event_id,
        base_turn_id: draft.base_turn_id,
        received_prompt: normalized.text,
        options: normalized.options
      }
    );

    return createMessage(MessageType.TimelineEvent, { event });
  }

  async interruptTurn(sessionId) {
    if (sessionId !== this.session.session_id) {
      throw new Error(`Unknown mock session: ${sessionId}`);
    }

    const event = createTimelineEvent(
      sessionId,
      'Turn interrupt routed to Host Bridge',
      'Host Bridge received a request to pause the active Codex turn.',
      { adapter: 'mock' }
    );
    event.type = 'turn_interrupt_requested';

    return createMessage(MessageType.TimelineEvent, { event });
  }

  async readTimeline(sessionId, options = {}) {
    if (sessionId !== this.session.session_id) {
      throw new Error(`Unknown mock session: ${sessionId}`);
    }

    const event = createTimelineEvent(
      sessionId,
      'Mock timeline loaded',
      'Mock Codex session timeline is available.',
      { adapter: 'mock' }
    );

    if (options.page) {
      return [
        createMessage(MessageType.TimelinePage, {
          session_id: sessionId,
          events: [{ ...event, cursor: '1' }],
          before_cursor: options.beforeCursor ?? null,
          after_cursor: options.afterCursor ?? null,
          oldest_cursor: '1',
          newest_cursor: '1',
          has_more_before: false,
          has_more_after: false,
          source: 'host'
        })
      ];
    }

    return [
      createMessage(MessageType.TimelineEvent, {
        event
      })
    ].slice(0, options.limit ?? 1);
  }
}

export class AppServerCodexAdapter {
  constructor(hostId, options = {}) {
    this.hostId = hostId;
    this.listenUrl = process.env.CODEX_APP_SERVER_LISTEN ?? 'stdio://';
    this.codexCli = options.codexCli ?? resolveCodexCli();
    this.child = undefined;
    this.transport = undefined;
    this.pending = new Map();
    this.pendingApprovals = new Map();
    this.nextId = 1;
    this.cachedSessions = [];
    this.activeTurnsByThread = new Map();
    this.promptQueuesByThread = new Map();
    this.queueStorePath = resolve(process.env.CMC_PROMPT_QUEUE_STORE_PATH ?? '.relay/prompt-queue-state.json');
    this.loadPromptQueueStore();
    this.onTimelineEvent = options.onTimelineEvent;
    this.onApprovalRequest = options.onApprovalRequest;
    this.approvalPolicy = process.env.CODEX_APPROVAL_POLICY ?? 'on-request';
    this.approvalsReviewer = process.env.CODEX_APPROVALS_REVIEWER ?? 'user';
  }

  async start() {
    if (this.transport) {
      return;
    }

    this.child = spawn(this.codexCli, ['app-server', '--listen', this.listenUrl], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.transport = new StdioJsonTransport(this.child);
    this.transport.addEventListener('message', (event) => this.handleMessage(event.data));
    this.transport.addEventListener('stderr', (chunk) => {
      process.stderr.write(`[codex-app-server:err] ${chunk}`);
    });
    this.transport.addEventListener('close', () => {
      this.transport = undefined;
    });
    this.transport.addEventListener('error', (event) => {
      console.error(`[codex-app-server:err] ${event.message}`);
    });

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
    this.persistPromptQueueStore();
  }

  async stop() {
    if (this.transport) {
      this.transport.close();
      this.transport = undefined;
    }

    if (this.child && !this.child.killed) {
      this.child.kill();
      await delay(250);
    }
  }

  listSessions() {
    return this.cachedSessions;
  }

  async findSession(sessionId) {
    const cached = this.cachedSessions.find((item) => item.session_id === sessionId);
    if (cached) {
      return cached;
    }

    await this.refreshSessions();
    return this.cachedSessions.find((item) => item.session_id === sessionId) ?? null;
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

  async sendPrompt(sessionId, draft) {
    const normalized = normalizePromptDraft(draft);
    try {
      await this.ensureThreadLoaded(sessionId);
      const activeTurnId = this.activeTurnsByThread.get(sessionId);
      const input = buildAppServerInput(normalized);
      const metadata = buildMobileMetadata(normalized);

      if (activeTurnId) {
        const response = await this.requestWithThreadLoadedRetry(sessionId, 'turn/steer', {
          threadId: sessionId,
          expectedTurnId: activeTurnId,
          input,
          responsesapiClientMetadata: metadata
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
              prompt: normalized.text,
              options: normalized.options,
              input_count: normalized.input.length
            },
            redaction_level: 'none'
          }
        });
      }

      const response = await this.requestWithThreadLoadedRetry(sessionId, 'turn/start', {
        threadId: sessionId,
        input,
        approvalPolicy: this.approvalPolicy,
        approvalsReviewer: this.approvalsReviewer,
        sandboxPolicy: {
          type: 'readOnly',
          networkAccess: false
        },
        responsesapiClientMetadata: metadata
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
            prompt: normalized.text,
            options: normalized.options,
            input_count: normalized.input.length
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
            prompt: normalized.text,
            error: error.message
          },
          redaction_level: 'none'
        }
      });
    }
  }

  async queuePrompt(sessionId, draft) {
    const normalized = normalizePromptDraft({
      text: draft.text,
      input: [{ type: 'text', text: draft.text }],
      client_request_id: draft.client_request_id
    });

    if (!normalized.text.trim()) {
      throw new Error('Queued prompt cannot be empty.');
    }

    await this.ensureThreadLoaded(sessionId);
    const activeTurnId = this.activeTurnsByThread.get(sessionId);
    if (!activeTurnId) {
      return this.sendPrompt(sessionId, normalized);
    }

    const queue = this.promptQueuesByThread.get(sessionId) ?? [];
    if (queue.length >= MAX_PROMPT_QUEUE_LENGTH) {
      return createMessage(MessageType.TimelineEvent, {
        event: {
          event_id: `${sessionId}:prompt_queue_full:${Date.now()}`,
          session_id: sessionId,
          created_at: new Date().toISOString(),
          type: 'error',
          title: 'Prompt queue full',
          summary: `Prompt queue can hold up to ${MAX_PROMPT_QUEUE_LENGTH} items.`,
          payload: {
            queue_depth: queue.length,
            max_queue_depth: MAX_PROMPT_QUEUE_LENGTH
          },
          redaction_level: 'none'
        }
      });
    }

    queue.push({
      ...normalized,
      queued_at: new Date().toISOString()
    });
    this.promptQueuesByThread.set(sessionId, queue);
    this.persistPromptQueueStore();

    return createMessage(MessageType.TimelineEvent, {
      event: {
        event_id: `${sessionId}:prompt_queued:${Date.now()}`,
        session_id: sessionId,
        created_at: new Date().toISOString(),
        type: 'prompt_queued',
        title: 'Prompt queued',
        summary: `Queued prompt ${queue.length}/${MAX_PROMPT_QUEUE_LENGTH}.`,
        payload: {
          prompt: normalized.text,
          queue_depth: queue.length,
          max_queue_depth: MAX_PROMPT_QUEUE_LENGTH,
          active_turn_id: activeTurnId
        },
        redaction_level: 'none'
      }
    });
  }

  async editPrompt(sessionId, draft) {
    const normalized = normalizePromptDraft(draft);
    try {
      await this.ensureThreadLoaded(sessionId);
      this.activeTurnsByThread.delete(sessionId);

      let targetThreadId = sessionId;
      let forked = false;
      if (draft.base_turn_id) {
        try {
          const forkResponse = await this.requestWithThreadLoadedRetry(sessionId, 'thread/fork', {
            threadId: sessionId,
            turnId: draft.base_turn_id
          });
          targetThreadId = forkResponse.thread?.id ?? forkResponse.threadId ?? sessionId;
          forked = targetThreadId !== sessionId;
        } catch (error) {
          console.warn(`[bridge] thread/fork failed, falling back to normal turn/start: ${error.message}`);
        }
      }

      const editDraft = {
        ...normalized,
        text: normalized.text,
        options: {
          ...normalized.options,
          edit: {
            base_event_id: draft.base_event_id,
            base_turn_id: draft.base_turn_id ?? null,
            forked
          }
        }
      };
      const response = await this.requestWithThreadLoadedRetry(targetThreadId, 'turn/start', {
        threadId: targetThreadId,
        input: buildAppServerInput(editDraft),
        approvalPolicy: this.approvalPolicy,
        approvalsReviewer: this.approvalsReviewer,
        sandboxPolicy: {
          type: 'readOnly',
          networkAccess: false
        },
        responsesapiClientMetadata: buildMobileMetadata(editDraft)
      });

      const turn = response.turn;
      this.activeTurnsByThread.set(targetThreadId, turn.id);
      if (forked) {
        await this.refreshSessions();
      }

      return createMessage(MessageType.TimelineEvent, {
        event: {
          event_id: `${targetThreadId}:${turn.id}:prompt_edit_requested`,
          session_id: targetThreadId,
          created_at: new Date().toISOString(),
          type: 'prompt_edit_requested',
          title: 'Edited prompt sent to Codex',
          summary: forked ? `Started edited turn ${turn.id} in a forked thread.` : `Started edited turn ${turn.id}.`,
          payload: {
            turn_id: turn.id,
            original_session_id: sessionId,
            base_event_id: draft.base_event_id,
            base_turn_id: draft.base_turn_id ?? null,
            prompt: normalized.text,
            forked
          },
          redaction_level: 'none'
        }
      });
    } catch (error) {
      return createMessage(MessageType.TimelineEvent, {
        event: {
          event_id: `${sessionId}:prompt_edit_failed:${Date.now()}`,
          session_id: sessionId,
          created_at: new Date().toISOString(),
          type: 'error',
          title: 'Prompt edit failed',
          summary: error.message,
          payload: {
            base_event_id: draft.base_event_id,
            prompt: normalized.text,
            error: error.message
          },
          redaction_level: 'none'
        }
      });
    }
  }

  async interruptTurn(sessionId) {
    try {
      await this.ensureThreadLoaded(sessionId);
      const activeTurnId = this.activeTurnsByThread.get(sessionId);
      if (!activeTurnId) {
        return createMessage(MessageType.TimelineEvent, {
          event: {
            event_id: `${sessionId}:turn_interrupt_noop:${Date.now()}`,
            session_id: sessionId,
            created_at: new Date().toISOString(),
            type: 'turn_interrupt_noop',
            title: 'No active turn to pause',
            summary: 'Codex does not currently have an active turn for this session.',
            payload: {},
            redaction_level: 'none'
          }
        });
      }

      await this.requestWithThreadLoadedRetry(sessionId, 'turn/interrupt', {
        threadId: sessionId,
        turnId: activeTurnId
      });
      this.activeTurnsByThread.delete(sessionId);

      return createMessage(MessageType.TimelineEvent, {
        event: {
          event_id: `${sessionId}:${activeTurnId}:turn_interrupt_requested:${Date.now()}`,
          session_id: sessionId,
          created_at: new Date().toISOString(),
          type: 'turn_interrupt_requested',
          title: 'Pause requested',
          summary: `Requested pause for turn ${activeTurnId}.`,
          payload: {
            turn_id: activeTurnId
          },
          redaction_level: 'none'
        }
      });
    } catch (error) {
      return createMessage(MessageType.TimelineEvent, {
        event: {
          event_id: `${sessionId}:turn_interrupt_failed:${Date.now()}`,
          session_id: sessionId,
          created_at: new Date().toISOString(),
          type: 'error',
          title: 'Pause failed',
          summary: error.message,
          payload: {
            error: error.message
          },
          redaction_level: 'none'
        }
      });
    }
  }

  async readTimeline(sessionId, options = {}) {
    await this.ensureThreadLoaded(sessionId, { includeTurns: true });
    const response = await this.requestWithThreadLoadedRetry(sessionId, 'thread/read', {
      threadId: sessionId,
      includeTurns: true
    });

    if (options.page) {
      return [
        createMessage(MessageType.TimelinePage, mapThreadToTimelinePage(response.thread, options))
      ];
    }

    return mapThreadToTimelineEvents(response.thread, options).map((event) => (
      createMessage(MessageType.TimelineEvent, { event })
    ));
  }

  async createEphemeralSession(options = {}) {
    const response = await this.request('thread/start', {
      cwd: options.cwd ?? process.cwd(),
      approvalPolicy: this.approvalPolicy,
      approvalsReviewer: this.approvalsReviewer,
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
      if (message.method === 'error') {
        console.error(`[bridge] app-server error params: ${truncateForLog(JSON.stringify(message.params))}`);
      }
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
    this.transport.send(JSON.stringify({
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
    if (!this.transport) {
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

      this.transport.send(JSON.stringify({ id, method, params }));
    });
  }

  async requestWithThreadLoadedRetry(sessionId, method, params) {
    try {
      return await this.request(method, params);
    } catch (error) {
      if (!isThreadNotLoadedError(error)) {
        throw error;
      }

      await this.ensureThreadLoaded(sessionId, { force: true, includeTurns: method === 'thread/read' });
      return this.request(method, params);
    }
  }

  async ensureThreadLoaded(sessionId, options = {}) {
    const loaded = await this.request('thread/loaded/list', {
      limit: 100
    });

    if (!options.force && loaded.data.includes(sessionId)) {
      return;
    }

    await this.request('thread/resume', {
      threadId: sessionId,
      approvalPolicy: this.approvalPolicy,
      approvalsReviewer: this.approvalsReviewer,
      sandbox: 'read-only',
      excludeTurns: options.includeTurns === true ? false : true,
      persistExtendedHistory: false
    });

    await this.waitForThreadLoaded(sessionId);
  }

  async waitForThreadLoaded(sessionId) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const loaded = await this.request('thread/loaded/list', {
        limit: 100
      });
      if (loaded.data.includes(sessionId)) {
        return;
      }
      await delay(150);
    }
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
        this.drainPromptQueue(message.params.threadId).catch((error) => {
          console.error(`[bridge] failed to drain prompt queue: ${error.message}`);
        });
      }
    }
  }

  async drainPromptQueue(sessionId) {
    const queue = this.promptQueuesByThread.get(sessionId);
    if (!queue || queue.length === 0) {
      return;
    }

    await this.ensureThreadLoaded(sessionId);
    const activeTurnId = this.activeTurnsByThread.get(sessionId);
    if (activeTurnId) {
      return;
    }

    const next = queue.shift();
    if (queue.length > 0) {
      this.promptQueuesByThread.set(sessionId, queue);
    } else {
      this.promptQueuesByThread.delete(sessionId);
    }
    this.persistPromptQueueStore();

    this.onTimelineEvent?.({
      event_id: `${sessionId}:prompt_queue_started:${Date.now()}`,
      session_id: sessionId,
      created_at: new Date().toISOString(),
      type: 'prompt_queue_started',
      title: 'Queued prompt started',
      summary: `Started queued prompt. ${queue.length}/${MAX_PROMPT_QUEUE_LENGTH} queued.`,
      payload: {
        prompt: next.text,
        queue_depth: queue.length,
        max_queue_depth: MAX_PROMPT_QUEUE_LENGTH
      },
      redaction_level: 'none'
    });

    const response = await this.sendPrompt(sessionId, next);
    if (response?.type === MessageType.TimelineEvent) {
      this.onTimelineEvent?.(response.payload.event);
    }
  }

  loadPromptQueueStore() {
    try {
      if (!existsSync(this.queueStorePath)) {
        return;
      }
      const raw = readFileSync(this.queueStorePath, 'utf8');
      const parsed = JSON.parse(raw);
      const queues = parsed?.queues ?? {};
      for (const [sessionId, queue] of Object.entries(queues)) {
        if (Array.isArray(queue) && queue.length > 0) {
          this.promptQueuesByThread.set(sessionId, queue);
        }
      }
    } catch (error) {
      console.warn(`[bridge] failed to load prompt queue store: ${error.message}`);
    }
  }

  persistPromptQueueStore() {
    try {
      mkdirSync(dirname(this.queueStorePath), { recursive: true });
      const payload = {
        updated_at: new Date().toISOString(),
        queues: Object.fromEntries(this.promptQueuesByThread.entries())
      };
      writeFileSync(this.queueStorePath, JSON.stringify(payload, null, 2));
    } catch (error) {
      console.warn(`[bridge] failed to persist prompt queue store: ${error.message}`);
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

function isThreadNotLoadedError(error) {
  const message = String(error?.message ?? '');
  return message.includes('thread not loaded');
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

function truncateForLog(text, maxLength = 1200) {
  if (!text || text.length <= maxLength) {
    return text ?? '';
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function normalizePromptDraft(draft) {
  if (typeof draft === 'string') {
    return {
      text: draft,
      input: [{ type: 'text', text: draft }],
      options: {},
      client_request_id: null
    };
  }

  const payload = draft && typeof draft === 'object' ? draft : {};
  const input = Array.isArray(payload.input) && payload.input.length > 0
    ? payload.input
    : (typeof payload.text === 'string' ? [{ type: 'text', text: payload.text }] : []);
  const text = typeof payload.text === 'string'
    ? payload.text
    : input.filter((item) => item?.type === 'text').map((item) => item.text ?? '').join('\n');

  return {
    text,
    input,
    options: payload.options && typeof payload.options === 'object' ? payload.options : {},
    client_request_id: payload.client_request_id ?? null
  };
}

function summarizePromptDraft(draft) {
  const imageCount = draft.input.filter((item) => item?.type === 'image').length;
  const text = truncateForLog(draft.text, 240);
  return imageCount > 0 ? `${text || '[image prompt]'} (${imageCount} image${imageCount === 1 ? '' : 's'})` : text;
}

function buildAppServerInput(draft) {
  const textParts = draft.input.filter((item) => item?.type === 'text').map((item) => item.text ?? '').filter(Boolean);
  const text = textParts.join('\n').trim() || draft.text.trim();
  const instructionPrefix = buildOneShotInstructionPrefix(draft.options);
  const input = [];

  if (instructionPrefix || text) {
    input.push({
      type: 'text',
      text: [instructionPrefix, text].filter(Boolean).join('\n\n'),
      text_elements: []
    });
  }

  for (const image of draft.input.filter((item) => item?.type === 'image')) {
    input.push({
      type: 'image',
      image_url: image.data_url,
      data_url: image.data_url,
      mime_type: image.mime_type,
      name: image.name
    });
  }

  return input;
}

function buildOneShotInstructionPrefix(options = {}) {
  const instructions = [];
  const effort = options.reasoning_effort;
  if (effort && effort !== 'auto') {
    instructions.push(`For this turn only, use ${effort} reasoning depth.`);
  }
  if (options.plan_mode === true) {
    instructions.push('For this turn only, start in planning mode. Do not make file or shell changes until the plan is clear.');
  }
  if (options.goal?.objective) {
    instructions.push(`For this turn only, pursue this goal: ${options.goal.objective}`);
  }
  if (options.edit?.base_event_id) {
    instructions.push('This message replaces the previous mobile prompt selected by the user. Continue from the revised prompt.');
  }

  return instructions.length > 0
    ? `Mobile run options:\n${instructions.map((item) => `- ${item}`).join('\n')}`
    : '';
}

function buildMobileMetadata(draft) {
  return {
    source: 'codex-mobile-companion',
    clientRequestId: draft.client_request_id,
    mobileOptions: draft.options,
    inputTypes: draft.input.map((item) => item?.type ?? 'unknown')
  };
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
