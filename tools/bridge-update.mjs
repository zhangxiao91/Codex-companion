import { spawnSync } from 'node:child_process';
import {
  DEFAULT_WINDOWS_BRIDGE_TASK_NAME
} from './windows-host-bridge-service.mjs';
import {
  ensureCleanWorktree,
  installDependencies,
  parseUpdateArgs,
  runNodeChecks,
  runStep,
  updateRepository
} from './update-common.mjs';

const options = parseUpdateArgs();
const taskName = process.env.CMC_WINDOWS_BRIDGE_TASK_NAME ?? DEFAULT_WINDOWS_BRIDGE_TASK_NAME;

console.log('[bridge:update] Updating Host Bridge deployment.');
if (options.dryRun) {
  console.log('[bridge:update] Dry run: no git, npm, or process changes will be made.');
}

ensureCleanWorktree({ allowDirty: options.allowDirty || options.dryRun });
updateRepository(options);
installDependencies(options);
runNodeChecks([
  'bridge/host-bridge/index.mjs',
  'bridge/host-bridge/codex-adapter.mjs',
  'tools/windows-host-bridge-run.mjs',
  'tools/windows-host-bridge-service.mjs'
], options);
restartWindowsBridge(options);

console.log('[bridge:update] Done.');

function restartWindowsBridge(updateOptions) {
  if (updateOptions.skipRestart) {
    console.log('[bridge:update] Restart skipped.');
    return;
  }

  if (process.platform !== 'win32') {
    console.warn('[bridge:update] Windows Scheduled Task restart is only available on Windows.');
    console.warn('[bridge:update] Start the bridge manually with npm run connect.');
    return;
  }

  if (updateOptions.dryRun) {
    console.log(`[bridge:update] dry-run: schtasks.exe /End /TN ${taskName}`);
    console.log('[bridge:update] dry-run: node tools/windows-host-bridge-service.mjs start');
    return;
  }

  console.log(`[bridge:update] Stopping scheduled task if it is running: ${taskName}`);
  const stop = spawnSync('schtasks.exe', ['/End', '/TN', taskName], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit'
  });
  if (stop.status !== 0) {
    console.warn('[bridge:update] Scheduled task was not running or could not be stopped; continuing with start.');
  }

  runStep('start Windows Host Bridge task', 'node', ['tools/windows-host-bridge-service.mjs', 'start'], updateOptions);
}

