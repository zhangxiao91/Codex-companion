import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadServerRelayConfig } from './server-relay-config.mjs';

export const DEFAULT_WINDOWS_BRIDGE_CONFIG_PATH = '.relay/windows-host-bridge-config.json';
export const DEFAULT_WINDOWS_BRIDGE_TASK_NAME = 'CodexMobileCompanionHostBridge';
export const DEFAULT_WINDOWS_BRIDGE_LOG_PATH = '.relay/windows-host-bridge.log';
export const DEFAULT_WINDOWS_BRIDGE_TASK_SCRIPT_PATH = '.relay/windows-host-bridge-task.ps1';
export const DEFAULT_WINDOWS_BRIDGE_STARTUP_LAUNCHER = 'CodexMobileCompanionHostBridge.vbs';

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  await main();
}

async function main() {
  const command = process.argv[2] ?? 'install';
  const dryRun = process.argv.includes('--dry-run');

  if (command === 'install') {
    installWindowsBridgeTask({ dryRun });
    return;
  }

  if (command === 'uninstall') {
    uninstallWindowsBridgeTask({ dryRun });
    return;
  }

  if (command === 'status') {
    queryWindowsBridgeTask();
    return;
  }

  if (command === 'start') {
    startWindowsBridgeTask({ dryRun });
    return;
  }

  throw new Error('Usage: npm run bridge:windows:<install|uninstall|status|start> [-- --dry-run]');
}

export function installWindowsBridgeTask(options = {}) {
  const dryRun = options.dryRun === true;
  assertWindowsOrDryRun(dryRun);

  const configPath = resolveWindowsBridgeConfigPath();
  const existingConfig = loadJsonIfExists(configPath);
  const serverConfig = loadServerRelayConfigSafely();
  const config = buildWindowsBridgeConfig(existingConfig, serverConfig);
  validateWindowsBridgeConfig(config);
  saveWindowsBridgeConfig(config, configPath, { dryRun });

  const taskName = resolveTaskName();
  const taskScriptPath = resolve(process.env.CMC_WINDOWS_BRIDGE_TASK_SCRIPT_PATH ?? DEFAULT_WINDOWS_BRIDGE_TASK_SCRIPT_PATH);
  writeWindowsBridgeTaskScript({
    taskScriptPath,
    cwd: process.cwd(),
    nodePath: process.execPath,
    runnerPath: resolve('tools/windows-host-bridge-run.mjs'),
    logPath: resolve(process.env.CMC_WINDOWS_BRIDGE_LOG_PATH ?? config.log_path ?? DEFAULT_WINDOWS_BRIDGE_LOG_PATH)
  }, { dryRun });
  const taskAction = buildWindowsBridgeTaskAction({
    taskScriptPath
  });
  const args = [
    '/Create',
    '/TN',
    taskName,
    '/SC',
    'ONLOGON',
    '/TR',
    taskAction,
    '/F'
  ];

  console.log('[windows-bridge] Config path:', configPath);
  console.log('[windows-bridge] Task script:', taskScriptPath);
  console.log('[windows-bridge] Task name:', taskName);
  console.log('[windows-bridge] Task action:', taskAction);

  if (dryRun) {
    console.log('[windows-bridge] Dry run: task not installed.');
    return { configPath, config, taskName, taskAction };
  }

  try {
    runSchtasks(args);
    console.log('[windows-bridge] Installed scheduled task. It will start on Windows logon.');
  } catch (error) {
    if (!isAccessDeniedError(error)) {
      throw error;
    }
    const startupLauncherPath = writeWindowsStartupLauncher({ taskScriptPath });
    console.warn('[windows-bridge] Task Scheduler denied access. Installed Startup folder launcher instead.');
    console.warn('[windows-bridge] Startup launcher:', startupLauncherPath);
  }
  console.log('[windows-bridge] Start now with: npm run bridge:windows:start');
  return { configPath, config, taskName, taskAction };
}

export function uninstallWindowsBridgeTask(options = {}) {
  const dryRun = options.dryRun === true;
  assertWindowsOrDryRun(dryRun);

  const taskName = resolveTaskName();
  const args = ['/Delete', '/TN', taskName, '/F'];
  console.log('[windows-bridge] Task name:', taskName);

  if (dryRun) {
    console.log('[windows-bridge] Dry run: task not removed.');
    return;
  }

  try {
    runSchtasks(args);
  } catch (error) {
    if (!isAccessDeniedError(error) && !isMissingTaskError(error)) {
      throw error;
    }
    console.warn(`[windows-bridge] Scheduled task was not removed: ${error.message}`);
  }

  const startupLauncherPath = resolveWindowsStartupLauncherPath();
  if (existsSync(startupLauncherPath)) {
    rmSync(startupLauncherPath, { force: true });
    console.log('[windows-bridge] Removed Startup launcher:', startupLauncherPath);
  }
  console.log('[windows-bridge] Uninstalled.');
}

