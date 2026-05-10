import { spawn } from 'node:child_process';

const gitWriteActionsEnabled = process.env.GIT_WRITE_ACTIONS_ENABLED === 'true';
const gitPushActionsEnabled = process.env.GIT_PUSH_ACTIONS_ENABLED === 'true';
const maxFileDiffBytes = Number.parseInt(process.env.GIT_FILE_DIFF_MAX_BYTES ?? '20000', 10);
const CommitStrategy = Object.freeze({
  TrackedOnly: 'tracked_only',
  IncludeUntracked: 'include_untracked'
});

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
    const preCommitSnapshot = await readGitSnapshot(repoPath);
    const commitStrategy = normalizeCommitStrategy(request.commit_strategy);
    if (!gitWriteActionsEnabled) {
      return createSnapshot(session, action, preCommitSnapshot, {
        ok: false,
        message: commitPolicyMessage('Git commit is disabled. Set GIT_WRITE_ACTIONS_ENABLED=true on Host Bridge to enable it.', preCommitSnapshot, commitStrategy)
      }, undefined, auditId, commitStrategy);
    }

    const message = typeof request.message === 'string' ? request.message.trim() : '';
    if (!message) {
      return createSnapshot(session, action, preCommitSnapshot, {
        ok: false,
        message: commitPolicyMessage('Commit message is required.', preCommitSnapshot, commitStrategy)
      }, undefined, auditId, commitStrategy);
    }

    const stage = commitStrategy === CommitStrategy.IncludeUntracked
      ? await runGit(repoPath, ['add', '-A'])
      : { exitCode: 0, output: '', error: '' };
    if (stage.exitCode !== 0) {
      return createSnapshot(session, action, await readGitSnapshot(repoPath), {
        ok: false,
        message: stage.output.trim() || stage.error.trim()
      }, undefined, auditId, commitStrategy);
    }

    const commitArgs = commitStrategy === CommitStrategy.IncludeUntracked
      ? ['commit', '-m', message]
      : ['commit', '-am', message];
    const commit = await runGit(repoPath, commitArgs);
    return createSnapshot(session, action, await readGitSnapshot(repoPath), {
      ok: commit.exitCode === 0,
      message: commit.output.trim() || commit.error.trim()
    }, undefined, auditId, commitStrategy);
  }

  if (action === 'push') {
    const prePushSnapshot = await readGitSnapshot(repoPath);
    const pushPolicy = evaluatePushPolicy(prePushSnapshot);

    if (!gitWriteActionsEnabled || !gitPushActionsEnabled) {
      return createSnapshot(session, action, prePushSnapshot, {
        ok: false,
        message: 'Git push is disabled. Set both GIT_WRITE_ACTIONS_ENABLED=true and GIT_PUSH_ACTIONS_ENABLED=true on Host Bridge to enable it.'
      }, undefined, auditId);
    }

    if (!pushPolicy.ok) {
      return createSnapshot(session, action, prePushSnapshot, {
        ok: false,
        message: pushPolicy.message
      }, undefined, auditId);
    }

    const push = await runGit(repoPath, ['push', '--porcelain']);
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
  const [status, diffStat, changedFiles, branch, upstream] = await Promise.all([
    runGit(repoPath, ['status', '--porcelain=v1', '-b']),
    runGit(repoPath, ['diff', '--stat']),
    runGit(repoPath, ['diff', '--name-only']),
    runGit(repoPath, ['branch', '--show-current']),
    runGit(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  ]);

  const statusLines = status.output.split(/\r?\n/).filter(Boolean);
  const files = statusLines
    .filter((line) => !line.startsWith('## '))
    .map(parsePorcelainLine);

  return {
    repo_path: repoPath,
    branch: branch.output.trim() || parseBranch(statusLines[0]) || 'unknown',
    upstream: upstream.exitCode === 0 ? upstream.output.trim() : '',
    is_git_repo: status.exitCode === 0,
    status_summary: summarizeFiles(files),
    tracked_file_count: files.filter((file) => file.tracked).length,
    untracked_file_count: files.filter((file) => !file.tracked).length,
    files,
    diff_stat: diffStat.output.trim(),
    changed_files: changedFiles.output.split(/\r?\n/).filter(Boolean),
    error: status.exitCode === 0 ? '' : (status.error || status.output).trim()
  };
}

function createSnapshot(
  session,
  action,
  git,
  result = { ok: true, message: '' },
  fileDiff = undefined,
  auditId = '',
  commitStrategy = CommitStrategy.TrackedOnly
) {
  return {
    session_id: session.session_id,
    host_id: session.host_id,
    action,
    repo_path: git.repo_path,
    branch: git.branch,
    upstream: git.upstream,
    is_git_repo: git.is_git_repo,
    status_summary: git.status_summary,
    tracked_file_count: git.tracked_file_count,
    untracked_file_count: git.untracked_file_count,
    commit_strategy: commitStrategy,
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
    path: line.slice(3).trim(),
    tracked: !line.startsWith('??')
  };
}

function commitPolicyMessage(message, git, commitStrategy) {
  if (commitStrategy === CommitStrategy.IncludeUntracked) {
    return `${message} Current commit strategy stages tracked and untracked files.`;
  }

  if (!git.untracked_file_count) {
    return `${message} Current commit strategy covers tracked files only.`;
  }

  return `${message} Current commit strategy covers tracked files only; ${git.untracked_file_count} untracked file(s) will not be committed.`;
}

function normalizeCommitStrategy(strategy) {
  return strategy === CommitStrategy.IncludeUntracked
    ? CommitStrategy.IncludeUntracked
    : CommitStrategy.TrackedOnly;
}

function evaluatePushPolicy(git) {
  if (!git.is_git_repo) {
    return {
      ok: false,
      message: git.error || 'Git push blocked because the session repository is not a git repo.'
    };
  }

  if (!git.branch || git.branch === 'unknown' || git.branch === 'HEAD') {
    return {
      ok: false,
      message: 'Git push blocked because the current branch is unknown or detached.'
    };
  }

  if (!git.upstream) {
    return {
      ok: false,
      message: 'Git push blocked because the current branch has no upstream tracking branch.'
    };
  }

  if (git.files.length > 0) {
    return {
      ok: false,
      message: `Git push blocked because the worktree is not clean (${git.files.length} changed file(s)). Commit or discard changes first.`
    };
  }

  return {
    ok: true,
    message: `Push allowed for ${git.branch} -> ${git.upstream}.`
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
