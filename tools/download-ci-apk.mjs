import { existsSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { commandExists, commandOutput, runStep } from './update-common.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const branch = optionValue('--branch') ?? currentBranch();
const runId = optionValue('--run');
const dest = resolve(optionValue('--dest') ?? '.relay/artifacts/latest-apk');
const workflow = optionValue('--workflow') ?? 'CI';
const artifactName = optionValue('--artifact') ?? 'codex-mobile-companion-debug-apk';

console.log('[artifact] Downloading Android APK artifact.');
console.log(`[artifact] Workflow: ${workflow}`);
console.log(`[artifact] Branch: ${branch}`);
console.log(`[artifact] Artifact: ${artifactName}`);
console.log(`[artifact] Destination: ${dest}`);

if (!commandExists('gh')) {
  if (dryRun && runId) {
    console.warn('[artifact] GitHub CLI is not installed; continuing dry-run because --run was provided.');
  } else {
    throw new Error('GitHub CLI is required. Install gh and run `gh auth login` first.');
  }
}

const selectedRunId = runId ?? await latestSuccessfulRunId({ workflow, branch });
if (!selectedRunId) {
  throw new Error(`No successful ${workflow} run found for branch ${branch}.`);
}

console.log(`[artifact] Run ID: ${selectedRunId}`);
if (dryRun) {
  console.log(`[artifact] dry-run: gh run download ${selectedRunId} --name ${artifactName} --dir ${dest}`);
  process.exit(0);
}

await mkdir(dest, { recursive: true });
runStep(
  `gh run download ${selectedRunId}`,
  'gh',
  ['run', 'download', String(selectedRunId), '--name', artifactName, '--dir', dest]
);

const apkFiles = findApks(dest);
if (apkFiles.length === 0) {
  throw new Error(`Artifact downloaded but no APK was found under ${dest}.`);
}

console.log('[artifact] APK file(s):');
for (const file of apkFiles) {
  console.log(`- ${file}`);
}

async function latestSuccessfulRunId(options) {
  const result = spawnSync('gh', [
    'run',
    'list',
    '--workflow',
    options.workflow,
    '--branch',
    options.branch,
    '--limit',
    '20',
    '--json',
    'databaseId,conclusion,status,headSha,createdAt'
  ], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0) {
    throw new Error(`gh run list failed:\n${result.stderr || result.stdout}`);
  }

  const runs = JSON.parse(result.stdout || '[]');
  const successful = runs.find((run) => run.conclusion === 'success' && run.status === 'completed');
  return successful?.databaseId ? String(successful.databaseId) : '';
}

function optionValue(name) {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) {
    return args[index + 1];
  }

  const prefix = `${name}=`;
  const matched = args.find((arg) => arg.startsWith(prefix));
  return matched ? matched.slice(prefix.length) : undefined;
}

function currentBranch() {
  return commandOutput('git', ['branch', '--show-current']).trim() || 'master';
}

function findApks(root) {
  if (!existsSync(root)) {
    return [];
  }

  const result = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile() && entry.name.endsWith('.apk')) {
        result.push(path);
      }
    }
  }
  return result.sort();
}
