import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPairingCode, createPairingPayload } from './pairing-code.mjs';
import {
  loadServerRelayConfig,
  resolveServerRelayConfigPath
} from './server-relay-config.mjs';
import {
  DEFAULT_WINDOWS_BRIDGE_LOG_PATH,
  DEFAULT_WINDOWS_BRIDGE_TASK_NAME,
  loadWindowsBridgeConfig,
  resolveWindowsBridgeConfigPath,
  resolveWindowsStartupLauncherPath
} from './windows-host-bridge-service.mjs';

const args = new Set(process.argv.slice(2));
const timeoutMs = Number.parseInt(process.env.CMC_DOCTOR_TIMEOUT_MS ?? '5000', 10);
const checks = [];

await main();

async function main() {
  const serverConfigPath = resolveServerRelayConfigPath();
  const bridgeConfigPath = resolveWindowsBridgeConfigPath();
  const serverConfig = loadConfig('server Relay config', serverConfigPath, loadServerRelayConfig);
  const bridgeConfig = loadConfig('Windows Host Bridge config', bridgeConfigPath, loadWindowsBridgeConfig);
  const hostIdentityPath = resolve(firstNonBlank(
    process.env.HOST_IDENTITY_PATH,
    bridgeConfig.value.host_identity_path,
    '.relay/host-identity.json'
  ));
  const hostIdentity = loadJsonFile('host identity', hostIdentityPath, { optional: true });

  const relayUrl = firstNonBlank(
    process.env.RELAY_PUBLIC_WS_URL,
    process.env.RELAY_URL,
    bridgeConfig.value.relay_url,
    hostIdentity.value.relay_url,
    serverConfig.value.public_ws_url
  );
  const healthBaseUrls = uniqueNonBlank([
    process.env.RELAY_PUBLIC_HTTP_URL,
    serverConfig.value.public_http_url,
    relayUrl ? httpUrlForRelayUrl(relayUrl) : ''
  ]).map(trimTrailingSlash);
  const pairingToken = firstNonBlank(
    process.env.RELAY_PAIRING_TOKEN,
    process.env.RELAY_DEV_TOKEN,
    process.env.DEV_TOKEN,
    serverConfig.value.pairing_token
  );
  const hostToken = firstNonBlank(
    process.env.RELAY_HOST_TOKEN,
    process.env.RELAY_DEV_TOKEN,
    process.env.DEV_TOKEN,
    bridgeConfig.value.host_token,
    serverConfig.value.host_token
  );
  const hostDeviceToken = firstNonBlank(
    process.env.RELAY_HOST_DEVICE_TOKEN,
    hostIdentity.value.host_device_token
  );

  addConfigChecks({
    serverConfig,
    bridgeConfig,
    hostIdentity,
    relayUrl,
    healthBaseUrls,
    pairingToken,
    hostToken,
    hostDeviceToken
  });

  let health = null;
  if (healthBaseUrls.length > 0) {
    health = await checkHealthCandidates(healthBaseUrls, {
      pairingToken,
      hostToken,
      hostDeviceToken
    });
  }

  if (relayUrl) {
    await checkWebSocket(relayUrl);
  }

  checkPairingReadiness({ relayUrl, pairingToken });
  checkWindowsStartup({ bridgeConfig });
  checkBridgeLog({ bridgeConfig });
  printSummary({ health });

  const hasFailures = checks.some((check) => check.status === 'FAIL');
  if (hasFailures) {
    process.exitCode = 1;
  }
}

function loadConfig(label, path, loader) {
  if (!existsSync(path)) {
    record('WARN', label, `${path} not found.`, 'Run the corresponding init/install command if this machine should own that role.');
    return { path, value: {} };
  }

  try {
    const value = loader(path);
    record('OK', label, path);
    return { path, value };
  } catch (error) {
    record('FAIL', label, `Cannot read ${path}: ${error.message}`);
    return { path, value: {} };
  }
}

function loadJsonFile(label, path, options = {}) {
  if (!existsSync(path)) {
    record(options.optional ? 'WARN' : 'FAIL', label, `${path} not found.`, 'First Host Bridge registration needs RELAY_HOST_TOKEN; later runs can use saved host device trust.');
    return { path, value: {} };
  }

  try {
    const raw = readFileSync(path, 'utf8');
    const value = raw.trim() ? JSON.parse(raw) : {};
    record('OK', label, path);
    return { path, value };
  } catch (error) {
    record('FAIL', label, `Cannot read ${path}: ${error.message}`);
    return { path, value: {} };
  }
}

