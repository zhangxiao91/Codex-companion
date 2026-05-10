import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MessageType,
  createMessage,
  createMockSession,
  createTimelineEvent
} from '../../packages/protocol/index.mjs';

export class MockCodexAdapter {
  constructor(hostId) {
    this.hostId = hostId;
    this.session = createMockSession(hostId);
  }

  listSessions() {
    return [this.session];
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
    this.nextId = 1;
    this.cachedSessions = [];
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
    throw new Error(`AppServerCodexAdapter is read-only in this milestone. Cannot send prompt to ${sessionId}: ${text}`);
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

  handleMessage(raw) {
    const message = JSON.parse(raw);

    if (message.id !== undefined && this.pending.has(message.id)) {
      this.pending.get(message.id)(message);
      this.pending.delete(message.id);
      return;
    }

    if (message.method) {
      console.log(`[bridge] app-server notification: ${message.method}`);
    }
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
}

export function createCodexAdapter(hostId) {
  if (process.env.CODEX_ADAPTER === 'app-server') {
    return new AppServerCodexAdapter(hostId);
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

function mapThreadToTimelineEvents(thread, options = {}) {
  const events = [];
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : undefined;

  for (const turn of thread.turns ?? []) {
    if (turn.startedAt) {
      events.push(createThreadTimelineEvent(
        thread.id,
        'turn_started',
        'Turn started',
        `Turn ${turn.id} started.`,
        turn.startedAt,
        { turn_id: turn.id, status: turn.status }
      ));
    }

    for (const item of turn.items ?? []) {
      const event = mapThreadItemToTimelineEvent(thread.id, turn, item);
      if (event) {
        events.push(event);
        if (limit && events.length >= limit) {
          return events;
        }
      }
    }

    if (turn.completedAt) {
      events.push(createThreadTimelineEvent(
        thread.id,
        'turn_completed',
        'Turn completed',
        `Turn ${turn.id} completed.`,
        turn.completedAt,
        { turn_id: turn.id, status: turn.status, duration_ms: turn.durationMs }
      ));
    }
  }

  if (events.length === 0) {
    events.push(createThreadTimelineEvent(
      thread.id,
      'summary',
      'Thread loaded',
      thread.preview || 'Thread has no loaded turns yet.',
      thread.updatedAt ?? thread.createdAt ?? Date.now() / 1000,
      { source: 'thread/read' }
    ));
  }

  return limit ? events.slice(0, limit) : events;
}

function mapThreadItemToTimelineEvent(threadId, turn, item) {
  const basePayload = {
    turn_id: turn.id,
    item_id: item.id,
    item_type: item.type
  };

  switch (item.type) {
    case 'userMessage':
      return createThreadTimelineEvent(
        threadId,
        'user_prompt',
        'User prompt',
        summarizeUserInput(item.content),
        turn.startedAt,
        { ...basePayload, content: item.content }
      );
    case 'agentMessage':
      return createThreadTimelineEvent(
        threadId,
        'assistant_message',
        'Assistant message',
        truncate(item.text),
        turn.completedAt ?? turn.startedAt,
        { ...basePayload, phase: item.phase }
      );
    case 'plan':
      return createThreadTimelineEvent(
        threadId,
        'plan_update',
        'Plan update',
        truncate(item.text),
        turn.startedAt,
        basePayload
      );
    case 'reasoning':
      return createThreadTimelineEvent(
        threadId,
        'reasoning_summary',
        'Reasoning summary',
        truncate([...item.summary, ...item.content].join('\n')),
        turn.startedAt,
        { ...basePayload, summary_count: item.summary.length, content_count: item.content.length }
      );
    case 'commandExecution':
      return createThreadTimelineEvent(
        threadId,
        'command_execution',
        `Command ${item.status?.type ?? 'execution'}`,
        truncate(item.command),
        turn.completedAt ?? turn.startedAt,
        {
          ...basePayload,
          command: item.command,
          cwd: item.cwd,
          status: item.status,
          exit_code: item.exitCode,
          duration_ms: item.durationMs,
          output_preview: truncate(item.aggregatedOutput ?? '')
        }
      );
    case 'fileChange':
      return createThreadTimelineEvent(
        threadId,
        'file_changed',
        'File change',
        `${item.changes?.length ?? 0} file change(s), status=${JSON.stringify(item.status)}`,
        turn.completedAt ?? turn.startedAt,
        { ...basePayload, status: item.status, changes: item.changes }
      );
    case 'mcpToolCall':
      return createThreadTimelineEvent(
        threadId,
        'tool_call',
        `MCP tool: ${item.server}/${item.tool}`,
        `Status: ${JSON.stringify(item.status)}`,
        turn.completedAt ?? turn.startedAt,
        { ...basePayload, server: item.server, tool: item.tool, status: item.status }
      );
    case 'dynamicToolCall':
      return createThreadTimelineEvent(
        threadId,
        'tool_call',
        `Tool: ${item.namespace ? `${item.namespace}/` : ''}${item.tool}`,
        `Status: ${JSON.stringify(item.status)}`,
        turn.completedAt ?? turn.startedAt,
        { ...basePayload, namespace: item.namespace, tool: item.tool, status: item.status, success: item.success }
      );
    default:
      return createThreadTimelineEvent(
        threadId,
        item.type,
        `Item: ${item.type}`,
        `Codex item ${item.type} completed.`,
        turn.completedAt ?? turn.startedAt,
        basePayload
      );
  }
}

function createThreadTimelineEvent(sessionId, type, title, summary, timestampSeconds, payload) {
  return {
    event_id: `${sessionId}:${payload.turn_id ?? 'thread'}:${payload.item_id ?? type}`,
    session_id: sessionId,
    created_at: timestampSeconds ? new Date(timestampSeconds * 1000).toISOString() : new Date().toISOString(),
    type,
    title,
    summary: summary || title,
    payload,
    redaction_level: 'none'
  };
}

function summarizeUserInput(content) {
  return truncate((content ?? []).map((item) => {
    if (item.type === 'text') {
      return item.text;
    }

    if (item.path) {
      return `[${item.type}: ${item.path}]`;
    }

    if (item.url) {
      return `[${item.type}: ${item.url}]`;
    }

    return `[${item.type}]`;
  }).join('\n'));
}

function truncate(text, maxLength = 500) {
  if (!text) {
    return '';
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function resolveCodexCli() {
  if (process.env.CODEX_CLI_PATH) {
    return process.env.CODEX_CLI_PATH;
  }

  const userProfile = process.env.USERPROFILE;
  const candidates = [
    userProfile
      ? `${userProfile}\\.vscode\\extensions\\openai.chatgpt-26.506.21252-win32-x64\\bin\\windows-x86_64\\codex.exe`
      : null,
    'codex'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'codex' || existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('Unable to find Codex CLI. Set CODEX_CLI_PATH.');
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
