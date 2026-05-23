import { randomInt, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createHostPolicyStore } from './host-policy-store.mjs';

export function createPowerController(hostId, displayName) {
  const policyStore = createHostPolicyStore();
  const policy = policyStore.load();
  policyStore.ensure();
  const challenges = new Map();
  let keepAwakeUntil = null;
  let keepAwakeProcess = null;
  const mockMode = process.env.CMC_POWER_MOCK === '1' || process.platform !== 'win32';

  return {
    policyPath: policyStore.path,
    capabilities() {
      const capabilities = ['power.status'];
      if (policy.power_control.enabled) {
        capabilities.push('power.trust');
        if (policy.power_control.allow_keep_awake) {
          capabilities.push('power.keep_awake');
        }
        if (policy.power_control.allow_lock) {
          capabilities.push('power.lock');
        }
      }
      return capabilities;
    },
    status() {
      return {
        host_id: hostId,
        status: {
          platform: process.platform,
          power_control_enabled: policy.power_control.enabled === true,
          allow_keep_awake: policy.power_control.allow_keep_awake === true,
          allow_lock: policy.power_control.allow_lock === true,
          keep_awake_active: keepAwakeUntil ? Date.parse(keepAwakeUntil) > Date.now() : false,
          keep_awake_until: keepAwakeUntil,
          mock_mode: mockMode,
          policy_path: policyStore.path,
          checked_at: new Date().toISOString()
        }
      };
    },
    createTrustChallenge(deviceId, deviceDisplayName) {
      assertPolicyEnabled();
      const challengeId = randomUUID();
      const code = randomInt(0, 1000000).toString().padStart(6, '0');
      const expiresAt = new Date(Date.now() + policy.power_control.challenge_ttl_seconds * 1000).toISOString();
      challenges.set(challengeId, {
        challengeId,
        code,
        deviceId,
        deviceDisplayName,
        expiresAt,
        attempts: 0
      });
      console.log('');
      console.log(`[bridge] Power control verification code for ${deviceDisplayName || deviceId}: ${code}`);
      console.log(`[bridge] Code expires at ${expiresAt}. Challenge stays only in Host Bridge memory.`);
      console.log('');
      return {
        host_id: hostId,
        challenge_id: challengeId,
        device_id: deviceId,
        device_display_name: deviceDisplayName,
        expires_at: expiresAt,
        message: `Enter the 6-digit code shown on ${displayName}.`
      };
    },
    verifyTrustChallenge(challengeId, code, deviceId, deviceDisplayName) {
      assertPolicyEnabled();
      const challenge = challenges.get(challengeId);
      if (!challenge) {
        return {
          ok: false,
          reason: 'challenge_not_found'
        };
      }

      if (challenge.deviceId !== deviceId) {
        return {
          ok: false,
          reason: 'device_mismatch'
        };
      }

      if (Date.parse(challenge.expiresAt) <= Date.now()) {
        challenges.delete(challengeId);
        return {
          ok: false,
          reason: 'challenge_expired'
        };
      }

      challenge.attempts += 1;
      if (challenge.attempts > policy.power_control.max_challenge_attempts) {
        challenges.delete(challengeId);
        return {
          ok: false,
          reason: 'too_many_attempts'
        };
      }

      if (String(code).trim() !== challenge.code) {
        return {
          ok: false,
          reason: 'invalid_code'
        };
      }

      challenges.delete(challengeId);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + policy.power_control.trust_ttl_seconds * 1000).toISOString();
      return {
        ok: true,
        trust: {
          trust_id: randomUUID(),
          host_id: hostId,
          device_id: deviceId,
          device_display_name: deviceDisplayName || challenge.deviceDisplayName || '',
          capabilities: allowedPowerCapabilities(policy),
          granted_at: now.toISOString(),
          expires_at: expiresAt
        }
      };
    },
    async handlePowerRequest(payload) {
      assertPolicyEnabled();
      if (payload.action === 'keep_awake') {
        return startKeepAwake(payload);
      }
      if (payload.action === 'lock') {
        return lockPc(payload);
      }
      return {
        status: 'rejected',
        reason: `unsupported_action:${payload.action}`
      };
    }
  };

  function assertPolicyEnabled() {
    if (!policy.power_control.enabled) {
      throw new Error(`Power control is disabled. Enable it in ${policyStore.path}.`);
    }
  }

  async function startKeepAwake(payload) {
    if (!policy.power_control.allow_keep_awake) {
      return {
        status: 'rejected',
        reason: 'keep_awake_disabled_by_host_policy'
      };
    }

    const requestedSeconds = Number.parseInt(payload.duration_seconds ?? '1800', 10);
    const durationSeconds = Math.min(
      Number.isFinite(requestedSeconds) && requestedSeconds > 0 ? requestedSeconds : 1800,
      policy.power_control.max_keep_awake_seconds
    );
    keepAwakeUntil = new Date(Date.now() + durationSeconds * 1000).toISOString();

    if (!mockMode) {
      stopKeepAwakeProcess();
      keepAwakeProcess = spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-Command',
        keepAwakePowerShell(durationSeconds)
      ], {
        stdio: 'ignore',
        windowsHide: true
      });
      keepAwakeProcess.on('exit', () => {
        keepAwakeProcess = null;
      });
    }

    return {
      status: 'accepted',
      reason: mockMode ? 'mock_keep_awake' : 'windows_execution_state',
      expires_at: keepAwakeUntil,
      duration_seconds: durationSeconds
    };
  }

  async function lockPc() {
    if (!policy.power_control.allow_lock) {
      return {
        status: 'rejected',
        reason: 'lock_disabled_by_host_policy'
      };
    }

    if (!mockMode) {
      spawn('rundll32.exe', ['user32.dll,LockWorkStation'], {
        stdio: 'ignore',
        windowsHide: true,
        detached: true
      }).unref();
    }

    return {
      status: 'accepted',
      reason: mockMode ? 'mock_lock' : 'windows_lock_workstation'
    };
  }

  function stopKeepAwakeProcess() {
    if (keepAwakeProcess && !keepAwakeProcess.killed) {
      keepAwakeProcess.kill();
    }
    keepAwakeProcess = null;
  }
}

function allowedPowerCapabilities(policy) {
  const capabilities = [];
  if (policy.power_control.allow_keep_awake) {
    capabilities.push('power.keep_awake');
  }
  if (policy.power_control.allow_lock) {
    capabilities.push('power.lock');
  }
  return capabilities;
}

function keepAwakePowerShell(durationSeconds) {
  return `
Add-Type -Namespace CMC -Name Native -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);';
$end = (Get-Date).AddSeconds(${durationSeconds});
while ((Get-Date) -lt $end) {
  [CMC.Native]::SetThreadExecutionState(0x80000000 -bor 0x00000001 -bor 0x00000040) | Out-Null;
  Start-Sleep -Seconds 20;
}
[CMC.Native]::SetThreadExecutionState(0x80000000) | Out-Null;
`.replace(/\s+/g, ' ').trim();
}
