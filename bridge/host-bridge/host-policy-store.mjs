import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function createHostPolicyStore(options = {}) {
  const path = resolve(options.path ?? process.env.HOST_POLICY_PATH ?? '.relay/host-policy.json');
  return {
    path,
    load() {
      if (!existsSync(path)) {
        return defaultPolicy();
      }

      const raw = readFileSync(path, 'utf8');
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      return mergePolicy(parsed);
    },
    ensure() {
      if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(defaultPolicy(), null, 2)}\n`, 'utf8');
      }
      return path;
    }
  };
}

export function defaultPolicy() {
  return {
    power_control: {
      enabled: false,
      allow_keep_awake: false,
      allow_lock: false,
      max_keep_awake_seconds: 3600,
      allow_on_battery: false,
      trust_ttl_seconds: 2592000,
      challenge_ttl_seconds: 300,
      max_challenge_attempts: 5
    }
  };
}

function mergePolicy(policy) {
  const defaults = defaultPolicy();
  return {
    ...defaults,
    ...policy,
    power_control: {
      ...defaults.power_control,
      ...(policy.power_control ?? {})
    }
  };
}
