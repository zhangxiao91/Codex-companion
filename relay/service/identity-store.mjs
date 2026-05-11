import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function createIdentityStore(options = {}) {
  const path = resolve(options.path ?? process.env.RELAY_IDENTITY_STORE_PATH ?? '.relay/identity-store.json');

  return {
    path,
    load() {
      if (!existsSync(path)) {
        return {
          devices: [],
          hosts: []
        };
      }

      const raw = readFileSync(path, 'utf8');
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      return {
        devices: Array.isArray(parsed.devices) ? parsed.devices.filter(isStoredDevice) : [],
        hosts: Array.isArray(parsed.hosts) ? parsed.hosts.filter(isStoredHost) : []
      };
    },
    save(snapshot) {
      mkdirSync(dirname(path), { recursive: true });
      const safeSnapshot = {
        version: 1,
        saved_at: new Date().toISOString(),
        devices: Array.isArray(snapshot.devices) ? snapshot.devices.filter(isStoredDevice) : [],
        hosts: Array.isArray(snapshot.hosts) ? snapshot.hosts.filter(isStoredHost) : []
      };
      writeFileSync(path, `${JSON.stringify(safeSnapshot, null, 2)}\n`, 'utf8');
    }
  };
}

export function snapshotIdentityState({ deviceTokens, hosts }) {
  return {
    devices: [...deviceTokens.entries()].map(([token, device]) => ({
      token,
      device_id: device.device_id,
      display_name: device.display_name,
      paired_at: device.paired_at,
      last_seen_at: device.last_seen_at
    })),
    hosts: [...hosts.values()].map((host) => ({
      host_id: host.host_id,
      display_name: host.display_name,
      kind: host.kind,
      bridge_version: host.bridge_version,
      capabilities: host.capabilities,
      last_seen_at: host.last_seen_at,
      status: host.status === 'online' ? 'offline' : (host.status ?? 'offline')
    }))
  };
}

function isStoredDevice(device) {
  return device
    && typeof device.token === 'string'
    && typeof device.device_id === 'string'
    && typeof device.display_name === 'string';
}

function isStoredHost(host) {
  return host
    && typeof host.host_id === 'string'
    && typeof host.display_name === 'string';
}

