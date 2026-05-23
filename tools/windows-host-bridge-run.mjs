import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { loadWindowsBridgeConfig, resolveWindowsBridgeConfigPath } from './windows-host-bridge-service.mjs';

const configPath = resolveWindowsBridgeConfigPath();
const config = loadWindowsBridgeConfig(configPath);

if (!config.relay_url) {
  throw new Error(`Missing relay_url in ${configPath}. Run npm run bridge:windows:install first.`);
}

console.log('[windows-bridge-run] Starting Host Bridge.');
console.log(`[windows-bridge-run] Config: ${configPath}`);
console.log(`[windows-bridge-run] Relay URL: ${config.relay_url}`);
console.log(`[windows-bridge-run] Host ID: ${config.host_id ?? 'local-pc'}`);
console.log(`[windows-bridge-run] Host name: ${config.host_name ?? 'Local PC'}`);

const child = spawn(process.execPath, ['tools/server-host-bridge-start.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    RELAY_URL: config.relay_url,
    ...(config.host_token ? { RELAY_HOST_TOKEN: config.host_token } : {}),
    HOST_ID: config.host_id ?? 'local-pc',
    HOST_NAME: config.host_name ?? 'Local PC',
    CODEX_ADAPTER: config.codex_adapter ?? 'app-server',
    HOST_IDENTITY_PATH: resolve(config.host_identity_path ?? '.relay/host-identity.json')
  },
  stdio: 'inherit'
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
