import { randomBytes } from 'node:crypto';
import {
  buildServerRelayConfigFromEnv,
  loadServerRelayConfig,
  resolveServerRelayConfigPath,
  saveServerRelayConfig
} from './server-relay-config.mjs';

const configPath = resolveServerRelayConfigPath();
const existingConfig = loadServerRelayConfig(configPath);
const config = buildServerRelayConfigFromEnv(existingConfig);

if (!config.public_ws_url) {
  throw new Error('Set RELAY_PUBLIC_WS_URL before running server:relay:init. For temporary IP testing, use ws://<server-ip>:<port> with CMC_ALLOW_INSECURE_SERVER_RELAY=1.');
}

if (!config.public_ws_url.startsWith('ws://') && !config.public_ws_url.startsWith('wss://')) {
  throw new Error('RELAY_PUBLIC_WS_URL must start with ws:// or wss://.');
}

if (config.public_http_url && !config.public_http_url.startsWith('http://') && !config.public_http_url.startsWith('https://')) {
  throw new Error('RELAY_PUBLIC_HTTP_URL must start with http:// or https://.');
}

if (!config.pairing_token) {
  config.pairing_token = `cmc_${randomBytes(32).toString('base64url')}`;
}

if (!config.host_token) {
  config.host_token = `cmc_host_${randomBytes(32).toString('base64url')}`;
}

const savedPath = saveServerRelayConfig(config, configPath);

console.log('[server-relay:init] Saved server Relay config.');
console.log(`[server-relay:init] Config path: ${savedPath}`);
console.log(`[server-relay:init] Listen: ${config.relay_host}:${config.relay_port}`);
console.log(`[server-relay:init] Public WebSocket URL: ${config.public_ws_url}`);
if (config.public_http_url) {
  console.log(`[server-relay:init] Public HTTP URL: ${config.public_http_url}`);
}
console.log(`[server-relay:init] SQLite path: ${config.sqlite_path}`);
console.log('');
console.log('[server-relay:init] Next run: npm run server:relay');
