import { spawn } from 'node:child_process';

const gitWriteActionsEnabled = process.env.GIT_WRITE_ACTIONS_ENABLED === 'true';
const maxFileDiffBytes = Number.parseInt(process.env.GIT_FILE_DIFF_MAX_BYTES ?? '20000', 10);

export async function handleGitRequest(session, request) {
  const action = request.action;
  const repoPath = session.repo_path || process.cwd();
  const auditId = typeof request.audit_id === 'string' ? request.audit_id : '';

  if (action === 'status') {
    return createSnapshot(session, action, await readGitSnapshot(repoPath), undefined, undefined, auditId);
  }

  if (action === 'diff') {
    const filePath = normalizeRelativePath(request.file_path);
    const fileDiff = filePath ? await readFileDiff(repoPath, filePath) : undefined;
    return createSnapshot(session, action, await readGitSnapshot(repoPath), undefined, fileDiff, auditId);
  }

  if (action === 'commit') {
    if (!gitWriteActionsEnabled) {
      return createSnapshot(session, action, await readGitSnapshot(repoPath), {
        ok: false,
        message: 'Git commit is disabled. Set GIT_WRITE_ACTIONS_ENABLED=true on Host Bridge to enable it.'
      }, undefined, auditId);
    }

    const message = typeof request.message === 'string' ? request.message.trim() : '';
    if (!message) {
      return createSnapshot(session, action, await readGitSnapshot(repoPath), {
        ok: false,
        message: 'Commit message is required.'
      }, undefined, auditId);
    }

    const commit = await runGit(repoPath, ['commit', '-am', message]);
    return createSnapshot(session, action, await readGitSnapshot(repoPath), {
      ok: commit.exitCode === 0,
      message: commit.output.trim() || commit.error.trim()
    }, undefined, auditId);
  }

  if (action === 'push') {
    if (!gitWriteActionsEnabled) {
      return createSnapshot(session, action, await readGitSnapshot(repoPath), {
        ok: false,
        message: 'Git push is disabled. Set GIT_WRITE_ACTIONS_ENABLED=true on Host Bridge to enable it.'
      }, undefined, auditId);
    }

    const push = await runGit(repoPath, ['push']);
    return createSnapshot(session, action, await readGitSnapshot(repoPath), {
      ok: push.exitCode === 0,
      message: push.output.trim() || push.error.trim()
    }, undefined, auditId);
  }

  return createSnapshot(session, action, await readGitSnapshot(repoPath), {
    ok: false,
    message: `Unsupported git action: ${action}`
  }, undefined, auditId);
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

function createSnapshot(session, action, git, result = { ok: true, message: '' }, fileDiff = undefined, auditId = '') {
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
    selected_file_path: fileDiff?.file_path ?? '',
    selected_file_diff: fileDiff?.diff ?? '',
    selected_file_diff_truncated: fileDiff?.truncated ?? false,
    audit_id: auditId,
    result,
    error: git.error,
    updated_at: new Date().toISOString()
  };
}

async function readFileDiff(repoPath, filePath) {
  const diff = await runGit(repoPath, ['diff', 'HEAD', '--', filePath]);
  const raw = diff.output || diff.error;
  return {
    file_path: filePath,
    diff: truncateText(raw, maxFileDiffBytes),
    truncated: Buffer.byteLength(raw, 'utf8') > maxFileDiffBytes
  };
}

function normalizeRelativePath(filePath) {
  if (typeof filePath !== 'string') {
    return '';
  }

  const normalized = filePath.trim().replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('../') || normalized === '..') {
    return '';
  }

  return normalized;
}

function truncateText(text, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return text;
  }

  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }

  let output = '';
  for (const character of text) {
    if (Buffer.byteLength(output + character, 'utf8') > maxBytes) {
      break;
    }
    output += character;
  }

  return `${output}\n[diff truncated]`;
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
