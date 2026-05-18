import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPairingCode, createPairingPayload } from './pairing-code.mjs';
import { displayPairingCode } from './pairing-display.mjs';

const relayUrl = 'wss://relay.example.com';
const pairingCode = createPairingCode(createPairingPayload({
  relayUrl,
  pairingToken: 'cmc_pairing_qr_verify_token_0123456789',
  createdAt: '2026-05-17T00:00:00.000Z'
}));
const tempDir = mkdtempSync(join(tmpdir(), 'cmc-pairing-qr-'));

try {
  const htmlResult = await displayPairingCode({
    pairingCode,
    relayUrl,
    title: 'Verify Pairing QR',
    outputDir: tempDir,
    mode: 'html'
  });

  if (!htmlResult.htmlPath || !existsSync(htmlResult.htmlPath)) {
    throw new Error('Expected pairing HTML page to be generated.');
  }

  const html = readFileSync(htmlResult.htmlPath, 'utf8');
  if (!html.includes(pairingCode)) {
    throw new Error('Pairing HTML does not contain pairing code.');
  }
  if (!html.includes(relayUrl)) {
    throw new Error('Pairing HTML does not contain Relay URL.');
  }
  if (!html.includes('<svg')) {
    throw new Error('Pairing HTML does not contain SVG QR code.');
  }

  const noneResult = await displayPairingCode({
    pairingCode,
    relayUrl,
    title: 'Verify No QR',
    outputDir: join(tempDir, 'none'),
    mode: 'none'
  });
  if (noneResult.htmlPath !== null || existsSync(join(tempDir, 'none'))) {
    throw new Error('Expected CMC_PAIRING_QR=none behavior to skip HTML generation.');
  }

  console.log('[verify] Pairing QR generation verified.');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
