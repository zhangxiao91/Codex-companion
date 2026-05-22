import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const tempDir = mkdtempSync(join(tmpdir(), 'cmc-dev-pairing-open-'));
const child = spawn('node', ['tools/dev-pairing-start.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    RELAY_PORT: '8828',
    RELAY_LAN_HOST: '192.0.2.11',
    CMC_PAIRING_QR: 'html',
    CMC_PAIRING_OPEN: '0',
    CMC_PAIRING_OUTPUT_DIR: tempDir
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  output += chunk.toString();
});

try {
  await waitForOutput('[pairing] Pairing page:', 10000);
  await waitForOutput('Auto-open disabled by CMC_PAIRING_OPEN=0.', 10000);
  const htmlPath = join(tempDir, 'pairing.html');
  if (!existsSync(htmlPath)) {
    throw new Error('Expected pairing HTML page to be generated.');
  }
  const html = readFileSync(htmlPath, 'utf8');
  for (const expected of ['Codex Mobile Companion', 'Relay', 'Host Bridge', 'Android URL', '192.0.2.11:8828']) {
    if (!html.includes(expected)) {
      throw new Error(`Pairing page missing expected content: ${expected}`);
    }
  }
  console.log('[verify] Dev pairing one-click page generation verified.');
} finally {
  if (!child.killed) {
    child.kill();
  }
  await delay(300);
  rmSync(tempDir, { recursive: true, force: true });
}

async function waitForOutput(needle, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (output.includes(needle)) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for output: ${needle}\n${output}`);
}
