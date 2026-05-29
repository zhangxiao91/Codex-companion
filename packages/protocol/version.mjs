import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageJson = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));

export const CMC_VERSION = process.env.CMC_VERSION ?? packageJson.version ?? '0.0.0';
export const CMC_PROTOCOL_VERSION = 1;

