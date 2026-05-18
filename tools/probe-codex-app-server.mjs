import { existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { StdioJsonTransport } from '../bridge/host-bridge/app-server-stdio-transport.mjs';

const listenUrl = process.env.CODEX_APP_SERVER_LISTEN ?? 'stdio://';
const codexCli = resolveCodexCli();
let nextId = 1;
const child = spawn(codexCli, ['app-server', '--listen', listenUrl], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe']
});
const transport = new StdioJsonTransport(child);
const pending = new Map();

transport.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);

  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }

  if (message.method) {
    console.log(`[probe] notification: ${message.method}`);
  }
});
transport.addEventListener('stderr', (chunk) => {
  process.stderr.write(`[app-server:err] ${chunk}`);
});

try {
  console.log(`[probe] connected to ${listenUrl}`);

  const initialize = await request('initialize', {
    clientInfo: {
      name: 'codex-mobile-companion-probe',
      title: 'Codex Mobile Companion Probe',
      version: '0.0.1'
    },
    capabilities: {
      experimentalApi: true
    }
  });

  if (initialize.error) {
    throw new Error(`initialize failed: ${JSON.stringify(initialize.error)}`);
  }

  console.log(`[probe] initialize ok: ${initialize.result.userAgent}`);
  console.log(`[probe] codex home: ${initialize.result.codexHome}`);

  const threadList = await request('thread/list', {
    limit: 5,
    archived: false,
    useStateDbOnly: true
  });

  if (threadList.error) {
    throw new Error(`thread/list failed: ${JSON.stringify(threadList.error)}`);
  }

  const threads = threadList.result.data ?? [];
  console.log(`[probe] thread/list ok: ${threads.length} thread(s)`);
  for (const thread of threads) {
    console.log(`[probe] thread: ${thread.id} status=${thread.status?.type ?? 'unknown'} preview=${thread.preview ?? ''}`);
  }

  process.exitCode = 0;
} catch (error) {
  console.error(`[probe] failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  transport.close();
  child.kill();
  await delay(250);
}

function request(method, params) {
  const id = nextId;
  nextId += 1;

  const payload = {
    id,
    method,
    params
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 10000);

    pending.set(id, (response) => {
      clearTimeout(timer);
      resolve(response);
    });

    transport.send(JSON.stringify(payload));
  });
}

function resolveCodexCli() {
  if (process.env.CODEX_CLI_PATH) {
    return process.env.CODEX_CLI_PATH;
  }

  const userProfile = process.env.USERPROFILE;
  const extensionCodexCli = findLatestVsCodeCodexCli(userProfile);
  const candidates = [
    extensionCodexCli,
    'codex'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'codex' || existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('Unable to find Codex CLI. Set CODEX_CLI_PATH.');
}

function findLatestVsCodeCodexCli(userProfile) {
  if (!userProfile) {
    return undefined;
  }

  const extensionsDir = `${userProfile}\\.vscode\\extensions`;
  if (!existsSync(extensionsDir)) {
    return undefined;
  }

  const candidates = readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'))
    .map((entry) => `${extensionsDir}\\${entry.name}\\bin\\windows-x86_64\\codex.exe`)
    .filter((candidate) => existsSync(candidate))
    .sort()
    .reverse();

  return candidates[0];
}
