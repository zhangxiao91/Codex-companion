const httpUrl = trimTrailingSlash(process.env.RELAY_PUBLIC_HTTP_URL
  ?? process.env.RELAY_HTTP_URL
  ?? 'http://127.0.0.1:8787');
const adminToken = process.env.RELAY_ADMIN_TOKEN
  ?? process.env.RELAY_HOST_TOKEN
  ?? process.env.RELAY_PAIRING_TOKEN
  ?? process.env.RELAY_DEV_TOKEN
  ?? process.env.DEV_TOKEN
  ?? '';
const command = process.argv[2] ?? 'list';

if (!adminToken) {
  throw new Error('Set RELAY_ADMIN_TOKEN, RELAY_HOST_TOKEN, RELAY_PAIRING_TOKEN, or RELAY_DEV_TOKEN.');
}

if (command === 'list') {
  const includeRevoked = process.argv.includes('--all') || process.argv.includes('--include-revoked');
  const result = await requestJson(`/devices${includeRevoked ? '?include_revoked=1' : ''}`);
  printDevices(result);
} else if (command === 'revoke') {
  const type = process.argv[3];
  const id = process.argv[4];
  if (!['android', 'host'].includes(type) || !id) {
    throw new Error('Usage: npm run server:devices -- revoke <android|host> <device-id|host-device-id>');
  }
  const body = type === 'android'
    ? { type, device_id: id }
    : { type, host_device_id: id };
  const result = await requestJson('/devices/revoke', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  console.log(JSON.stringify(result, null, 2));
} else {
  throw new Error('Usage: npm run server:devices -- list [--all] | revoke <android|host> <id>');
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${httpUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      'X-Relay-Auth-Token': adminToken
    },
    body: options.body
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`${response.status} ${json.detail ?? json.error ?? 'request failed'}`);
  }
  return json;
}

function printDevices(result) {
  console.log('Android devices');
  for (const device of result.devices ?? []) {
    console.log(`- ${device.device_id} | ${device.display_name} | last seen ${device.last_seen_at}${device.revoked_at ? ` | revoked ${device.revoked_at}` : ''}`);
  }
  if ((result.devices ?? []).length === 0) {
    console.log('- none');
  }

  console.log('');
  console.log('Host devices');
  for (const device of result.host_devices ?? []) {
    console.log(`- ${device.host_device_id} | ${device.host_id} | ${device.display_name} | last seen ${device.last_seen_at}${device.revoked_at ? ` | revoked ${device.revoked_at}` : ''}`);
  }
  if ((result.host_devices ?? []).length === 0) {
    console.log('- none');
  }
}

function trimTrailingSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}
