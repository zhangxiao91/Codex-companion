import { spawn } from 'node:child_process';

const gitWriteActionsEnabled = process.env.GIT_WRITE_ACTIONS_ENABLED === 'true';

export async function handleGitRequest(session, request) {
  const action = request.action;
  const repoPath = session.repo_path || process.cwd();

  if (action === 'status' || action === 'diff') {
    return createSnapshot(session, action, await readGitSnapshot(repoPath));
  }

  if (action === 'commit') {
    if (!gitWriteActionsEnabled) {
      return createSnapshot(session, action, await readGitSnapshot(repoPath), {
        ok: false,
        message: 'Git commit is disabled. Set GIT_WRITE_ACTIONS_ENABLED=true on Host Bridge to enable it.'
      });
    }

    const message = typeof request.message === 'string' ? request.message.trim() : '';
    if (!message) {
      return createSnapshot(session, action, await readGitSnapshot(repoPath), {
        ok: false,
        message: 'Commit message is required.'
      });
    }

    const commit = await runGit(repoPath, ['commit', '-am', message]);
    return createSnapshot(session, action, await readGitSnapshot(repoPath), {
      ok: commit.exitCode === 0,
      message: commit.output.trim() || commit.error.trim()
    });
  }

  if (action === 'push') {
    if (!gitWriteActionsEnabled) {
      return createSnapshot(session, action, await readGitSnapshot(repoPath), {
        ok: false,
        message: 'Git push is disabled. Set GIT_WRITE_ACTIONS_ENABLED=true on Host Bridge to enable it.'
      });
    }

    const push = await runGit(repoPath, ['push']);
    return createSnapshot(session, action, await readGitSnapshot(repoPath), {
      ok: push.exitCode === 0,
      message: push.output.trim() || push.error.trim()
    });
  }

  return createSnapshot(session, action, await readGitSnapshot(repoPath), {
    ok: false,
    message: `Unsupported git action: ${action}`
  });
}

async function readGitSnapshot(repoPath) {
  const [status, diffStat, changedFiles, branch] = await Promise.all([
    runGit(repoPath, ['status', '--porcelain=v1', '-b']),
    runGit(repoPath, ['diff', '--stat']),
    runGit(repoPath, ['diff', '--name-only']),
    runGit(repoPath, ['branch', '--show-current'])
  ]);

  const statusLines = status.output.split(/\r?\n/).filter(Boolean);
  const files = statusLines
    .filter((line) => !line.startsWith('## '))
    .map(parsePorcelainLine);

  return {
    repo_path: repoPath,
    branch: branch.output.trim() || parseBranch(statusLines[0]) || 'unknown',
    is_git_repo: status.exitCode === 0,
    status_summary: summarizeFiles(files),
    files,
    diff_stat: diffStat.output.trim(),
    changed_files: changedFiles.output.split(/\r?\n/).filter(Boolean),
    error: status.exitCode === 0 ? '' : (status.error || status.output).trim()
  };
}

function createSnapshot(session, action, git, result = { ok: true, message: '' }) {
  return {
    session_id: session.session_id,
    host_id: session.host_id,
    action,
    repo_path: git.repo_path,
    branch: git.branch,
    is_git_repo: git.is_git_repo,
    status_summary: git.status_summary,
    files: git.files,
    diff_stat: git.diff_stat,
    changed_files: git.changed_files,
    result,
    error: git.error,
    updated_at: new Date().toISOString()
  };
}

function parsePorcelainLine(line) {
  return {
    index_status: line.slice(0, 1).trim(),
    worktree_status: line.slice(1, 2).trim(),
    path: line.slice(3).trim()
  };
}

function summarizeFiles(files) {
  if (files.length === 0) {
    return 'clean';
  }

  const counts = files.reduce((accumulator, file) => {
    const status = file.worktree_status || file.index_status || 'unknown';
    accumulator[status] = (accumulator[status] ?? 0) + 1;
    return accumulator;
  }, {});

  return Object.entries(counts)
    .map(([status, count]) => `${status}:${count}`)
    .join(', ');
}

function parseBranch(line = '') {
  return line.startsWith('## ') ? line.slice(3).split('...')[0] : '';
}

function runGit(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    let error = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      error += chunk.toString();
    });
    child.on('error', (spawnError) => {
      resolve({
        exitCode: 1,
        output,
        error: spawnError.message
      });
    });
    child.on('close', (exitCode) => {
      resolve({
        exitCode,
        output,
        error
      });
    });
  });
}
