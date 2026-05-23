import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWindowsBridgeConfig,
  buildWindowsBridgeTaskAction,
  installWindowsBridgeTask
} from './windows-host-bridge-service.mjs';

const tempDir = mkdtempSync(join(tmpdir(), 'cmc-windows-bridge-'));

try {
  const config = buildWindowsBridgeConfig({}, {}, {
    RELAY_URL: 'wss://relay.example.test',
    HOST_ID: 'verify-host',
    HOST_NAME: 'Verify Host',
    CODEX_ADAPTER: 'mock',
    HOST_IDENTITY_PATH: join(tempDir, 'host-identity.json'),
    CMC_WINDOWS_BRIDGE_LOG_PATH: join(tempDir, 'bridge.log')
  });

  assertEqual(config.relay_url, 'wss://relay.example.test', 'relay_url');
  assertEqual(config.host_id, 'verify-host', 'host_id');
  assertEqual(config.host_name, 'Verify Host', 'host_name');
  assertEqual(config.codex_adapter, 'mock', 'codex_adapter');
  if (config.host_token) {
    throw new Error('host_token should not be stored by default.');
  }

  const tokenConfig = buildWindowsBridgeConfig({}, {}, {
    RELAY_URL: 'wss://relay.example.test',
    RELAY_HOST_TOKEN: 'host-secret',
    CMC_BRIDGE_STORE_HOST_TOKEN: '1'
  });
  assertEqual(tokenConfig.host_token, 'host-secret', 'stored host_token');

  const action = buildWindowsBridgeTaskAction({
    cwd: 'C:\\Projects\\Codex Mobile',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    runnerPath: 'C:\\Projects\\Codex Mobile\\tools\\windows-host-bridge-run.mjs',
    logPath: 'C:\\Projects\\Codex Mobile\\.relay\\windows-host-bridge.log'
  });
  if (!action.includes('-WindowStyle Hidden')) {
    throw new Error('Task action should start hidden.');
  }
  if (!action.includes('windows-host-bridge-run.mjs')) {
    throw new Error('Task action should run the Windows Host Bridge runner.');
  }

  process.env.RELAY_URL = 'wss://relay.example.test';
  process.env.HOST_ID = 'verify-host';
  process.env.HOST_NAME = 'Verify Host';
  process.env.CODEX_ADAPTER = 'mock';
  process.env.HOST_IDENTITY_PATH = join(tempDir, 'host-identity.json');
  process.env.CMC_WINDOWS_BRIDGE_CONFIG = join(tempDir, 'windows-host-bridge-config.json');
  process.env.CMC_WINDOWS_BRIDGE_LOG_PATH = join(tempDir, 'bridge.log');
  installWindowsBridgeTask({ dryRun: true });

  console.log('[verify] Windows Host Bridge service helper verified.');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}
