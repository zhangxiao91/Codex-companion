import { strict as assert } from 'node:assert';
import { AppServerCodexAdapter } from '../bridge/host-bridge/codex-adapter.mjs';

const originalApprovalPolicy = process.env.CODEX_APPROVAL_POLICY;
const originalApprovalsReviewer = process.env.CODEX_APPROVALS_REVIEWER;

try {
  delete process.env.CODEX_APPROVAL_POLICY;
  delete process.env.CODEX_APPROVALS_REVIEWER;

  const adapter = new AppServerCodexAdapter('verify-host');
  assert.equal(adapter.approvalPolicy, 'on-request');
  assert.equal(adapter.approvalsReviewer, 'user');

  process.env.CODEX_APPROVAL_POLICY = 'never';
  process.env.CODEX_APPROVALS_REVIEWER = 'auto_review';

  const overridden = new AppServerCodexAdapter('verify-host');
  assert.equal(overridden.approvalPolicy, 'never');
  assert.equal(overridden.approvalsReviewer, 'auto_review');

  console.log('[verify] App Server security defaults verified.');
} finally {
  restoreEnv('CODEX_APPROVAL_POLICY', originalApprovalPolicy);
  restoreEnv('CODEX_APPROVALS_REVIEWER', originalApprovalsReviewer);
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
