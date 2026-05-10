export function mapThreadToTimelineEvents(thread, options = {}) {
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

export function mapAppServerNotificationToTimelineEvents(message) {
  const { method, params } = message;

  switch (method) {
    case 'thread/status/changed':
      return [
        createLiveTimelineEvent(
          params.threadId,
          'thread_status_changed',
          'Thread status changed',
          `Status: ${params.status?.type ?? 'unknown'}`,
          { status: params.status }
        )
      ];
    case 'turn/started':
      return [
        createLiveTimelineEvent(
          params.threadId,
          'turn_started',
          'Turn started',
          `Turn ${params.turn.id} started.`,
          { turn_id: params.turn.id, status: params.turn.status }
        )
      ];
    case 'turn/completed':
      return [
        createLiveTimelineEvent(
          params.threadId,
          'turn_completed',
          'Turn completed',
          `Turn ${params.turn.id} completed.`,
          { turn_id: params.turn.id, status: params.turn.status, duration_ms: params.turn.durationMs }
        )
      ];
    case 'turn/plan/updated':
      return [
        createLiveTimelineEvent(
          params.threadId,
          'plan_update',
          'Plan update',
          summarizePlan(params),
          { turn_id: params.turnId, plan: params.plan, explanation: params.explanation }
        )
      ];
    case 'turn/diff/updated':
      return [
        createLiveTimelineEvent(
          params.threadId,
          'diff_update',
          'Diff updated',
          truncate(params.diff),
          { turn_id: params.turnId, diff: params.diff }
        )
      ];
    case 'item/started':
    case 'item/completed': {
      const turn = {
        id: params.turnId,
        startedAt: params.startedAtMs ? params.startedAtMs / 1000 : undefined,
        completedAt: params.completedAtMs ? params.completedAtMs / 1000 : undefined
      };
      const event = mapThreadItemToTimelineEvent(params.threadId, turn, params.item);
      return event ? [event] : [];
    }
    case 'item/agentMessage/delta':
      return [
        createLiveTimelineEvent(
          params.threadId,
          'assistant_delta',
          'Assistant message delta',
          truncate(params.delta),
          { turn_id: params.turnId, item_id: params.itemId, delta: params.delta }
        )
      ];
    case 'item/commandExecution/outputDelta':
      return [
        createLiveTimelineEvent(
          params.threadId,
          'command_output_delta',
          'Command output',
          truncate(params.delta),
          { turn_id: params.turnId, item_id: params.itemId, delta: params.delta }
        )
      ];
    case 'item/fileChange/patchUpdated':
      return [
        createLiveTimelineEvent(
          params.threadId,
          'file_changed',
          'File patch updated',
          `${params.changes?.length ?? 0} file change(s).`,
          { turn_id: params.turnId, item_id: params.itemId, changes: params.changes }
        )
      ];
    case 'serverRequest/resolved':
      return [
        createLiveTimelineEvent(
          params.threadId,
          'request_resolved',
          'Request resolved',
          `Request ${params.requestId} resolved.`,
          { request_id: params.requestId }
        )
      ];
    case 'error':
      return [
        createLiveTimelineEvent(
          params.threadId,
          'error',
          'Codex error',
          truncate(params.error?.message ?? JSON.stringify(params.error)),
          { turn_id: params.turnId, error: params.error, will_retry: params.willRetry }
        )
      ];
    default:
      return [];
  }
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

function createLiveTimelineEvent(sessionId, type, title, summary, payload) {
  return createThreadTimelineEvent(
    sessionId,
    type,
    title,
    summary,
    Date.now() / 1000,
    payload
  );
}

function createThreadTimelineEvent(sessionId, type, title, summary, timestampSeconds, payload) {
  return {
    event_id: `${sessionId}:${payload.turn_id ?? 'thread'}:${payload.item_id ?? type}:${type}`,
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

function summarizePlan(params) {
  const statuses = (params.plan ?? []).map((step) => `${step.status ?? 'unknown'}: ${step.step ?? ''}`);
  return truncate([params.explanation, ...statuses].filter(Boolean).join('\n'));
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

