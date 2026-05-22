import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const DEFAULT_SERVER_RELAY_CONFIG_PATH = '.relay/server-relay-config.json';

export function resolveServerRelayConfigPath() {
  return resolve(process.env.CMC_SERVER_RELAY_CONFIG ?? DEFAULT_SERVER_RELAY_CONFIG_PATH);
}

export function loadServerRelayConfig(path = resolveServerRelayConfigPath()) {
  if (!existsSync(path)) {
    return {};
  }

  const raw = readFileSync(path, 'utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}

export function saveServerRelayConfig(config, path = resolveServerRelayConfigPath()) {
  mkdirSync(dirname(path), { recursive: true });
  const safeConfig = {
    version: 1,
    saved_at: new Date().toISOString(),
    ...config
  };
  writeFileSync(path, `${JSON.stringify(safeConfig, null, 2)}\n`, 'utf8');
  return path;
}

export function buildServerRelayConfigFromEnv(baseConfig = {}, env = process.env) {
  return compactObject({
    relay_host: env.RELAY_HOST ?? baseConfig.relay_host ?? '127.0.0.1',
    relay_port: env.RELAY_PORT ?? baseConfig.relay_port ?? '8787',
    public_ws_url: env.RELAY_PUBLIC_WS_URL ?? baseConfig.public_ws_url ?? '',
    public_http_url: env.RELAY_PUBLIC_HTTP_URL ?? baseConfig.public_http_url ?? '',
    pairing_token: env.RELAY_PAIRING_TOKEN ?? env.RELAY_DEV_TOKEN ?? baseConfig.pairing_token ?? '',
    host_token: env.RELAY_HOST_TOKEN ?? env.RELAY_DEV_TOKEN ?? baseConfig.host_token ?? '',
    sqlite_path: env.RELAY_SQLITE_PATH ?? baseConfig.sqlite_path ?? '.relay/relay.sqlite',
    allow_insecure_server_relay: env.CMC_ALLOW_INSECURE_SERVER_RELAY ?? baseConfig.allow_insecure_server_relay ?? '',
    pairing_qr: env.CMC_PAIRING_QR ?? baseConfig.pairing_qr ?? 'both',
    pairing_open: env.CMC_PAIRING_OPEN ?? baseConfig.pairing_open ?? '0'
  });
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null)
  );
}
