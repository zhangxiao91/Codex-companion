import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  commandExists,
  ensureCleanWorktree,
  installDependencies,
  parseUpdateArgs,
  runNodeChecks,
  shellQuote,
  updateRepository
} from './update-common.mjs';

const options = parseUpdateArgs();
const screenName = process.env.CMC_SERVER_RELAY_SCREEN_NAME ?? 'codex-companion-relay';
const logPath = process.env.CMC_SERVER_RELAY_LOG_PATH ?? '.relay/server-relay-screen.log';

console.log('[server:update] Updating server Relay deployment.');
if (options.dryRun) {
  console.log('[server:update] Dry run: no git, npm, or process changes will be made.');
}

ensureCleanWorktree({ allowDirty: options.allowDirty || options.dryRun });
updateRepository(options);
installDependencies(options);
runNodeChecks([
  'relay/service/server.mjs',
  'tools/server-relay-start.mjs',
  'tools/server-relay-config.mjs'
], options);
await restartServerRelay(options);

console.log('[server:update] Done.');

async function restartServerRelay(updateOptions) {
  if (updateOptions.skipRestart) {
    console.log('[server:update] Restart skipped.');
    return;
  }

  if (process.platform === 'win32') {
    console.warn('[server:update] Screen restart is intended for Linux servers. Start Relay with npm run server:up.');
    return;
  }

  if (!commandExists('screen')) {
    console.warn('[server:update] screen is not installed. Start Relay manually with npm run server:up.');
    return;
  }

  const startCommand = `cd ${shellQuote(process.cwd())} && mkdir -p ${shellQuote(dirnameForShell(logPath))} && npm run server:up >> ${shellQuote(logPath)} 2>&1`;
  if (updateOptions.dryRun) {
    console.log(`[server:update] dry-run: screen -S ${screenName} -X quit`);
    console.log(`[server:update] dry-run: screen -dmS ${screenName} bash -lc ${JSON.stringify(startCommand)}`);
    return;
  }

  console.log(`[server:update] Restarting screen session: ${screenName}`);
  spawnSync('screen', ['-S', screenName, '-X', 'quit'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'ignore'
  });
  await delay(750);
  const result = spawnSync('screen', ['-dmS', screenName, 'bash', '-lc', startCommand], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    throw new Error(`screen restart failed with exit code ${result.status}`);
  }
  console.log(`[server:update] Relay started in screen session ${screenName}. Log: ${logPath}`);
}

function dirnameForShell(path) {
  const normalized = String(path).replaceAll('\\', '/');
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : '.';
}

