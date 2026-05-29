import { spawnSync } from 'node:child_process';

export function parseUpdateArgs(argv = process.argv.slice(2)) {
  return {
    dryRun: argv.includes('--dry-run'),
    skipRestart: argv.includes('--skip-restart') || process.env.CMC_UPDATE_SKIP_RESTART === '1',
    allowDirty: argv.includes('--allow-dirty') || process.env.CMC_UPDATE_ALLOW_DIRTY === '1'
  };
}

export function ensureCleanWorktree(options = {}) {
  const status = commandOutput('git', ['status', '--porcelain']);
  if (!status.trim()) {
    return;
  }

  if (options.allowDirty) {
    console.warn('[update] Worktree has local changes; continuing because dirty mode is allowed.');
    return;
  }

  throw new Error([
    'Refusing to update with local changes in the worktree.',
    'Commit/stash them first, or pass --allow-dirty if you intentionally want to keep them.',
    status.trim()
  ].join('\n'));
}

export function currentBranch() {
  return commandOutput('git', ['branch', '--show-current']).trim() || 'HEAD';
}

export function updateRepository(options = {}) {
  const branch = currentBranch();
  console.log(`[update] Branch: ${branch}`);
  runStep('git fetch --prune', 'git', ['fetch', '--prune'], options);
  runStep('git pull --ff-only', 'git', ['pull', '--ff-only'], options);
}

export function installDependencies(options = {}) {
  runStep('npm ci', npmCommand(), ['ci'], options);
}

export function runNodeChecks(files, options = {}) {
  for (const file of files) {
    runStep(`node --check ${file}`, 'node', ['--check', file], options);
  }
}

export function commandExists(command) {
  const checker = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [command] : ['-v', command];
  const result = process.platform === 'win32'
    ? spawnSync(checker, args, { stdio: 'ignore' })
    : spawnSync('sh', ['-lc', `${checker} ${shellQuote(command)}`], { stdio: 'ignore' });
  return result.status === 0;
}

export function runStep(label, command, args, options = {}) {
  console.log(`[update] ${label}`);
  if (options.dryRun) {
    console.log(`[update] dry-run: ${command} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`);
    return;
  }

  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    shell: false
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

export function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}
