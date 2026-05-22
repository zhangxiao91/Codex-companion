import assert from 'node:assert/strict';
import { deriveSessionStage } from '../relay/service/session-stage.mjs';

const baseSession = {
  session_id: 'stage-session',
  host_id: 'stage-host',
  project_name: 'Stage Project',
  repo_path: '',
  branch: 'main',
  status: 'running',
  summary: 'Working',
  updated_at: '2026-05-22T08:00:00.000Z'
};

assert.equal(stage({
  approvals: [{ approval_id: 'a1', session_id: 'stage-session', status: 'pending', title: 'Approve command', updated_at: '2026-05-22T08:01:00.000Z' }]
}).type, 'waiting_approval');

assert.equal(stage({
  events: [event('command_execution', 'Command running', 'npm test started')]
}).type, 'running_command');

assert.equal(stage({
  events: [event('file_changed', 'File patch updated', '2 file change(s).')]
}).type, 'editing_files');

assert.equal(stage({
  events: [event('error', 'Codex error', 'tests failed')]
}).type, 'tests_failed');

assert.equal(stage({
  session: { ...baseSession, status: 'waiting_for_input' }
}).type, 'needs_user');

assert.equal(stage({
  session: { ...baseSession, status: 'completed' },
  events: [
    event('file_changed', 'File patch updated', '1 file change(s).', '2026-05-22T08:01:00.000Z'),
    event('turn_completed', 'Turn completed', 'Turn completed.', '2026-05-22T08:02:00.000Z')
  ]
}).type, 'completed');

console.log('[verify] Session stage derivation verified.');

function stage({ session = baseSession, events = [], approvals = [], gitSnapshots = [] }) {
  return deriveSessionStage(session, events, approvals, gitSnapshots);
}

function event(type, title, summary, createdAt = '2026-05-22T08:01:00.000Z') {
  return {
    event_id: `${type}-${createdAt}`,
    session_id: 'stage-session',
    type,
    title,
    summary,
    created_at: createdAt
  };
}
