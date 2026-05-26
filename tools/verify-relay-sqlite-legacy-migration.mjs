import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRelaySqliteStore } from '../relay/service/sqlite-store.mjs';

const tempDir = await mkdtemp(join(tmpdir(), 'cmc-legacy-sqlite-'));
const sqlitePath = join(tempDir, 'relay.sqlite');

try {
  createLegacyRelayDatabase(sqlitePath);
  const store = createRelaySqliteStore({ path: sqlitePath });

  const counts = store.counts();
  assertEqual(counts.sessions, 1, 'session count after migration');

  const entries = store.loadSessionSyncEntries({
    deviceId: 'legacy-device',
    includeClean: true,
    limit: 10
  }).entries;
  assertEqual(entries.length, 1, 'sync entries after migration');
  assertEqual(entries[0].session.session_id, 'legacy-session', 'legacy session id');
  assertEqual(entries[0].snapshot_revision >= 1, true, 'snapshot revision backfilled');
  assertEqual(entries[0].stage_revision >= 1, true, 'stage revision backfilled');
  assertEqual(entries[0].sync_revision >= 1, true, 'sync revision backfilled');
  assertEqual(entries[0].timeline_newest_cursor, 7, 'timeline newest cursor backfilled');
  assertEqual(entries[0].timeline_oldest_cursor, 7, 'timeline oldest cursor backfilled');

  store.close();
  console.log('[verify] Relay legacy SQLite migration verified.');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function createLegacyRelayDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE timeline_events (
      session_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      cursor INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      cached_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (session_id, event_id)
    );
  `);
  const session = {
    session_id: 'legacy-session',
    host_id: 'legacy-host',
    project_name: 'Legacy SQLite',
    repo_path: process.cwd(),
    branch: 'main',
    status: 'completed',
    summary: 'Legacy session row before sync columns existed.',
    updated_at: '2026-05-26T00:00:00.000Z'
  };
  const event = {
    event_id: 'legacy-event',
    session_id: 'legacy-session',
    cursor: '7',
    created_at: '2026-05-26T00:01:00.000Z',
    type: 'assistant_message',
    title: 'Legacy event',
    summary: 'Legacy event',
    payload: {},
    redaction_level: 'none'
  };
  db.prepare('INSERT INTO sessions (session_id, host_id, updated_at, payload_json) VALUES (?, ?, ?, ?)')
    .run(session.session_id, session.host_id, session.updated_at, JSON.stringify(session));
  db.prepare('INSERT INTO timeline_events (session_id, event_id, cursor, created_at, cached_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(event.session_id, event.event_id, 7, event.created_at, event.created_at, JSON.stringify(event));
  db.close();
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}
