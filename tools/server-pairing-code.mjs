import { createPairingCode, createPairingPayload } from './pairing-code.mjs';
import { displayPairingCode } from './pairing-display.mjs';
import { loadServerRelayConfig } from './server-relay-config.mjs';

const config = loadConfigSafely();
const relayUrl = firstNonBlank(
  process.env.RELAY_PUBLIC_WS_URL,
  process.env.RELAY_ANDROID_URL,
  process.env.RELAY_URL,
  config.public_ws_url
);
const pairingToken = firstNonBlank(
  process.env.RELAY_PAIRING_TOKEN,
  process.env.RELAY_DEV_TOKEN,
  process.env.DEV_TOKEN,
  config.pairing_token
);

if (!relayUrl) {
  throw new Error('Set RELAY_PUBLIC_WS_URL, RELAY_ANDROID_URL, or RELAY_URL to the server WebSocket URL.');
}

if (!pairingToken) {
  throw new Error('Set RELAY_PAIRING_TOKEN or RELAY_DEV_TOKEN before generating a server pairing code.');
}

const pairingCode = createPairingCode(createPairingPayload({
  relayUrl,
  pairingToken
}));

console.log('[pairing] Server Relay URL:');
console.log(relayUrl);
console.log('');
console.log('[pairing] Pairing code:');
console.log(pairingCode);
console.log('');
await displayPairingCode({
  pairingCode,
  relayUrl,
  title: 'Codex Mobile Companion Server Pairing'
});
console.log('');
console.log('[pairing] Paste this code into Android > Relay connection > Pairing code, then tap Use code.');

function loadConfigSafely() {
  try {
    return loadServerRelayConfig();
  } catch {
    return {};
  }
}

function firstNonBlank(...values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) {
      return normalized;
    }
  }
  return '';
}
