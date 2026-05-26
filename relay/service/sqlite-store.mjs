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
      snapshot_revision INTEGER NOT NULL DEFAULT 1,
      stage_revision INTEGER NOT NULL DEFAULT 1,
      sync_revision INTEGER NOT NULL DEFAULT 1,
      metadata_hash TEXT,
      stage_hash TEXT,
      timeline_newest_cursor INTEGER NOT NULL DEFAULT 0,
      timeline_oldest_cursor INTEGER,
      last_event_at TEXT,
      sync_updated_at TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_host ON sessions(host_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_sync_revision ON sessions(sync_revision);
    CREATE INDEX IF NOT EXISTS idx_sessions_host_sync ON sessions(host_id, sync_revision);
    CREATE INDEX IF NOT EXISTS idx_sessions_timeline_cursor ON sessions(timeline_newest_cursor);
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
    CREATE TABLE IF NOT EXISTS prompt_queue_states (
      session_id TEXT PRIMARY KEY,
      host_id TEXT,
      depth INTEGER NOT NULL DEFAULT 0,
      max_depth INTEGER NOT NULL DEFAULT 5,
      active_turn_id TEXT,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS approvals (
      approval_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TEXT,
      decided_at TEXT,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(session_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_status_updated ON approvals(status, updated_at);
    CREATE TABLE IF NOT EXISTS notification_events (
      notification_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      session_id TEXT,
      host_id TEXT,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notification_events_created ON notification_events(created_at);
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
    CREATE TABLE IF NOT EXISTS power_control_trusts (
      trust_id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_display_name TEXT NOT NULL,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      granted_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(host_id, device_id)
    );
    CREATE INDEX IF NOT EXISTS idx_power_trusts_host_device ON power_control_trusts(host_id, device_id);
    CREATE TABLE IF NOT EXISTS power_audit_events (
      event_id TEXT PRIMARY KEY,
      audit_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      action TEXT NOT NULL,
      phase TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_power_audit_created ON power_audit_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_power_audit_filters ON power_audit_events(host_id, device_id, action, phase);
    CREATE TABLE IF NOT EXISTS device_session_sync (
      device_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      seen_snapshot_revision INTEGER NOT NULL DEFAULT 0,
      seen_stage_revision INTEGER NOT NULL DEFAULT 0,
      seen_timeline_cursor INTEGER NOT NULL DEFAULT 0,
      seen_sync_revision INTEGER NOT NULL DEFAULT 0,
      seen_at TEXT NOT NULL,
      opened_at TEXT,
      archived_at TEXT,
      pinned_at TEXT,
      PRIMARY KEY (device_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_device_session_sync_device
      ON device_session_sync(device_id, seen_sync_revision);
    CREATE INDEX IF NOT EXISTS idx_device_session_sync_session
      ON device_session_sync(session_id);
    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
    ensureColumn(db, 'devices', 'revoked_at', 'TEXT');
    ensureColumn(db, 'approvals', 'requested_at', 'TEXT');
    ensureColumn(db, 'approvals', 'decided_at', 'TEXT');
    ensureColumn(db, 'sessions', 'snapshot_revision', 'INTEGER NOT NULL DEFAULT 1');
    ensureColumn(db, 'sessions', 'stage_revision', 'INTEGER NOT NULL DEFAULT 1');
    ensureColumn(db, 'sessions', 'sync_revision', 'INTEGER NOT NULL DEFAULT 1');
    ensureColumn(db, 'sessions', 'metadata_hash', 'TEXT');
    ensureColumn(db, 'sessions', 'stage_hash', 'TEXT');
    ensureColumn(db, 'sessions', 'timeline_newest_cursor', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(db, 'sessions', 'timeline_oldest_cursor', 'INTEGER');
    ensureColumn(db, 'sessions', 'last_event_at', 'TEXT');
    ensureColumn(db, 'sessions', 'sync_updated_at', 'TEXT');
    initializeSyncMeta(db);
    backfillSessionSyncMetadata(db);

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
      const now = new Date().toISOString();
      const existing = db.prepare(`
        SELECT snapshot_revision, stage_revision, sync_revision, metadata_hash, stage_hash
        FROM sessions
        WHERE session_id = ?
      `).get(session.session_id);
      const metadataHash = hashObject(normalizeSessionMetadata(session));
      const stageHash = hashObject(session.stage ?? null);
      const snapshotChanged = !existing || existing.metadata_hash !== metadataHash;
      const stageChanged = !existing || existing.stage_hash !== stageHash;
      const syncChanged = snapshotChanged || stageChanged;
      const syncRevision = syncChanged ? nextSyncRevision(db) : existing.sync_revision;
      const snapshotRevision = existing
        ? existing.snapshot_revision + (snapshotChanged ? 1 : 0)
        : 1;
      const stageRevision = existing
        ? existing.stage_revision + (stageChanged ? 1 : 0)
        : 1;
      db.prepare(`
        INSERT INTO sessions (
          session_id,
          host_id,
          updated_at,
          snapshot_revision,
          stage_revision,
          sync_revision,
          metadata_hash,
          stage_hash,
          sync_updated_at,
          payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          host_id = excluded.host_id,
          updated_at = excluded.updated_at,
          snapshot_revision = excluded.snapshot_revision,
          stage_revision = excluded.stage_revision,
          sync_revision = excluded.sync_revision,
          metadata_hash = excluded.metadata_hash,
          stage_hash = excluded.stage_hash,
          sync_updated_at = COALESCE(excluded.sync_updated_at, sessions.sync_updated_at),
          payload_json = excluded.payload_json
      `).run(
        session.session_id,
        session.host_id,
        session.updated_at ?? now,
        snapshotRevision,
        stageRevision,
        syncRevision,
        metadataHash,
        stageHash,
        syncChanged ? now : null,
        JSON.stringify(session)
      );
    },
    loadSessionSyncEntries(options = {}) {
      const deviceId = options.deviceId ?? '';
      const limit = clampInteger(options.limit, 1, 1000, 200);
      const syncCursor = clampInteger(options.cursor, 0, Number.MAX_SAFE_INTEGER, 0);
      const includeClean = options.includeClean === true;
      const includeArchived = options.includeArchived === true;
      const sessionIds = Array.isArray(options.sessionIds)
        ? options.sessionIds.map((value) => String(value)).filter(Boolean)
        : [];
      const selectedSessionId = options.selectedSessionId ? String(options.selectedSessionId) : '';
      const params = [deviceId];
      const filters = ['s.sync_revision > ?'];
      params.push(syncCursor);
      if (sessionIds.length > 0) {
        filters.push(`s.session_id IN (${sessionIds.map(() => '?').join(', ')})`);
        params.push(...sessionIds);
      }
      if (!includeClean) {
        filters.push(`(
          d.session_id IS NULL
          OR s.snapshot_revision > COALESCE(d.seen_snapshot_revision, 0)
          OR s.stage_revision > COALESCE(d.seen_stage_revision, 0)
          OR s.timeline_newest_cursor > COALESCE(d.seen_timeline_cursor, 0)
          OR (
            s.timeline_oldest_cursor IS NOT NULL
            AND COALESCE(d.seen_timeline_cursor, 0) > 0
            AND COALESCE(d.seen_timeline_cursor, 0) < s.timeline_oldest_cursor
          )
          OR s.sync_revision > COALESCE(d.seen_sync_revision, 0)
        )`);
      }
      if (!includeArchived) {
        filters.push('d.archived_at IS NULL');
      }

      const rows = db.prepare(`
        SELECT
          s.session_id,
          s.host_id,
          s.updated_at,
          s.snapshot_revision,
          s.stage_revision,
          s.sync_revision,
          s.timeline_newest_cursor,
          s.timeline_oldest_cursor,
          s.last_event_at,
          s.sync_updated_at,
          s.payload_json,
          d.seen_snapshot_revision,
          d.seen_stage_revision,
          d.seen_timeline_cursor,
          d.seen_sync_revision,
          d.seen_at,
          d.opened_at,
          d.archived_at,
          d.pinned_at
        FROM sessions s
        LEFT JOIN device_session_sync d
          ON d.device_id = ? AND d.session_id = s.session_id
        WHERE ${filters.join(' AND ')}
        ORDER BY
          CASE WHEN s.session_id = ? THEN 0 ELSE 1 END,
          s.sync_revision DESC,
          s.updated_at DESC
        LIMIT ?
      `).all(...params, selectedSessionId, limit + 1);
      const selectedRows = rows.slice(0, limit);
      return {
        entries: selectedRows.map((row) => ({
          session: parseJson(row.payload_json, null),
          session_id: row.session_id,
          snapshot_revision: row.snapshot_revision ?? 1,
          stage_revision: row.stage_revision ?? 1,
          sync_revision: row.sync_revision ?? 1,
          timeline_newest_cursor: row.timeline_newest_cursor ?? 0,
          timeline_oldest_cursor: row.timeline_oldest_cursor ?? null,
          last_event_at: row.last_event_at ?? null,
          sync_updated_at: row.sync_updated_at ?? null,
          device_seen: {
            seen_snapshot_revision: row.seen_snapshot_revision ?? 0,
            seen_stage_revision: row.seen_stage_revision ?? 0,
            seen_timeline_cursor: row.seen_timeline_cursor ?? 0,
            seen_sync_revision: row.seen_sync_revision ?? 0,
            seen_at: row.seen_at ?? null,
            opened_at: row.opened_at ?? null,
            archived_at: row.archived_at ?? null,
            pinned_at: row.pinned_at ?? null
          }
        })).filter((entry) => entry.session),
        has_more: rows.length > limit,
        next_cursor: rows.length > limit ? String(selectedRows.at(-1)?.sync_revision ?? syncCursor) : null,
        unchanged_count: countUnchangedSessions(db, deviceId, includeArchived)
      };
    },
    saveDeviceSessionSync(deviceId, ack) {
      const sessionId = ack.session_id;
      if (!sessionId) {
        throw new Error('sync ack missing session_id');
      }
      const session = db.prepare(`
        SELECT snapshot_revision, stage_revision, sync_revision, timeline_newest_cursor
        FROM sessions
        WHERE session_id = ?
      `).get(sessionId);
      if (!session) {
        throw new Error(`Unknown session for sync ack: ${sessionId}`);
      }
      const seenSnapshotRevision = clampInteger(ack.seen_snapshot_revision, 0, session.snapshot_revision, 0);
      const seenStageRevision = clampInteger(ack.seen_stage_revision, 0, session.stage_revision, 0);
      const seenTimelineCursor = clampInteger(ack.seen_timeline_cursor, 0, session.timeline_newest_cursor, 0);
      const seenSyncRevision = clampInteger(ack.seen_sync_revision, 0, session.sync_revision, 0);
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO device_session_sync (
          device_id,
          session_id,
          seen_snapshot_revision,
          seen_stage_revision,
          seen_timeline_cursor,
          seen_sync_revision,
          seen_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id, session_id) DO UPDATE SET
          seen_snapshot_revision = max(device_session_sync.seen_snapshot_revision, excluded.seen_snapshot_revision),
          seen_stage_revision = max(device_session_sync.seen_stage_revision, excluded.seen_stage_revision),
          seen_timeline_cursor = max(device_session_sync.seen_timeline_cursor, excluded.seen_timeline_cursor),
          seen_sync_revision = max(device_session_sync.seen_sync_revision, excluded.seen_sync_revision),
          seen_at = excluded.seen_at
      `).run(
        deviceId,
        sessionId,
        seenSnapshotRevision,
        seenStageRevision,
        seenTimelineCursor,
        seenSyncRevision,
        now
      );
    },
    updateDeviceSessionArchive(deviceId, sessionId, archived) {
      updateDeviceSessionUiState(db, deviceId, sessionId, {
        archivedAt: archived ? new Date().toISOString() : null,
        archivedTouched: true
      });
    },
    updateDeviceSessionPin(deviceId, sessionId, pinned) {
      updateDeviceSessionUiState(db, deviceId, sessionId, {
        pinnedAt: pinned ? new Date().toISOString() : null,
        pinnedTouched: true
      });
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
      const cursor = Number.parseInt(event.cursor ?? '0', 10) || 0;
      const createdAt = event.created_at ?? new Date().toISOString();
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
        cursor,
        createdAt,
        event.cached_at ?? new Date().toISOString(),
        JSON.stringify(event)
      );
      updateSessionTimelineCursor(db, event.session_id, cursor, createdAt);
    },
    loadPromptQueueStates() {
      return db.prepare('SELECT payload_json FROM prompt_queue_states ORDER BY updated_at DESC').all()
        .map((row) => parseJson(row.payload_json, null))
        .filter(Boolean);
    },
    savePromptQueueState(state) {
      db.prepare(`
        INSERT INTO prompt_queue_states (session_id, host_id, depth, max_depth, active_turn_id, updated_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          host_id = excluded.host_id,
          depth = excluded.depth,
          max_depth = excluded.max_depth,
          active_turn_id = excluded.active_turn_id,
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json
      `).run(
        state.session_id,
        state.host_id ?? null,
        Number.parseInt(state.depth ?? 0, 10) || 0,
        Number.parseInt(state.max_depth ?? 5, 10) || 5,
        state.active_turn_id ?? null,
        state.updated_at ?? new Date().toISOString(),
        JSON.stringify(state)
      );
    },
    deletePromptQueueState(sessionId) {
      db.prepare('DELETE FROM prompt_queue_states WHERE session_id = ?').run(sessionId);
    },
    loadApprovals() {
      return db.prepare('SELECT payload_json FROM approvals ORDER BY updated_at DESC').all()
        .map((row) => parseJson(row.payload_json, null))
        .filter(Boolean);
    },
    saveApproval(approval) {
      const now = new Date().toISOString();
      const status = approval.status ?? 'pending';
      const requestedAt = approval.requested_at ?? approval.requestedAt ?? approval.created_at ?? now;
      const decidedAt = approval.decided_at ?? approval.decidedAt ?? (status === 'pending' ? null : approval.updated_at ?? now);
      const updatedAt = approval.updated_at ?? approval.updatedAt ?? decidedAt ?? requestedAt ?? now;
      db.prepare(`
        INSERT INTO approvals (approval_id, session_id, status, requested_at, decided_at, updated_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(approval_id) DO UPDATE SET
          session_id = excluded.session_id,
          status = excluded.status,
          requested_at = excluded.requested_at,
          decided_at = excluded.decided_at,
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json
      `).run(
        approval.approval_id,
        approval.session_id,
        status,
        requestedAt,
        decidedAt,
        updatedAt,
        JSON.stringify({
          ...approval,
          status,
          requested_at: requestedAt,
          decided_at: decidedAt,
          updated_at: updatedAt
        })
      );
    },
    cleanupExpiredApprovals(options = {}) {
      const nowMs = options.nowMs ?? Date.now();
      const pendingTtlMs = Number.parseInt(options.pendingTtlMs ?? '', 10);
      const resolvedTtlMs = Number.parseInt(options.resolvedTtlMs ?? '', 10);
      let removed = 0;

      if (Number.isFinite(pendingTtlMs) && pendingTtlMs >= 0) {
        const pendingCutoff = new Date(nowMs - pendingTtlMs).toISOString();
        removed += (db.prepare(`
          DELETE FROM approvals
          WHERE status = 'pending'
            AND COALESCE(requested_at, updated_at) < ?
        `).run(pendingCutoff).changes ?? 0);
      }

      if (Number.isFinite(resolvedTtlMs) && resolvedTtlMs >= 0) {
        const resolvedCutoff = new Date(nowMs - resolvedTtlMs).toISOString();
        removed += (db.prepare(`
          DELETE FROM approvals
          WHERE status <> 'pending'
            AND COALESCE(decided_at, updated_at) < ?
        `).run(resolvedCutoff).changes ?? 0);
      }

      return removed;
    },
    loadNotificationEvents(limit) {
      return db.prepare(`
        SELECT payload_json
        FROM notification_events
        ORDER BY created_at DESC
        LIMIT ?
      `).all(limit).reverse().map((row) => parseJson(row.payload_json, null)).filter(Boolean);
    },
    saveNotificationEvent(event) {
      db.prepare(`
        INSERT INTO notification_events (notification_id, kind, session_id, host_id, created_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(notification_id) DO UPDATE SET
          kind = excluded.kind,
          session_id = excluded.session_id,
          host_id = excluded.host_id,
          created_at = excluded.created_at,
          payload_json = excluded.payload_json
      `).run(
        event.notification_id,
        event.kind,
        event.session_id ?? null,
        event.host_id ?? null,
        event.created_at ?? new Date().toISOString(),
        JSON.stringify(event)
      );
    },
    trimNotificationEvents(limit) {
      db.prepare(`
        DELETE FROM notification_events
        WHERE notification_id NOT IN (
          SELECT notification_id FROM notification_events ORDER BY created_at DESC LIMIT ?
        )
      `).run(limit);
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
      refreshAllSessionTimelineBounds(db);
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
    savePowerTrust(trust) {
      db.prepare(`
        INSERT INTO power_control_trusts (trust_id, host_id, device_id, device_display_name, capabilities_json, granted_at, expires_at, revoked_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(host_id, device_id) DO UPDATE SET
          device_display_name = excluded.device_display_name,
          capabilities_json = excluded.capabilities_json,
          granted_at = excluded.granted_at,
          expires_at = excluded.expires_at,
          revoked_at = excluded.revoked_at,
          payload_json = excluded.payload_json
      `).run(
        trust.trust_id,
        trust.host_id,
        trust.device_id,
        trust.device_display_name ?? '',
        JSON.stringify(trust.capabilities ?? []),
        trust.granted_at,
        trust.expires_at ?? null,
        trust.revoked_at ?? null,
        JSON.stringify(trust)
      );
    },
    findPowerTrust(hostId, deviceId) {
      const now = new Date().toISOString();
      const row = db.prepare(`
        SELECT * FROM power_control_trusts
        WHERE host_id = ?
          AND device_id = ?
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
      `).get(hostId, deviceId, now);
      if (!row) {
        return null;
      }
      return {
        ...parseJson(row.payload_json, {}),
        trust_id: row.trust_id,
        host_id: row.host_id,
        device_id: row.device_id,
        device_display_name: row.device_display_name,
        capabilities: parseJson(row.capabilities_json, []),
        granted_at: row.granted_at,
        expires_at: row.expires_at ?? null,
        revoked_at: row.revoked_at ?? null
      };
    },
    listPowerTrusts(options = {}) {
      const includeRevoked = options.includeRevoked === true;
      const now = new Date().toISOString();
      const rows = includeRevoked
        ? db.prepare('SELECT * FROM power_control_trusts ORDER BY granted_at DESC').all()
        : db.prepare(`
          SELECT * FROM power_control_trusts
          WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY granted_at DESC
        `).all(now);
      return rows.map((row) => ({
        trust_id: row.trust_id,
        host_id: row.host_id,
        device_id: row.device_id,
        device_display_name: row.device_display_name,
        capabilities: parseJson(row.capabilities_json, []),
        granted_at: row.granted_at,
        expires_at: row.expires_at ?? null,
        revoked_at: row.revoked_at ?? null
      }));
    },
    savePowerAuditEvent(event) {
      db.prepare(`
        INSERT INTO power_audit_events (event_id, audit_id, host_id, device_id, action, phase, created_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET
          payload_json = excluded.payload_json
      `).run(
        event.event_id,
        event.audit_id,
        event.host_id,
        event.device_id,
        event.action,
        event.phase,
        event.created_at,
        JSON.stringify(event)
      );
    },
    trimPowerAuditEvents(limit) {
      db.prepare(`
        DELETE FROM power_audit_events
        WHERE event_id NOT IN (
          SELECT event_id FROM power_audit_events ORDER BY created_at DESC LIMIT ?
        )
      `).run(limit);
    },
    listPowerAuditEvents(limit) {
      return db.prepare(`
        SELECT payload_json
        FROM power_audit_events
        ORDER BY created_at DESC
        LIMIT ?
      `).all(limit).map((row) => parseJson(row.payload_json, null)).filter(Boolean);
    },
    counts() {
      const count = (table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
      return {
        devices: count('devices'),
        hosts: count('hosts'),
        sessions: count('sessions'),
        timeline_events: count('timeline_events'),
        prompt_queue_states: count('prompt_queue_states'),
        approvals: count('approvals'),
        notification_events: count('notification_events'),
        git_audit_events: count('git_audit_events'),
        host_devices: count('host_devices'),
        power_control_trusts: count('power_control_trusts'),
        power_audit_events: count('power_audit_events'),
        device_session_sync: count('device_session_sync')
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

function initializeSyncMeta(db) {
  const row = db.prepare("SELECT value FROM sync_meta WHERE key = 'global_sync_revision'").get();
  if (row) {
    return;
  }

  const maxRevision = db.prepare('SELECT COALESCE(MAX(sync_revision), 0) AS value FROM sessions').get().value ?? 0;
  db.prepare('INSERT INTO sync_meta (key, value) VALUES (?, ?)')
    .run('global_sync_revision', String(maxRevision));
  db.prepare('INSERT OR IGNORE INTO sync_meta (key, value) VALUES (?, ?)')
    .run('schema_sync_version', '1');
}

function backfillSessionSyncMetadata(db) {
  const sessions = db.prepare(`
    SELECT session_id, payload_json, metadata_hash, stage_hash, sync_updated_at
    FROM sessions
  `).all();
  for (const row of sessions) {
    const session = parseJson(row.payload_json, null);
    if (!session) {
      continue;
    }
    const metadataHash = row.metadata_hash ?? hashObject(normalizeSessionMetadata(session));
    const stageHash = row.stage_hash ?? hashObject(session.stage ?? null);
    const cursors = db.prepare(`
      SELECT MIN(cursor) AS oldest_cursor, MAX(cursor) AS newest_cursor, MAX(created_at) AS last_event_at
      FROM timeline_events
      WHERE session_id = ?
    `).get(row.session_id);
    db.prepare(`
      UPDATE sessions
      SET metadata_hash = ?,
          stage_hash = ?,
          timeline_oldest_cursor = COALESCE(timeline_oldest_cursor, ?),
          timeline_newest_cursor = max(COALESCE(timeline_newest_cursor, 0), ?),
          last_event_at = COALESCE(last_event_at, ?),
          sync_updated_at = COALESCE(sync_updated_at, updated_at)
      WHERE session_id = ?
    `).run(
      metadataHash,
      stageHash,
      cursors.oldest_cursor ?? null,
      cursors.newest_cursor ?? 0,
      cursors.last_event_at ?? null,
      row.session_id
    );
  }
}

function nextSyncRevision(db) {
  const current = Number.parseInt(
    db.prepare("SELECT value FROM sync_meta WHERE key = 'global_sync_revision'").get()?.value ?? '0',
    10
  ) || 0;
  const next = current + 1;
  db.prepare(`
    INSERT INTO sync_meta (key, value)
    VALUES ('global_sync_revision', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(next));
  return next;
}

function updateSessionTimelineCursor(db, sessionId, cursor, createdAt) {
  if (!sessionId || cursor <= 0) {
    return;
  }
  const session = db.prepare(`
    SELECT timeline_newest_cursor, timeline_oldest_cursor
    FROM sessions
    WHERE session_id = ?
  `).get(sessionId);
  if (!session) {
    return;
  }
  const oldNewest = Number.parseInt(session.timeline_newest_cursor ?? '0', 10) || 0;
  const oldOldest = Number.parseInt(session.timeline_oldest_cursor ?? '0', 10) || 0;
  const newestChanged = cursor > oldNewest;
  const oldestChanged = oldOldest === 0 || cursor < oldOldest;
  if (!newestChanged && !oldestChanged) {
    return;
  }
  const syncRevision = newestChanged ? nextSyncRevision(db) : undefined;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE sessions
    SET timeline_newest_cursor = max(COALESCE(timeline_newest_cursor, 0), ?),
        timeline_oldest_cursor = CASE
          WHEN timeline_oldest_cursor IS NULL THEN ?
          WHEN ? < timeline_oldest_cursor THEN ?
          ELSE timeline_oldest_cursor
        END,
        last_event_at = CASE
          WHEN ? > COALESCE(timeline_newest_cursor, 0) THEN ?
          ELSE last_event_at
        END,
        sync_revision = CASE
          WHEN ? IS NULL THEN sync_revision
          ELSE ?
        END,
        sync_updated_at = CASE
          WHEN ? IS NULL THEN sync_updated_at
          ELSE ?
        END
    WHERE session_id = ?
  `).run(
    cursor,
    cursor,
    cursor,
    cursor,
    cursor,
    createdAt,
    syncRevision ?? null,
    syncRevision ?? null,
    syncRevision ?? null,
    now,
    sessionId
  );
}

function updateDeviceSessionUiState(db, deviceId, sessionId, options = {}) {
  if (!deviceId || !sessionId) {
    throw new Error('device session UI state requires device_id and session_id');
  }
  const session = db.prepare('SELECT session_id FROM sessions WHERE session_id = ?').get(sessionId);
  if (!session) {
    throw new Error(`Unknown session for device UI state: ${sessionId}`);
  }
  const now = new Date().toISOString();
  const existing = db.prepare(`
    SELECT *
    FROM device_session_sync
    WHERE device_id = ? AND session_id = ?
  `).get(deviceId, sessionId);
  const archivedAt = options.archivedTouched ? options.archivedAt : existing?.archived_at ?? null;
  const pinnedAt = options.pinnedTouched ? options.pinnedAt : existing?.pinned_at ?? null;
  db.prepare(`
    INSERT INTO device_session_sync (
      device_id,
      session_id,
      seen_snapshot_revision,
      seen_stage_revision,
      seen_timeline_cursor,
      seen_sync_revision,
      seen_at,
      archived_at,
      pinned_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, session_id) DO UPDATE SET
      archived_at = excluded.archived_at,
      pinned_at = excluded.pinned_at,
      seen_at = excluded.seen_at
  `).run(
    deviceId,
    sessionId,
    existing?.seen_snapshot_revision ?? 0,
    existing?.seen_stage_revision ?? 0,
    existing?.seen_timeline_cursor ?? 0,
    existing?.seen_sync_revision ?? 0,
    now,
    archivedAt,
    pinnedAt
  );
}

function refreshAllSessionTimelineBounds(db) {
  const rows = db.prepare(`
    SELECT session_id, MIN(cursor) AS oldest_cursor, MAX(cursor) AS newest_cursor, MAX(created_at) AS last_event_at
    FROM timeline_events
    GROUP BY session_id
  `).all();
  const boundsBySession = new Map(rows.map((row) => [row.session_id, row]));
  const sessions = db.prepare('SELECT session_id FROM sessions').all();
  for (const session of sessions) {
    const bounds = boundsBySession.get(session.session_id);
    db.prepare(`
      UPDATE sessions
      SET timeline_oldest_cursor = ?,
          timeline_newest_cursor = ?,
          last_event_at = ?
      WHERE session_id = ?
    `).run(
      bounds?.oldest_cursor ?? null,
      bounds?.newest_cursor ?? 0,
      bounds?.last_event_at ?? null,
      session.session_id
    );
  }
}

function countUnchangedSessions(db, deviceId, includeArchived) {
  const archivedFilter = includeArchived ? '' : 'AND d.archived_at IS NULL';
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM sessions s
    LEFT JOIN device_session_sync d
      ON d.device_id = ? AND d.session_id = s.session_id
    WHERE d.session_id IS NOT NULL
      AND s.snapshot_revision <= COALESCE(d.seen_snapshot_revision, 0)
      AND s.stage_revision <= COALESCE(d.seen_stage_revision, 0)
      AND s.timeline_newest_cursor <= COALESCE(d.seen_timeline_cursor, 0)
      AND s.sync_revision <= COALESCE(d.seen_sync_revision, 0)
      ${archivedFilter}
  `).get(deviceId).count ?? 0;
}

function normalizeSessionMetadata(session) {
  const copy = { ...session };
  delete copy.stage;
  return copy;
}

function hashObject(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}