function addConfigChecks(context) {
  if (context.relayUrl) {
    const valid = context.relayUrl.startsWith('ws://') || context.relayUrl.startsWith('wss://');
    record(valid ? 'OK' : 'FAIL', 'Relay WebSocket URL', context.relayUrl, valid ? '' : 'Use ws:// for development or wss:// behind HTTPS.');
  } else {
    record('FAIL', 'Relay WebSocket URL', 'No Relay URL found.', 'Set RELAY_URL/RELAY_PUBLIC_WS_URL or run npm run server:relay:init.');
  }

  if (context.healthBaseUrls.length > 0) {
    record('OK', 'Relay health URL', context.healthBaseUrls.map((url) => `${url}/health`).join(', '));
  } else {
    record('FAIL', 'Relay health URL', 'Cannot derive HTTP health URL from Relay URL.');
  }

  if (context.hostToken || context.hostDeviceToken) {
    record('OK', 'Host auth', context.hostDeviceToken ? 'saved host device trust available' : 'host token available');
  } else {
    record('WARN', 'Host auth', 'No host token or saved host device token found.', 'First Host Bridge connection needs RELAY_HOST_TOKEN.');
  }

  if (context.pairingToken) {
    record('OK', 'Pairing auth', 'pairing token available');
  } else {
    record('WARN', 'Pairing auth', 'No pairing token found.', 'Android pairing QR/code generation needs RELAY_PAIRING_TOKEN or saved server config.');
  }
}

async function checkHealthCandidates(httpUrls, tokens) {
  const failures = [];
  for (const httpUrl of httpUrls) {
    const result = await checkHealth(httpUrl, tokens, { quietFailure: httpUrls.length > 1 });
    if (result.health) {
      if (failures.length > 0) {
        record('WARN', 'Relay /health fallback', `used ${httpUrl}/health after ${failures.length} earlier candidate(s) failed`);
      }
      return result.health;
    }
    failures.push(`${httpUrl}/health: ${result.error}`);
  }

  record('FAIL', 'Relay /health', failures.join('; '), 'Check server process, firewall, port, and reverse proxy/WebSocket forwarding.');
  return null;
}

