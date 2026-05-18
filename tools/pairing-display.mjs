import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import QRCode from 'qrcode';

const DEFAULT_OUTPUT_DIR = '.relay/pairing';

export async function displayPairingCode({
  pairingCode,
  relayUrl,
  title = 'Codex Mobile Companion Pairing',
  outputDir = process.env.CMC_PAIRING_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR,
  mode = process.env.CMC_PAIRING_QR ?? 'both'
}) {
  const normalizedMode = normalizeMode(mode);
  if (normalizedMode === 'none') {
    return {
      mode: normalizedMode,
      htmlPath: null
    };
  }

  const result = {
    mode: normalizedMode,
    htmlPath: null
  };

  if (normalizedMode === 'both' || normalizedMode === 'terminal') {
    console.log('[pairing] QR code:');
    console.log(await QRCode.toString(pairingCode, {
      type: 'terminal',
      small: true,
      margin: 1
    }));
  }

  if (normalizedMode === 'both' || normalizedMode === 'html') {
    const absoluteOutputDir = resolve(outputDir);
    mkdirSync(absoluteOutputDir, { recursive: true });
    const qrSvg = await QRCode.toString(pairingCode, {
      type: 'svg',
      margin: 2,
      errorCorrectionLevel: 'M'
    });
    const htmlPath = resolve(absoluteOutputDir, 'pairing.html');
    writeFileSync(htmlPath, renderPairingHtml({
      title,
      relayUrl,
      pairingCode,
      qrSvg
    }), 'utf8');
    result.htmlPath = htmlPath;
    console.log(`[pairing] Pairing page: ${htmlPath}`);
  }

  return result;
}

function normalizeMode(mode) {
  const normalized = String(mode ?? '').trim().toLowerCase();
  if (['both', 'terminal', 'html', 'none'].includes(normalized)) {
    return normalized;
  }

  console.warn(`[pairing] Unknown CMC_PAIRING_QR=${mode}; using both.`);
  return 'both';
}

function renderPairingHtml({ title, relayUrl, pairingCode, qrSvg }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f7fb;
      color: #171a21;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px;
    }
    main {
      width: min(720px, 100%);
      border: 1px solid #d8dde8;
      border-radius: 8px;
      background: #ffffff;
      padding: 28px;
      box-shadow: 0 16px 36px rgba(18, 28, 45, 0.08);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 24px;
      line-height: 1.2;
      letter-spacing: 0;
    }
    p {
      margin: 0 0 18px;
      color: #4c5567;
      line-height: 1.5;
    }
    .qr {
      display: grid;
      place-items: center;
      padding: 18px;
      border: 1px solid #e2e6ef;
      border-radius: 8px;
      background: #fff;
    }
    .qr svg {
      width: min(420px, 100%);
      height: auto;
      display: block;
    }
    dl {
      margin: 22px 0 0;
      display: grid;
      gap: 14px;
    }
    dt {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #687386;
    }
    dd {
      margin: 6px 0 0;
    }
    code {
      display: block;
      overflow-wrap: anywhere;
      word-break: break-word;
      border: 1px solid #e2e6ef;
      border-radius: 6px;
      padding: 12px;
      background: #f8fafc;
      color: #171a21;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      line-height: 1.45;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        background: #0f1218;
        color: #f3f5f8;
      }
      main {
        background: #171b24;
        border-color: #303747;
        box-shadow: none;
      }
      p, dt {
        color: #a7b0c2;
      }
      .qr, code {
        border-color: #303747;
        background: #f7f8fb;
        color: #111827;
      }
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>Scan this QR code from the Android app, or paste the pairing code manually.</p>
    <div class="qr" aria-label="Pairing QR code">
      ${qrSvg}
    </div>
    <dl>
      <div>
        <dt>Relay URL</dt>
        <dd><code>${escapeHtml(relayUrl)}</code></dd>
      </div>
      <div>
        <dt>Pairing code</dt>
        <dd><code>${escapeHtml(pairingCode)}</code></dd>
      </div>
    </dl>
  </main>
</body>
</html>
`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