export function queryWindowsBridgeTask() {
  assertWindowsOrDryRun(false);
  try {
    runSchtasks(['/Query', '/TN', resolveTaskName(), '/V', '/FO', 'LIST'], { inherit: true });
  } catch (error) {
    console.warn(`[windows-bridge] Scheduled task query failed: ${error.message}`);
  }
  const startupLauncherPath = resolveWindowsStartupLauncherPath();
  console.log('[windows-bridge] Startup launcher:', existsSync(startupLauncherPath) ? startupLauncherPath : 'not installed');
}

export function startWindowsBridgeTask(options = {}) {
  const dryRun = options.dryRun === true;
  assertWindowsOrDryRun(dryRun);

  const taskName = resolveTaskName();
  const args = ['/Run', '/TN', taskName];
  console.log('[windows-bridge] Task name:', taskName);

  if (dryRun) {
    console.log('[windows-bridge] Dry run: task not started.');
    return;
  }

  try {
    runSchtasks(args);
    console.log('[windows-bridge] Scheduled task start requested.');
    return;
  } catch (error) {
    if (!isAccessDeniedError(error) && !isMissingTaskError(error)) {
      throw error;
    }
    const startupLauncherPath = resolveWindowsStartupLauncherPath();
    if (!existsSync(startupLauncherPath)) {
      throw error;
    }
    runDetached('wscript.exe', [startupLauncherPath]);
    console.log('[windows-bridge] Started through Startup launcher.');
  }
}

export function resolveWindowsBridgeConfigPath() {
  return resolve(process.env.CMC_WINDOWS_BRIDGE_CONFIG ?? DEFAULT_WINDOWS_BRIDGE_CONFIG_PATH);
}

export function loadWindowsBridgeConfig(path = resolveWindowsBridgeConfigPath()) {
  return loadJsonIfExists(path);
}

export function saveWindowsBridgeConfig(config, path = resolveWindowsBridgeConfigPath(), options = {}) {
  if (options.dryRun === true) {
    return path;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    saved_at: new Date().toISOString(),
    ...config
  }, null, 2)}\n`, 'utf8');
  return path;
}

export function buildWindowsBridgeConfig(baseConfig = {}, serverConfig = {}, env = process.env) {
  const storeHostToken = env.CMC_BRIDGE_STORE_HOST_TOKEN === '1';
  const hostToken = env.RELAY_HOST_TOKEN
    ?? env.RELAY_DEV_TOKEN
    ?? serverConfig.host_token
    ?? baseConfig.host_token
    ?? '';
  return compactObject({
    relay_url: env.RELAY_URL
      ?? env.RELAY_PUBLIC_WS_URL
      ?? serverConfig.public_ws_url
      ?? baseConfig.relay_url
      ?? '',
    host_id: env.HOST_ID ?? baseConfig.host_id ?? 'local-pc',
    host_name: env.HOST_NAME ?? baseConfig.host_name ?? 'Local PC',
    codex_adapter: env.CODEX_ADAPTER ?? baseConfig.codex_adapter ?? 'app-server',
    host_identity_path: env.HOST_IDENTITY_PATH ?? baseConfig.host_identity_path ?? '.relay/host-identity.json',
    log_path: env.CMC_WINDOWS_BRIDGE_LOG_PATH ?? baseConfig.log_path ?? DEFAULT_WINDOWS_BRIDGE_LOG_PATH,
    host_token: storeHostToken ? hostToken : (baseConfig.host_token ?? '')
  });
}

export function validateWindowsBridgeConfig(config) {
  if (!config.relay_url) {
    throw new Error('Set RELAY_URL or RELAY_PUBLIC_WS_URL before installing the Windows Host Bridge task.');
  }

  if (!String(config.relay_url).startsWith('ws://') && !String(config.relay_url).startsWith('wss://')) {
    throw new Error('Relay URL must start with ws:// or wss://.');
  }

  const identityPath = resolve(config.host_identity_path ?? '.relay/host-identity.json');
  if (!existsSync(identityPath) && !config.host_token) {
    console.warn('[windows-bridge] Warning: no saved host identity was found and host_token is not stored.');
    console.warn('[windows-bridge] Start Host Bridge once with RELAY_HOST_TOKEN first, or set CMC_BRIDGE_STORE_HOST_TOKEN=1 during install.');
  }
}

export function buildWindowsBridgeTaskAction(options) {
  const taskScriptPath = options.taskScriptPath ?? resolve(DEFAULT_WINDOWS_BRIDGE_TASK_SCRIPT_PATH);
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${taskScriptPath}"`;
}

