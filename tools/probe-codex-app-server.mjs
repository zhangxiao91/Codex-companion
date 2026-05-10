import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const port = Number.parseInt(process.env.CODEX_APP_SERVER_PORT ?? '8791', 10);
const listenUrl = `ws://127.0.0.1:${port}`;
const codexCli = resolveCodexCli();
let nextId = 1;
const child = spawn(codexCli, ['app-server', '--listen', listenUrl], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe']
});

let childOutput = '';
child.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  childOutput += text;
  process.stdout.write(`[app-server] ${text}`);
});
child.stderr.on('data', (chunk) => {
  const text = chunk.toString();
  childOutput += text;
  process.stderr.write(`[app-server:err] ${text}`);
});

try {
  const socket = await connectWithRetry(listenUrl, 10000);
  const pending = new Map();

  socket.addEventListener('message', (event) => {
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

  console.log(`[probe] connected to ${listenUrl}`);

  const initialize = await request(socket, pending, 'initialize', {
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

  const threadList = await request(socket, pending, 'thread/list', {
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

  socket.close();
  process.exitCode = 0;
} catch (error) {
  console.error(`[probe] failed: ${error.message}`);
  if (childOutput) {
    console.error('[probe] app-server output captured above.');
  }
  process.exitCode = 1;
} finally {
  child.kill();
  await delay(250);
}

function resolveCodexCli() {
  if (process.env.CODEX_CLI_PATH) {
    return process.env.CODEX_CLI_PATH;
  }

  const userProfile = process.env.USERPROFILE;
  const candidates = [
    userProfile
      ? `${userProfile}\\.vscode\\extensions\\openai.chatgpt-26.506.21252-win32-x64\\bin\\windows-x86_64\\codex.exe`
      : null,
    'codex'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'codex' || existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('Unable to find Codex CLI. Set CODEX_CLI_PATH.');
}

async function connectWithRetry(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await connect(url);
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }

  throw lastError ?? new Error(`Timed out connecting to ${url}`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out opening WebSocket ${url}`));
    }, 2000);

    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket connection failed for ${url}`));
    });
  });
}

function request(socket, pending, method, params) {
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

    socket.send(JSON.stringify(payload));
  });
}
