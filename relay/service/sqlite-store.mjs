import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function createRelaySqliteStore(options = {}) {
  const path = resolve(options.path ?? process.env.RELAY_SQLITE_PATH ?? '.relay/relay.sqlite');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS devices (
      token TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      paired_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS hosts (
      host_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      kind TEXT,
      bridge_version TEXT,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'offline',
      last_seen_at TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS host_devices (
      host_device_id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      trusted_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_host_devices_host ON host_devices(host_id);
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_host ON sessions(host_id);
    CREATE TABLE IF NOT EXISTS timeline_events (
      session_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      cursor INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      cached_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (session_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_session_cursor ON timeline_events(session_id, cursor);
    CREATE TABLE IF NOT EXISTS git_audit_events (
      event_id TEXT PRIMARY KEY,
      audit_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      action TEXT NOT NULL,
      phase TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_git_audit_created ON git_audit_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_git_audit_filters ON git_audit_events(session_id, host_id, action, phase);
  `);
  ensureColumn(db, 'devices', 'revoked_at', 'TEXT');

  return {
    path,
    close() {
      db.close();
    },
    loadDevices() {
      return db.prepare('SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY paired_at ASC').all().map((row) => ({
        token: row.token,
        device_id: row.device_id,
        display_name: row.display_name,
        paired_at: row.paired_at,
        last_seen_at: row.last_seen_at,
        revoked_at: row.revoked_at ?? null
      }));
    },
    listDevices(options = {}) {
      const includeRevoked = options.includeRevoked === true;
      const rows = includeRevoked
        ? db.prepare('SELECT * FROM devices ORDER BY last_seen_at DESC').all()
        : db.prepare('SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY last_seen_at DESC').all();
      return rows.map((row) => ({
        device_id: row.device_id,
        display_name: row.display_name,
        paired_at: row.paired_at,
        last_seen_at: row.last_seen_at,
        revoked_at: row.revoked_at ?? null
      }));
    },
    saveDevice(token, device) {
      db.prepare(`
        INSERT INTO devices (token, device_id, display_name, paired_at, last_seen_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(token) DO UPDATE SET
          device_id = excluded.device_id,
          display_name = excluded.display_name,
          paired_at = excluded.paired_at,
          last_seen_at = excluded.last_seen_at,
          revoked_at = excluded.revoked_at
      `).run(token, device.device_id, device.display_name, device.paired_at, device.last_seen_at, device.revoked_at ?? null);
    },
    revokeDeviceById(deviceId) {
      const now = new Date().toISOString();
      const result = db.prepare('UPDATE devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL')
        .run(now, deviceId);
      return result.changes ?? 0;
    },
    loadHosts() {
      return db.prepare('SELECT * FROM hosts ORDER BY last_seen_at DESC').all().map((row) => ({
        ...parseJson(row.payload_json, {}),
        host_id: row.host_id,
        display_name: row.display_name,
        kind: row.kind ?? undefined,
        bridge_version: row.bridge_version ?? undefined,
        capabilities: parseJson(row.capabilities_json, []),
        status: 'offline',
        last_seen_at: row.last_seen_at
      }));
    },
    saveHost(host) {
      db.prepare(`
        INSERT INTO hosts (host_id, display_name, kind, bridge_version, capabilities_json, status, last_seen_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(host_id) DO UPDATE SET
          display_name = excluded.display_name,
          kind = excluded.kind,
          bridge_version = excluded.bridge_version,
          capabilities_json = excluded.capabilities_json,
          status = excluded.status,
          last_seen_at = excluded.last_seen_at,
          payload_json = excluded.payload_json
      `).run(
        host.host_id,
        host.display_name,
        host.kind ?? null,
        host.bridge_version ?? null,
        JSON.stringify(host.capabilities ?? []),
        host.status === 'online' ? 'offline' : (host.status ?? 'offline'),
        host.last_seen_at ?? new Date().toISOString(),
        JSON.stringify(host)
      );
    },
    findHostDeviceByToken(token) {
      const tokenHash = hashToken(token);
      const row = db.prepare(`
        SELECT * FROM host_devices
        WHERE token_hash = ? AND revoked_at IS NULL
      `).get(tokenHash);
      if (!row) {
        return null;
      }
      return {
        ...parseJson(row.payload_json, {}),
        host_device_id: row.host_device_id,
        host_id: row.host_id,
        display_name: row.display_name,
        token_hash: row.token_hash,
        trusted_at: row.trusted_at,
        last_seen_at: row.last_seen_at,
        revoked_at: row.revoked_at ?? null
      };
    },
    listHostDevices(options = {}) {
      const includeRevoked = options.includeRevoked === true;
      const rows = includeRevoked
        ? db.prepare('SELECT * FROM host_devices ORDER BY last_seen_at DESC').all()
        : db.prepare('SELECT * FROM host_devices WHERE revoked_at IS NULL ORDER BY last_seen_at DESC').all();
      return rows.map((row) => ({
        host_device_id: row.host_device_id,
        host_id: row.host_id,
        display_name: row.display_name,
        trusted_at: row.trusted_at,
        last_seen_at: row.last_seen_at,
        revoked_at: row.revoked_at ?? null
      }));
    },
    saveHostDevice(token, device) {
      const tokenHash = hashToken(token);
      db.prepare(`
        INSERT INTO host_devices (host_device_id, host_id, token_hash, display_name, trusted_at, last_seen_at, revoked_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(host_device_id) DO UPDATE SET
          host_id = excluded.host_id,
          display_name = excluded.display_name,
          last_seen_at = excluded.last_seen_at,
          revoked_at = excluded.revoked_at,
          payload_json = excluded.payload_json
      `).run(
        device.host_device_id,
        device.host_id,
        tokenHash,
        device.display_name,
        device.trusted_at,
        device.last_seen_at,
        device.revoked_at ?? null,
        JSON.stringify({ ...device, token_hash: tokenHash })
      );
      return tokenHash;
    },
    touchHostDevice(token) {
      const tokenHash = hashToken(token);
      const now = new Date().toISOString();
      db.prepare('UPDATE host_devices SET last_seen_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
        .run(now, tokenHash);
    },
    revokeHostDevice(hostDeviceId) {
      const now = new Date().toISOString();
      const result = db.prepare('UPDATE host_devices SET revoked_at = ? WHERE host_device_id = ? AND revoked_at IS NULL')
        .run(now, hostDeviceId);
      return result.changes ?? 0;
    },
    loadSessions() {
      return db.prepare('SELECT payload_json FROM sessions ORDER BY updated_at DESC').all()
        .map((row) => parseJson(row.payload_json, null))
        .filter(Boolean);
    },
    saveSession(session) {
      db.prepare(`
        INSERT INTO sessions (session_id, host_id, updated_at, payload_json)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          host_id = excluded.host_id,
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json
      `).run(
        session.session_id,
        session.host_id,
        session.updated_at ?? new Date().toISOString(),
        JSON.stringify(session)
      );
    },
    loadTimelineEvents(limitPerSession) {
      const rows = db.prepare(`
        SELECT payload_json
        FROM (
          SELECT payload_json, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY cursor DESC) AS rn
          FROM timeline_events
        )
        WHERE rn <= ?
      `).all(limitPerSession);
      return rows.map((row) => parseJson(row.payload_json, null)).filter(Boolean);
    },
    saveTimelineEvent(event) {
      db.prepare(`
        INSERT INTO timeline_events (session_id, event_id, cursor, created_at, cached_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, event_id) DO UPDATE SET
          cursor = excluded.cursor,
          created_at = excluded.created_at,
          cached_at = excluded.cached_at,
          payload_json = excluded.payload_json
      `).run(
        event.session_id,
        event.event_id,
        Number.parseInt(event.cursor ?? '0', 10) || 0,
        event.created_at ?? new Date().toISOString(),
        event.cached_at ?? new Date().toISOString(),
        JSON.stringify(event)
      );
    },
    trimTimelineEvents(limitPerSession) {
      db.prepare(`
        DELETE FROM timeline_events
        WHERE rowid IN (
          SELECT rowid
          FROM (
            SELECT rowid, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY cursor DESC) AS rn
            FROM timeline_events
          )
          WHERE rn > ?
        )
      `).run(limitPerSession);
    },
    loadGitAuditEvents(limit) {
      return db.prepare(`
        SELECT payload_json
        FROM git_audit_events
        ORDER BY created_at DESC
        LIMIT ?
      `).all(limit).reverse().map((row) => parseJson(row.payload_json, null)).filter(Boolean);
    },
    saveGitAuditEvent(event) {
      db.prepare(`
        INSERT INTO git_audit_events (event_id, audit_id, session_id, host_id, action, phase, created_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET
          payload_json = excluded.payload_json
      `).run(
        event.event_id,
        event.audit_id,
        event.session_id,
        event.host_id,
        event.action,
        event.phase,
        event.created_at,
        JSON.stringify(event)
      );
    },
    trimGitAuditEvents(limit) {
      db.prepare(`
        DELETE FROM git_audit_events
        WHERE event_id NOT IN (
          SELECT event_id FROM git_audit_events ORDER BY created_at DESC LIMIT ?
        )
      `).run(limit);
    },
    counts() {
      const count = (table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
      return {
        devices: count('devices'),
        hosts: count('hosts'),
        sessions: count('sessions'),
        timeline_events: count('timeline_events'),
        git_audit_events: count('git_audit_events'),
        host_devices: count('host_devices')
      };
    }
  };
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function parseJson(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