export function writeWindowsBridgeTaskScript(options, writeOptions = {}) {
  const taskScriptPath = options.taskScriptPath ?? resolve(DEFAULT_WINDOWS_BRIDGE_TASK_SCRIPT_PATH);
  if (writeOptions.dryRun === true) {
    return taskScriptPath;
  }

  const cwd = options.cwd ?? process.cwd();
  const nodePath = options.nodePath ?? process.execPath;
  const runnerPath = options.runnerPath ?? resolve('tools/windows-host-bridge-run.mjs');
  const logPath = options.logPath ?? resolve(DEFAULT_WINDOWS_BRIDGE_LOG_PATH);
  mkdirSync(dirname(taskScriptPath), { recursive: true });
  writeFileSync(taskScriptPath, [
    '$ErrorActionPreference = "Continue"',
    `Set-Location -LiteralPath ${quotePowerShell(cwd)}`,
    `$logPath = ${quotePowerShell(logPath)}`,
    `$logDir = Split-Path -Parent $logPath`,
    'if ($logDir) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }',
    `"[$([DateTime]::Now.ToString('o'))] Starting Codex Mobile Companion Host Bridge" | Add-Content -LiteralPath $logPath`,
    `& ${quotePowerShell(nodePath)} ${quotePowerShell(runnerPath)} 2>&1 | ForEach-Object { $_ | Out-File -LiteralPath $logPath -Append -Encoding utf8 }`,
    `"[$([DateTime]::Now.ToString('o'))] Host Bridge exited with code $LASTEXITCODE" | Add-Content -LiteralPath $logPath`
  ].join('\r\n'), 'utf8');
  return taskScriptPath;
}

export function resolveWindowsStartupLauncherPath() {
  const appData = process.env.APPDATA;
  if (!appData) {
    return resolve('.relay', DEFAULT_WINDOWS_BRIDGE_STARTUP_LAUNCHER);
  }
  return resolve(appData, 'Microsoft/Windows/Start Menu/Programs/Startup', DEFAULT_WINDOWS_BRIDGE_STARTUP_LAUNCHER);
}

export function writeWindowsStartupLauncher(options = {}) {
  const taskScriptPath = options.taskScriptPath ?? resolve(DEFAULT_WINDOWS_BRIDGE_TASK_SCRIPT_PATH);
  const startupLauncherPath = options.startupLauncherPath ?? resolveWindowsStartupLauncherPath();
  mkdirSync(dirname(startupLauncherPath), { recursive: true });
  const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${taskScriptPath}"`;
  writeFileSync(startupLauncherPath, [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run ${quoteVbs(command)}, 0, False`
  ].join('\r\n'), 'utf8');
  return startupLauncherPath;
}

function resolveTaskName() {
  return process.env.CMC_WINDOWS_BRIDGE_TASK_NAME ?? DEFAULT_WINDOWS_BRIDGE_TASK_NAME;
}

function loadJsonIfExists(path) {
  if (!existsSync(path)) {
    return {};
  }

  const raw = readFileSync(path, 'utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}

function loadServerRelayConfigSafely() {
  try {
    return loadServerRelayConfig();
  } catch {
    return {};
  }
}

function runSchtasks(args, options = {}) {
  const result = spawnSync('schtasks.exe', args, {
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe'
  });
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    throw new Error(`schtasks.exe failed${detail ? `: ${detail}` : ''}`);
  }

  if (!options.inherit && result.stdout?.trim()) {
    console.log(result.stdout.trim());
  }
}

function runDetached(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true
  });
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    throw new Error(`${command} failed${detail ? `: ${detail}` : ''}`);
  }
}

function isAccessDeniedError(error) {
  return String(error?.message ?? '').toLowerCase().includes('access is denied');
}

function isMissingTaskError(error) {
  return String(error?.message ?? '').toLowerCase().includes('cannot find the file specified');
}

function assertWindowsOrDryRun(dryRun) {
  if (process.platform !== 'win32' && !dryRun) {
    throw new Error('Windows Host Bridge service installation requires Windows.');
  }
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteVbs(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null)
  );
}
