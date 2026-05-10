import assert from 'node:assert/strict';
import {
  AppServerCodexAdapter,
  createAppServerApprovalResponse,
  mapAppServerApprovalRequest
} from '../bridge/host-bridge/codex-adapter.mjs';

const commandRequest = {
  id: 'req-command',
  method: 'item/commandExecution/requestApproval',
  params: {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    startedAtMs: 1710000000000,
    approvalId: 'approval-command',
    reason: 'Need to run tests.',
    command: 'npm test',
    cwd: '/repo',
    availableDecisions: ['accept', 'acceptForSession', 'decline']
  }
};

const commandApproval = mapAppServerApprovalRequest(commandRequest);
assert.equal(commandApproval.approval_id, 'approval-command');
assert.equal(commandApproval.session_id, 'thread-1');
assert.equal(commandApproval.kind, 'shell');
assert.equal(commandApproval.command, 'npm test');
assert.deepEqual(commandApproval.allowed_decisions, ['approve_once', 'approve_session', 'deny']);

assert.deepEqual(
  createAppServerApprovalResponse(commandRequest.method, commandRequest.params, 'approve_once'),
  { decision: 'accept' }
);
assert.deepEqual(
  createAppServerApprovalResponse(commandRequest.method, commandRequest.params, 'approve_session'),
  { decision: 'acceptForSession' }
);
assert.deepEqual(
  createAppServerApprovalResponse(commandRequest.method, commandRequest.params, 'deny'),
  { decision: 'decline' }
);

const fileRequest = {
  id: 'req-file',
  method: 'item/fileChange/requestApproval',
  params: {
    threadId: 'thread-2',
    turnId: 'turn-2',
    itemId: 'item-2',
    startedAtMs: 1710000000001,
    reason: 'Need to edit files.',
    grantRoot: '/repo'
  }
};

const fileApproval = mapAppServerApprovalRequest(fileRequest);
assert.equal(fileApproval.kind, 'file_write');
assert.equal(fileApproval.command, '/repo');
assert.deepEqual(
  createAppServerApprovalResponse(fileRequest.method, fileRequest.params, 'approve_session'),
  { decision: 'acceptForSession' }
);

const permissionsRequest = {
  id: 'req-permissions',
  method: 'item/permissions/requestApproval',
  params: {
    threadId: 'thread-3',
    turnId: 'turn-3',
    itemId: 'item-3',
    startedAtMs: 1710000000002,
    cwd: '/repo',
    reason: 'Need network.',
    permissions: {
      network: { domains: ['example.com'] },
      fileSystem: null
    }
  }
};

const permissionsApproval = mapAppServerApprovalRequest(permissionsRequest);
assert.equal(permissionsApproval.kind, 'permissions');
assert.equal(permissionsApproval.risk_level, 'high');
assert.deepEqual(
  createAppServerApprovalResponse(permissionsRequest.method, permissionsRequest.params, 'approve_once'),
  {
    permissions: {
      network: { domains: ['example.com'] }
    },
    scope: 'turn',
    strictAutoReview: false
  }
);

const legacyExecRequest = {
  id: 'req-exec',
  method: 'execCommandApproval',
  params: {
    conversationId: 'thread-4',
    callId: 'call-4',
    approvalId: null,
    command: ['npm', 'run', 'build'],
    cwd: '/repo',
    reason: null,
    parsedCmd: []
  }
};

const legacyExecApproval = mapAppServerApprovalRequest(legacyExecRequest);
assert.equal(legacyExecApproval.session_id, 'thread-4');
assert.equal(legacyExecApproval.command, 'npm run build');
assert.deepEqual(
  createAppServerApprovalResponse(legacyExecRequest.method, legacyExecRequest.params, 'deny'),
  { decision: 'denied' }
);

const emittedApprovals = [];
const sentMessages = [];
const adapter = new AppServerCodexAdapter('host-for-approval-test', {
  onApprovalRequest: (approval) => emittedApprovals.push(approval),
  codexCli: 'unused'
});
adapter.socket = {
  send: (raw) => sentMessages.push(JSON.parse(raw))
};

adapter.handleMessage(JSON.stringify(commandRequest));
assert.equal(emittedApprovals.length, 1);
assert.equal(emittedApprovals[0].approval_id, 'approval-command');

const timelineMessage = await adapter.resolveApproval({
  approval_id: 'approval-command',
  decision: 'approve_once'
});
assert.equal(sentMessages.length, 1);
assert.deepEqual(sentMessages[0], {
  id: 'req-command',
  result: {
    decision: 'accept'
  }
});
assert.equal(timelineMessage.payload.event.type, 'approval_resolved');

console.log('[verify] App Server approval mapper verified.');