async function checkHealth(httpUrl, tokens, options = {}) {
  const headers = {};
  if (tokens.hostToken) headers['X-Relay-Host-Token'] = tokens.hostToken;
  if (tokens.pairingToken) headers['X-Relay-Pairing-Token'] = tokens.pairingToken;
  if (tokens.hostDeviceToken) headers['X-Relay-Host-Device-Token'] = tokens.hostDeviceToken;

  let response;
  try {
    response = await fetchWithTimeout(`${httpUrl}/health`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    if (!options.quietFailure) {
      record('FAIL', 'Relay /health', error.message, 'Check server process, firewall, port, and reverse proxy/WebSocket forwarding.');
    }
    return { health: null, error: error.message };
  }

  if (!response.ok) {
    if (!options.quietFailure) {
      record('FAIL', 'Relay /health', `HTTP ${response.status}`, 'Check Relay logs and token headers.');
    }
    return { health: null, error: `HTTP ${response.status}` };
  }

  let health;
  try {
    health = await response.json();
  } catch (error) {
    if (!options.quietFailure) {
      record('FAIL', 'Relay /health JSON', error.message);
    }
    return { health: null, error: `invalid JSON: ${error.message}` };
  }

  if (health.ok !== true) {
    if (!options.quietFailure) {
      record('FAIL', 'Relay /health payload', 'ok=true was not returned.');
    }
    return { health, error: 'ok=true was not returned' };
  }

  if (health.counts) {
    record('OK', 'Relay /health', `hosts=${health.counts.hosts ?? '?'} online=${health.counts.online_hosts ?? '?'} sessions=${health.counts.sessions ?? '?'} clients=${health.counts.clients ?? '?'}`);
    if ((health.counts.online_hosts ?? 0) > 0) {
      record('OK', 'Host online', `${health.counts.online_hosts} host(s) connected.`);
    } else {
      record('WARN', 'Host online', 'No host is currently online.', 'Start the PC bridge with npm run connect or npm run bridge:windows:start.');
    }
    if (health.websocket) {
      record('OK', 'WebSocket keepalive', `connections=${health.websocket.connections ?? '?'} ping=${health.websocket.ping_interval_ms ?? '?'}ms stale=${health.websocket.stale_timeout_ms ?? '?'}ms`);
    }
  } else if (health.auth_required) {
    record('WARN', 'Relay /health', 'Reachable, but detailed diagnostics are hidden by auth.', 'Provide a valid host/pairing/device token to the doctor.');
  } else {
    record('OK', 'Relay /health', 'reachable');
  }

  return { health, error: '' };
}

async function checkWebSocket(relayUrl) {
  if (typeof WebSocket !== 'function') {
    record('WARN', 'WebSocket probe', 'This Node runtime does not expose global WebSocket.');
    return;
  }

  try {
    await new Promise((resolvePromise, rejectPromise) => {
      const socket = new WebSocket(relayUrl);
      const timer = setTimeout(() => {
        socket.close();
        rejectPromise(new Error(`Timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      socket.addEventListener('open', () => {
        clearTimeout(timer);
        socket.close();
        resolvePromise();
      }, { once: true });

      socket.addEventListener('error', () => {
        clearTimeout(timer);
        rejectPromise(new Error('WebSocket handshake failed.'));
      }, { once: true });
    });
    record('OK', 'WebSocket probe', relayUrl);
  } catch (error) {
    record('FAIL', 'WebSocket probe', error.message, 'HTTP health can pass while WebSocket upgrade is blocked by a proxy or server port mismatch.');
  }
}

function checkPairingReadiness({ relayUrl, pairingToken }) {
  if (!relayUrl || !pairingToken) {
    record('WARN', 'Pairing code', 'Not ready.', 'Save Relay URL and pairing token, then run npm run pair.');
    return;
  }

  try {
    const pairingCode = createPairingCode(createPairingPayload({
      relayUrl,
      pairingToken,
      createdAt: 'doctor-check'
    }));
    record('OK', 'Pairing code', `can generate ${pairingCode.slice(0, 5)}...`);
  } catch (error) {
    record('FAIL', 'Pairing code', error.message);
  }
}

function checkWindowsStartup({ bridgeConfig }) {
  if (process.platform !== 'win32') {
    record('INFO', 'Windows startup', 'Skipped on non-Windows platform.');
    return;
  }

  const taskName = process.env.CMC_WINDOWS_BRIDGE_TASK_NAME ?? DEFAULT_WINDOWS_BRIDGE_TASK_NAME;
  const result = spawnSync('schtasks.exe', ['/Query', '/TN', taskName, '/FO', 'LIST', '/V'], {
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true
  });
  if (result.status === 0) {
    const statusLine = parseListValue(result.stdout, 'Status');
    const lastRun = parseListValue(result.stdout, 'Last Run Time');
    record('OK', 'Windows scheduled task', `${taskName}${statusLine ? `, status=${statusLine}` : ''}${lastRun ? `, last_run=${lastRun}` : ''}`);
    return;
  }

  const startupLauncherPath = resolveWindowsStartupLauncherPath();
  if (existsSync(startupLauncherPath)) {
    record('OK', 'Windows startup launcher', startupLauncherPath);
    return;
  }

  const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
  record('WARN', 'Windows startup', detail || `${taskName} not installed.`, 'Install with npm run bridge:windows:install if this PC should auto-connect.');

  if (bridgeConfig.value.relay_url) {
    record('INFO', 'Bridge config', `manual start remains available: npm run connect`);
  }
}

function checkBridgeLog({ bridgeConfig }) {
  const logPath = resolve(process.env.CMC_WINDOWS_BRIDGE_LOG_PATH ?? bridgeConfig.value.log_path ?? DEFAULT_WINDOWS_BRIDGE_LOG_PATH);
  if (!existsSync(logPath)) {
    record('WARN', 'Bridge log', `${logPath} not found.`, 'Start the bridge once to create the log.');
    return;
  }

  const stats = statSync(logPath);
  const raw = readFileSync(logPath, 'utf8');
  const tail = raw.split(/\r?\n/).filter(Boolean).slice(-20).join('\n');
  const ageSeconds = Math.round((Date.now() - stats.mtimeMs) / 1000);
  if (/Unauthorized|missing or invalid Relay auth token/i.test(tail)) {
    record('FAIL', 'Bridge log', `recent auth error in ${logPath}`, 'Refresh RELAY_HOST_TOKEN or saved host device trust.');
    return;
  }
  if (/websocket error|disconnected|exited with code/i.test(tail) && !/connected to ws/i.test(tail.split(/\r?\n/).slice(-5).join('\n'))) {
    record('WARN', 'Bridge log', `recent disconnect/exited marker in ${logPath}, modified ${ageSeconds}s ago`);
    return;
  }
  if (/connected to ws|app-server initialized|registered host capabilities/i.test(tail)) {
    record('OK', 'Bridge log', `${logPath}, modified ${ageSeconds}s ago`);
    return;
  }
  record('INFO', 'Bridge log', `${logPath}, modified ${ageSeconds}s ago`);
}

function printSummary({ health }) {
  console.log('');
  console.log('Codex Mobile Companion doctor');
  console.log('================================');
  for (const check of checks) {
    const prefix = `[${check.status}]`.padEnd(7);
    console.log(`${prefix} ${check.title}: ${check.detail}`);
    if (check.hint) {
      console.log(`        hint: ${check.hint}`);
    }
  }

  if (health?.checked_at) {
    console.log('');
    console.log(`Relay checked at: ${health.checked_at}`);
  }

  const failCount = checks.filter((check) => check.status === 'FAIL').length;
  const warnCount = checks.filter((check) => check.status === 'WARN').length;
  console.log('');
  console.log(`Overall: ${failCount > 0 ? 'FAIL' : 'OK'} (${failCount} fail, ${warnCount} warn)`);
}

function record(status, title, detail, hint = '') {
  checks.push({ status, title, detail, hint });
}

function firstNonBlank(...values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

function trimTrailingSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

function uniqueNonBlank(values) {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
}

function httpUrlForRelayUrl(relayUrl) {
  if (relayUrl.startsWith('wss://')) {
    return `https://${relayUrl.slice('wss://'.length)}`;
  }
  if (relayUrl.startsWith('ws://')) {
    return `http://${relayUrl.slice('ws://'.length)}`;
  }
  return '';
}

async function fetchWithTimeout(url, options) {
  return fetch(url, options);
}

function parseListValue(output, key) {
  const pattern = new RegExp(`^${escapeRegExp(key)}:\\s*(.+)$`, 'im');
  return output.match(pattern)?.[1]?.trim() ?? '';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
