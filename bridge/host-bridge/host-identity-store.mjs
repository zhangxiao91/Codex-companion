import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function createHostIdentityStore(options = {}) {
  const path = resolve(options.path ?? process.env.HOST_IDENTITY_PATH ?? '.relay/host-identity.json');

  return {
    path,
    load() {
      if (!existsSync(path)) {
        return {};
      }
      const raw = readFileSync(path, 'utf8');
      return raw.trim() ? JSON.parse(raw) : {};
    },
    save(identity) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({
        version: 1,
        saved_at: new Date().toISOString(),
        ...identity
      }, null, 2)}\n`, 'utf8');
    }
  };
}
