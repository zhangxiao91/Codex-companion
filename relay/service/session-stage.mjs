export function deriveSessionStage(session, timelineEvents = [], approvals = [], gitSnapshots = []) {
  const now = new Date().toISOString();
  const pendingApproval = approvals
    .filter((approval) => approval.session_id === session.session_id && (approval.status ?? 'pending') === 'pending')
    .sort((a, b) => parseIsoMillis(b.updated_at ?? b.requested_at) - parseIsoMillis(a.updated_at ?? a.requested_at))[0];

  if (pendingApproval) {
    return createSessionStage(
      'waiting_approval',
      'Waiting approval',
      pendingApproval.summary || pendingApproval.title || 'Codex is waiting for your approval.',
      'warning',
      pendingApproval.updated_at ?? pendingApproval.requested_at ?? now
    );
  }

  const recentEvents = [...timelineEvents]
    .filter((event) => event.session_id === session.session_id)
    .sort((a, b) => parseIsoMillis(b.created_at) - parseIsoMillis(a.created_at));
  const latestGitSnapshot = [...gitSnapshots]
    .filter((snapshot) => snapshot.session_id === session.session_id)
    .sort((a, b) => parseIsoMillis(b.updated_at) - parseIsoMillis(a.updated_at))[0];
  const latestEvent = recentEvents[0];
  const completedTurns = recentEvents.filter((event) => event.type === 'turn_completed');
  const latestCompletedTurn = completedTurns[0];
  const latestCompletedAt = parseIsoMillis(latestCompletedTurn?.created_at);
  const completedTurnTimes = new Map();
  for (const event of completedTurns) {
    const turnId = eventTurnId(event);
    if (!turnId) {
      continue;
    }
    completedTurnTimes.set(turnId, Math.max(completedTurnTimes.get(turnId) ?? 0, parseIsoMillis(event.created_at)));
  }
  const failedEvent = recentEvents.find((event) => isFailureEvent(event));

  if ((failedEvent && isEventOpen(failedEvent, completedTurnTimes, latestCompletedAt)) || latestGitSnapshot?.result?.ok === false || latestGitSnapshot?.error) {
    return createSessionStage(
      'tests_failed',
      'Needs attention',
      cleanStageSummary(failedEvent?.summary || latestGitSnapshot?.result?.message || latestGitSnapshot?.error || 'Codex hit a failure that needs review.'),
      'danger',
      failedEvent?.created_at ?? latestGitSnapshot?.updated_at ?? session.updated_at ?? now
    );
  }

  const runningCommand = recentEvents.find((event) => event.type === 'command_execution' && isActiveTimelineEvent(event) && isEventOpen(event, completedTurnTimes, latestCompletedAt));
  if (runningCommand) {
    return createSessionStage(
      'running_command',
      'Running command',
      cleanStageSummary(runningCommand.summary || runningCommand.title || 'Codex is running a command.'),
      'active',
      runningCommand.created_at ?? now
    );
  }

  const editingFiles = recentEvents.find((event) => (event.type === 'file_changed' || event.type === 'diff_update') && isEventOpen(event, completedTurnTimes, latestCompletedAt));
  if (editingFiles) {
    return createSessionStage(
      'editing_files',
      'Editing files',
      cleanStageSummary(editingFiles.summary || 'Codex is updating files.'),
      'active',
      editingFiles.created_at ?? now
    );
  }

  const thinking = recentEvents.find((event) => isThinkingEvent(event) && isEventOpen(event, completedTurnTimes, latestCompletedAt));
  if (thinking) {
    return createSessionStage(
      'thinking',
      'Thinking',
      cleanStageSummary(thinking.summary || 'Codex is reasoning through the task.'),
      'active',
      thinking.created_at ?? now
    );
  }

  if (session.status === 'completed' || latestCompletedTurn) {
    return createSessionStage(
      'completed',
      'Completed',
      cleanStageSummary(latestCompletedTurn?.summary || session.summary || 'Codex has completed the latest turn.'),
      'success',
      latestCompletedTurn?.created_at ?? session.updated_at ?? now
    );
  }

  if (session.status === 'waiting_for_input') {
    return createSessionStage(
      'needs_user',
      'Needs input',
      cleanStageSummary(session.summary || latestEvent?.summary || 'Codex is waiting for your next instruction.'),
      'warning',
      session.updated_at ?? latestEvent?.created_at ?? now
    );
  }

  return createSessionStage(
    'idle',
    'Idle',
    cleanStageSummary(session.summary || latestEvent?.summary || 'No active Codex work is running.'),
    'neutral',
    session.updated_at ?? latestEvent?.created_at ?? now
  );
}

function createSessionStage(type, label, summary, severity, updatedAt) {
  return {
    type,
    label,
    summary: cleanStageSummary(summary),
    severity,
    updated_at: updatedAt || new Date().toISOString()
  };
}

function isActiveTimelineEvent(event) {
  const text = `${event.type} ${event.title} ${event.summary}`.toLowerCase();
  return text.includes('running')
    || text.includes('started')
    || text.includes('pending')
    || text.includes('in_progress')
    || text.includes('in-progress');
}

function isThinkingEvent(event) {
  return event.type === 'plan_update'
    || event.type === 'reasoning_summary'
    || event.type === 'assistant_delta'
    || event.type === 'turn_started';
}

function isEventOpen(event, completedTurnTimes, latestCompletedAt) {
  const eventTime = parseIsoMillis(event.created_at);
  const turnId = eventTurnId(event);
  if (turnId && completedTurnTimes.has(turnId)) {
    return eventTime > completedTurnTimes.get(turnId);
  }
  if (!turnId && latestCompletedAt > 0) {
    return eventTime > latestCompletedAt;
  }
  return true;
}

function eventTurnId(event) {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  return payload.turn_id ?? payload.turnId ?? event.turn_id ?? event.turnId ?? '';
}

function isFailureEvent(event) {
  const text = `${event.type} ${event.title} ${event.summary}`.toLowerCase();
  return event.type === 'error'
    || text.includes('test failed')
    || text.includes('tests failed')
    || text.includes('failed test')
    || text.includes('exit code 1')
    || text.includes('result=false')
    || text.includes('result=blocked');
}

function cleanStageSummary(summary) {
  const text = String(summary ?? '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  return text.length > 140 ? `${text.slice(0, 137).trimEnd()}...` : text;
}

function parseIsoMillis(raw) {
  if (!raw) {
    return 0;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}
