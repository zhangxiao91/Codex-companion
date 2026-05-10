import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const checks = [
  { name: 'Java', command: 'java', args: ['-version'] },
  { name: 'Gradle', command: 'gradle', args: ['-version'], optional: true },
  { name: 'ADB', command: 'adb', args: ['version'], optional: true },
  { name: 'Android SDK', env: ['ANDROID_HOME', 'ANDROID_SDK_ROOT'], pathChecks: ['platforms', 'build-tools'] }
];

let failed = false;

for (const check of checks) {
  if (check.command) {
    const result = await run(check.command, check.args);
    if (result.ok) {
      console.log(`[ok] ${check.name}`);
      continue;
    }

    const level = check.optional ? 'warn' : 'missing';
    console.log(`[${level}] ${check.name}: ${result.error}`);
    if (!check.optional) {
      failed = true;
    }
    continue;
  }

  const root = check.env.map((name) => process.env[name]).find(Boolean);
  if (!root) {
    console.log(`[missing] ${check.name}: set ${check.env.join(' or ')}`);
    failed = true;
    continue;
  }

  const missing = check.pathChecks.filter((item) => !existsSync(join(root, item)));
  if (missing.length > 0) {
    console.log(`[missing] ${check.name}: ${root} is missing ${missing.join(', ')}`);
    failed = true;
    continue;
  }

  console.log(`[ok] ${check.name}: ${root}`);
}

if (failed) {
  console.log('\nInstall Android Studio, JDK 17, Android SDK Platform 36, Build Tools 36.0.0, and Platform Tools.');
  process.exit(1);
}

console.log('\nAndroid toolchain looks ready.');

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errorText = '';

    child.stderr.on('data', (chunk) => {
      errorText += chunk.toString();
    });
    child.on('error', (error) => {
      resolve({ ok: false, error: error.message });
    });
    child.on('exit', (code) => {
      resolve({ ok: code === 0, error: errorText.trim() || `exit code ${code}` });
    });
  });
}
