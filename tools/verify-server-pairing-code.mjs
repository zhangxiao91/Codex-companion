import { strict as assert } from 'node:assert';
import { createPairingCode, createPairingPayload } from './pairing-code.mjs';

const payload = createPairingPayload({
  relayUrl: 'wss://relay.example.com',
  pairingToken: 'cmc_server_token_example_0123456789'
});
const code = createPairingCode(payload);

assert.ok(code.startsWith('cmc1.'));
const decoded = JSON.parse(Buffer.from(code.slice('cmc1.'.length), 'base64url').toString('utf8'));
assert.equal(decoded.relay_url, 'wss://relay.example.com');
assert.equal(decoded.pairing_token, 'cmc_server_token_example_0123456789');
assert.ok(typeof decoded.created_at === 'string' && decoded.created_at.length > 0);

console.log('[verify] Server pairing code generation verified.');

