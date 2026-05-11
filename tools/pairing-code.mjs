export function createPairingCode(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `cmc1.${encoded}`;
}

export function createPairingPayload({ relayUrl, pairingToken, createdAt = new Date().toISOString() }) {
  if (!relayUrl || typeof relayUrl !== 'string') {
    throw new Error('relayUrl is required.');
  }

  if (!relayUrl.startsWith('ws://') && !relayUrl.startsWith('wss://')) {
    throw new Error('relayUrl must start with ws:// or wss://.');
  }

  if (!pairingToken || typeof pairingToken !== 'string') {
    throw new Error('pairingToken is required.');
  }

  return {
    relay_url: relayUrl,
    pairing_token: pairingToken,
    created_at: createdAt
  };
}

