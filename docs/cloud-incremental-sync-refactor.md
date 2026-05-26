# Cloud Incremental Sync Refactor

本文定义 Codex Mobile Companion 的下一轮同步层重构。目标是把当前 Android 端的启发式增量同步，升级为由 Server Relay 持久化和判定的云端同步索引。

## 1. 背景

当前系统已经具备：

- Server Relay SQLite 持久化 device、host、session snapshot、timeline event、approval、notification、prompt queue、Git audit。
- Android Room 本地缓存 session、timeline、selected/pinned/archive、queue、notification ledger。
- Relay 为 timeline event 分配单调递增 cursor。
- Android 重连后会限制后台同步并优先同步 selected / active / warning / missing-cursor sessions。

但仍存在几个结构性问题：

- Android 仍需要“猜”哪些 session 需要同步。
- 50 个以上 session 重连时，即使多数没有更新，也会产生大量 timeline request。
- Relay 无法回答“这个 device 对这个 session 已经同步到哪里”。
- session 状态容易卡在 `editing_files`、`thinking`、`needs attention`，因为 snapshot、timeline、approval、host offline 的派生状态没有统一的 revision/ack 语义。
- `unknown session` 往往来自 Android 看到 timeline/approval/git 更新时，本地 session snapshot 尚未确认或已被清缓存。

本重构的核心原则是：**Relay 是 session 同步状态的权威；Android 是带本地缓存的消费者。**

## 2. 目标

重构完成后，Android 重连或回前台时不再对所有 session 逐个请求 timeline。流程应变为：

1. Android 连接 Relay。
2. Android 请求云端同步索引。
3. Relay 基于该 device 的已同步位置返回 dirty session 列表。
4. Android 只同步 dirty session，或用户显式打开的 session。
5. Android 合并并持久化后向 Relay ack。
6. 没有变化的 session 不再发 timeline request。

目标效果：

- 50 个 session 中只有 2 个有更新时，Android 只拉这 2 个。
- App 重启后可以快速进入缓存 UI，同时显示“同步索引检查中”。
- 同一个 device 反复重连不会重复拉取已 ack 的历史。
- Relay restart 后 device/session 同步位置不丢。
- Android 仍保留本地 Room 缓存，弱网时可以先展示旧数据。

非目标：

- 本轮不引入 FCM 真后台唤醒。
- 本轮不把 Codex/Git/source code 内容迁入 Relay。
- 本轮不要求 Relay 存储完整无限 timeline；仍可按 policy 裁剪正文 payload。
- 本轮不改变 Host Bridge 对 Codex 的 adapter 边界。

## 3. 关键设计决策

### 3.1 用 session 级 revision，不用单个全局 hasUpdate

“云端有更新就更新，没有更新就跳过”这个方向正确，但不能只做全局 boolean。

原因：

- 一个 session 更新不应该导致所有 session 被重新检查 timeline。
- session snapshot 变化、stage 变化、timeline 新事件、approval 状态变化的同步代价不同。
- Android 需要知道推荐动作：只更新列表元信息，还是拉 timeline page。

因此 Relay 需要维护 session 级别的 revision/cursor：

- `snapshot_revision`: session 基础 metadata 变化。
- `stage_revision`: Relay 派生移动端状态变化。
- `timeline_newest_cursor`: 最新 timeline cursor。
- `timeline_oldest_cursor`: Relay 仍持有的最老 timeline cursor。
- `sync_revision`: Relay 全局单调 revision，用于快速排序和分页索引。

### 3.2 Device ack 是云端状态的一部分

每台 Android device 都有自己的同步进度。Relay 需要持久化：

- 这个 device 对每个 session 已看到哪个 snapshot revision。
- 已看到哪个 stage revision。
- timeline 已同步到哪个 cursor。
- 最后 ack 时间。

这使 Relay 可以精确回答：对这台手机，哪些 session 是 dirty。

### 3.3 Android 本地缓存仍然保留

Android Room 不是同步权威，但仍负责：

- 冷启动先展示 cached sessions/timeline。
- selected/pinned/archive/search/grouping 的本地 UI 状态。
- 离线时保持可读。
- 保存最近一次 Relay 返回的 server revisions，便于 fallback 和诊断。

Relay ack 成功后，Android 本地与云端设备同步位置应趋于一致；若 ack 失败，下次 index 仍会返回 dirty session，Android 可以幂等合并。

## 4. Relay SQLite 数据模型

### 4.1 `sessions` 扩展

当前 `sessions` 只有 `session_id`、`host_id`、`updated_at`、`payload_json`。新增列：

```sql
ALTER TABLE sessions ADD COLUMN snapshot_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN stage_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN sync_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN metadata_hash TEXT;
ALTER TABLE sessions ADD COLUMN stage_hash TEXT;
ALTER TABLE sessions ADD COLUMN timeline_newest_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN timeline_oldest_cursor INTEGER;
ALTER TABLE sessions ADD COLUMN last_event_at TEXT;
ALTER TABLE sessions ADD COLUMN sync_updated_at TEXT;
```

索引：

```sql
CREATE INDEX IF NOT EXISTS idx_sessions_sync_revision ON sessions(sync_revision);
CREATE INDEX IF NOT EXISTS idx_sessions_host_sync ON sessions(host_id, sync_revision);
CREATE INDEX IF NOT EXISTS idx_sessions_timeline_cursor ON sessions(timeline_newest_cursor);
```

字段语义：

- `snapshot_revision`: 只有 mobile-visible snapshot 内容变化时递增。
- `stage_revision`: 只有 Relay 派生的 `stage` 内容变化时递增。
- `sync_revision`: 任意 mobile-visible 同步状态变化时递增。
- `metadata_hash`: 对 session snapshot 的稳定序列化 hash。
- `stage_hash`: 对 stage/status/attention 相关派生字段的 hash。
- `timeline_newest_cursor`: 该 session 当前已知最新 cursor。
- `timeline_oldest_cursor`: Relay 仍可从缓存/SQLite 返回的最老 cursor。
- `last_event_at`: 最新 timeline event 的 created_at。
- `sync_updated_at`: 最近一次改变 sync metadata 的时间。

### 4.2 `device_session_sync`

新增设备同步位置表：

```sql
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
```

第一版可以只使用 `seen_*` 字段。`archived_at` / `pinned_at` 预留给“云端 archive/pin 多端同步”，避免以后再次改表。

### 4.3 `sync_meta`

新增 Relay 全局 revision 表：

```sql
CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

关键 key：

- `global_sync_revision`: 每次 mobile-visible sync state 变化时递增。
- `schema_sync_version`: sync schema 版本。

Relay 进程启动时从 SQLite 读取 `global_sync_revision`，后续通过事务递增。

## 5. Revision 递增规则

Relay 必须避免无意义递增，否则 Android 会频繁误判 dirty。

### 5.1 `session.snapshot`

处理 Host Bridge 上报的 snapshot 时：

1. 规范化 mobile-visible 字段。
2. 计算 `metadata_hash`。
3. 与 SQLite 中上一版 hash 比较。
4. 只有 hash 变化时：
   - `snapshot_revision += 1`
   - `sync_revision = nextGlobalSyncRevision()`
   - `sync_updated_at = now`
5. 重新派生 stage；若 stage hash 变化，也递增 `stage_revision`。

### 5.2 `timeline.event`

处理 live event 时：

1. Relay 分配或确认 cursor。
2. upsert `timeline_events`。
3. 更新 `sessions.timeline_newest_cursor`。
4. 如果该 cursor 大于旧 `timeline_newest_cursor`：
   - `sync_revision = nextGlobalSyncRevision()`
   - `last_event_at = event.created_at`
   - 重新派生 stage，必要时递增 `stage_revision`。

### 5.3 `timeline.page`

Host 返回历史 page 时：

- 如果 page 包含比当前 `timeline_oldest_cursor` 更早的事件，更新 `timeline_oldest_cursor`。
- 如果 page 包含比当前 `timeline_newest_cursor` 更新的事件，按 `timeline.event` 规则更新 newest。
- 旧历史 page 不应导致 session 在所有 device 上变 dirty，除非它填补了 device 明确请求的 cursor gap。

### 5.4 Approval / Git / Queue / Host Offline

这些状态若影响移动端 session stage 或 attention badge，需要触发 `stage_revision` 和 `sync_revision`：

- new pending approval: stage -> `waiting_approval`
- approval resolved: pending count 变化，stage 可能回到 running/completed
- host offline: active session stage -> `needs_user` 或 host-offline derived state
- prompt queue depth 变化: 如果 UI 展示 queue badge，递增 snapshot 或 stage revision
- Git action result: 如果进入 timeline event，则由 timeline cursor 驱动；如果只影响 Git panel summary，则需要单独 `git_revision`，可作为后续扩展

## 6. Protocol

新增消息类型：

- `session.sync.index`
- `session.sync.index.result`
- `session.sync.ack`

后续可选：

- `session.sync.invalidate`
- `session.archive.update`
- `session.pin.update`

### 6.1 `session.sync.index`

Android -> Relay：

```json
{
  "type": "session.sync.index",
  "payload": {
    "limit": 200,
    "cursor": null,
    "include_archived": false,
    "include_clean": false,
    "known": {
      "session-id": {
        "seen_snapshot_revision": 12,
        "seen_stage_revision": 6,
        "seen_timeline_cursor": 890,
        "seen_sync_revision": 1200
      }
    }
  }
}
```

字段：

- `limit`: 返回 session 数上限。
- `cursor`: sync index 分页 cursor；不是 timeline cursor。
- `include_archived`: 是否包含云端归档 session。
- `include_clean`: 调试/首次恢复可开启，返回 clean sessions 摘要。
- `known`: Android 本地已知状态，可作为兼容校验；Relay 仍以 `device_session_sync` 为权威。

### 6.2 `session.sync.index.result`

Relay -> Android：

```json
{
  "type": "session.sync.index.result",
  "payload": {
    "server_sync_revision": 1305,
    "sessions": [
      {
        "session": {
          "session_id": "abc",
          "host_id": "local-pc",
          "project_name": "Codex Mobile Companion",
          "status": "running",
          "stage": {
            "type": "editing_files",
            "severity": "active",
            "updated_at": "2026-05-26T13:00:00.000Z"
          },
          "updated_at": "2026-05-26T13:00:00.000Z"
        },
        "snapshot_revision": 13,
        "stage_revision": 8,
        "sync_revision": 1300,
        "timeline_newest_cursor": 905,
        "timeline_oldest_cursor": 400,
        "device_seen": {
          "seen_snapshot_revision": 12,
          "seen_stage_revision": 8,
          "seen_timeline_cursor": 890,
          "seen_sync_revision": 1250
        },
        "dirty": true,
        "dirty_reasons": ["snapshot", "timeline"],
        "recommended_action": "timeline_page"
      }
    ],
    "unchanged_count": 47,
    "has_more": false,
    "next_cursor": null
  }
}
```

`dirty_reasons`：

- `snapshot`
- `stage`
- `timeline`
- `missing_local`
- `cursor_gap`
- `host_status`
- `approval`

`recommended_action`：

- `none`: 无需动作。
- `snapshot_only`: 更新列表/card，不拉 timeline。
- `timeline_page`: 请求 `session.timeline.request`。
- `open_on_demand`: 不自动拉，用户打开时再拉。
- `resync_from_host`: Relay cursor gap 太大，需要 Host Bridge 补历史。

### 6.3 `session.sync.ack`

Android -> Relay：

```json
{
  "type": "session.sync.ack",
  "payload": {
    "sessions": [
      {
        "session_id": "abc",
        "seen_snapshot_revision": 13,
        "seen_stage_revision": 8,
        "seen_timeline_cursor": 905,
        "seen_sync_revision": 1300
      }
    ]
  }
}
```

Ack 时机：

- Android 成功把 session snapshot 写入 Room 后，可以 ack snapshot/stage。
- Android 成功合并并持久化 timeline page/event 后，ack timeline cursor。
- Ack 可以批量发送，失败可重试，Relay upsert 幂等处理。

Relay 不能因为 ack 丢失而丢数据；ack 只影响下一次 index 的 dirty 判断。

## 7. Relay 处理流程

### 7.1 Client connect

1. 校验 device token。
2. 建立 WebSocket。
3. 返回已有 host/session snapshot 仍可保留，用于旧客户端兼容。
4. 新 Android 立即发送 `session.sync.index`。

### 7.2 Sync index 查询

Relay 根据 device token 找到 `device_id`，然后：

1. 查询 active sessions。
2. left join `device_session_sync`。
3. 比较：
   - `snapshot_revision > seen_snapshot_revision`
   - `stage_revision > seen_stage_revision`
   - `timeline_newest_cursor > seen_timeline_cursor`
   - `sync_revision > seen_sync_revision`
4. 生成 dirty reasons。
5. 根据优先级排序：
   - selected/opened session 可由 Android 在 request 中传 hint。
   - active/warning stage。
   - newest `sync_revision`。
   - newest `updated_at`。
6. 返回 dirty sessions。

### 7.3 Ack

Relay 校验 session 存在，并 upsert：

- `seen_snapshot_revision = max(existing, incoming)`
- `seen_stage_revision = max(existing, incoming)`
- `seen_timeline_cursor = max(existing, incoming)`
- `seen_sync_revision = max(existing, incoming)`
- `seen_at = now`

如果 incoming cursor 超过 Relay 已知 newest cursor，Relay 应拒绝或 clamp，并返回 `error`，避免客户端错误污染云端状态。

## 8. Android 处理流程

### 8.1 Cold start

1. 从 Room 加载 cached sessions/timeline/selected/archive/pinned。
2. UI 立即渲染缓存。
3. 如果有 device token，连接 Relay。
4. 连接成功后请求 `session.sync.index`。
5. UI 显示轻量“Checking for updates”。

### 8.2 Sync index result

Android 收到 index result 后：

1. 合并 session snapshot 到 Room。
2. 更新本地 per-session cloud revisions。
3. 对 `recommended_action = snapshot_only` 的 session 直接 ack snapshot/stage。
4. 对 `timeline_page` 的 session 进入受限队列。
5. 默认只自动同步：
   - selected session；
   - active/warning sessions；
   - dirty session 中最近 N 个；
   - 没有本地 timeline 的 session。
6. 其余 dirty session 显示“有新内容”，用户打开时再拉。

### 8.3 Selecting a session

用户打开 session 时：

1. 如果本地 `latestCursor >= relay.timeline_newest_cursor`，不发 timeline request。
2. 如果本地 cursor 落后，发 `session.timeline.request` with `after_cursor`。
3. 如果 Relay 标记 `cursor_gap`，请求 `resync_from_host` 或从 Relay page fallback。
4. 成功合并后 ack。

### 8.4 Live timeline event

Live event 仍通过 WebSocket 推送。Android 收到后：

1. merge into Room。
2. 更新本地 latest cursor。
3. 如果 event 对应 session 本地还没有 snapshot，不报 `unknown session` 给用户；标记为 orphan update 并触发一次 sync index。
4. ack timeline cursor。

## 9. Host Bridge 影响

Host Bridge 不需要知道每台 Android 的 sync state。

需要保持或微调：

- 上报稳定 session snapshot。
- live notification 映射为稳定 timeline event。
- `thread/read` / history page 返回可排序 cursor 或足够信息让 Relay 分配 cursor。
- 当 Codex runtime 状态完成、等待输入、等待 approval、报错时，尽量发出明确 event，帮助 Relay stage 派生收敛。

Host Bridge 不应直接处理 `session.sync.index` / `session.sync.ack`。

## 10. 与现有启发式同步的关系

新 sync index 上线后，Android 策略变为：

1. 优先使用 `session.sync.index`。
2. 如果 Relay 返回 unknown message / unsupported，则回退到当前启发式：
   - selected session；
   - active/warning session；
   - missing cursor；
   - updatedAt newer than lastSyncedAt；
   - cap 8 sessions。

这保证旧 Relay 和新 Android 可以兼容。

## 11. 故障场景处理

### 11.1 Unknown session

如果 Android 收到 timeline/approval/git 更新，但本地没有 session：

- 不直接展示错误 toast。
- 将 session id 放入 `orphanSessionIds`。
- 立即请求 `session.sync.index`，带 `session_ids` hint。
- Relay 返回 snapshot 后再合并事件。
- 如果 Relay 也没有该 session，标记为 stale event 并写入诊断。

### 11.2 状态卡住

Relay stage 必须由以下输入统一派生：

- 最新 session snapshot。
- 最新 timeline event 类型。
- active pending approvals。
- prompt queue / active turn state。
- host online/offline。

当 `turn_completed`、`approval_resolved`、`host.offline`、`error` 到达时必须递增 `stage_revision`，否则 Android 可能一直认为 session dirty 或一直显示旧 stage。

### 11.3 Relay timeline 被裁剪

如果 `seen_timeline_cursor < timeline_oldest_cursor`：

- Relay 返回 dirty reason `cursor_gap`。
- `recommended_action = resync_from_host`。
- Android 对 selected session 可以请求 Host Bridge 历史 page。
- 对非 selected session 只更新 snapshot/stage，等用户打开再补历史。

### 11.4 多设备

每台 Android device 独立 ack。A 手机看过不影响 B 手机。

后续若实现云端 archive/pin，可以放入 `device_session_sync.archived_at/pinned_at`，仍保持 per-device。

## 12. 安全与隐私

- `session.sync.index` 和 `session.sync.ack` 只接受 device token。
- Host token 不能伪造 device ack。
- Ack 不包含 prompt 内容或源码内容，只包含 revision/cursor。
- Relay health 可以暴露 sync counts，但详细 device/session sync 诊断必须鉴权。
- Pairing token 不应允许读取 sync index。
- 对 `session.sync.index` 加 rate limit，避免公网 Relay 被频繁扫库。

## 13. 迁移计划

### 13.1 Relay migration

1. 用 `ensureColumn` 扩展 `sessions`。
2. 创建 `device_session_sync` 和 `sync_meta`。
3. Backfill：
   - `snapshot_revision = 1`
   - `stage_revision = 1`
   - `sync_revision = nextGlobalSyncRevision()`
   - `timeline_newest_cursor = max(timeline_events.cursor)`
   - `timeline_oldest_cursor = min(timeline_events.cursor)`
   - `metadata_hash = hash(payload_json mobile-visible fields)`
4. Relay 启动后打印 sync schema version 和 counts。

### 13.2 Android migration

1. 增加本地 cloud sync fields：
   - `snapshotRevision`
   - `stageRevision`
   - `syncRevision`
   - `relayTimelineNewestCursor`
   - `relayTimelineOldestCursor`
   - `lastSyncIndexAt`
2. 保留现有 `CachedSyncState.latestCursor/earliestCursor`。
3. 初次连接新 Relay 时，以本地 latest cursor 作为 `known` hint，但最终以 Relay index result 为准。
4. 当前 `fallbackToDestructiveMigration` 需要在稳定版前替换为显式 migration；本重构期间可先保留，但要避免再次清空用户缓存。

## 14. 实施阶段

### Phase 1: Relay schema + protocol

- 新增 protocol message types。
- 扩展 SQLite schema。
- 实现 revision bump helper。
- 实现 `session.sync.index`。
- 实现 `session.sync.ack`。
- `/health` 增加 sync diagnostics。

验收：

- Node verifier 能证明 ack 后 index 不再返回 clean session。
- Relay restart 后 ack 状态仍保留。

### Phase 2: Android client + cache

- `RelayClient` 支持 sync index / ack。
- `RelayModels` 增加 `SessionSyncEntry` / `CloudSyncState`。
- `RelayCacheStore` 持久化 cloud revisions。
- `RelayViewModel` 连接后先请求 index，不再直接 broad timeline sync。
- 保留启发式 fallback。

验收：

- 重启 App 后只有 dirty sessions 进入 pending sync。
- clean session 不显示 syncing。

### Phase 3: UI diagnostics

- More/Diagnostics 显示：
  - last sync index time；
  - dirty session count；
  - clean session count；
  - ack pending count；
  - cursor gap count。
- Session row 显示轻量 `Updated` / `Cached` / `Needs sync`。

验收：

- 用户能看出“正在检查更新”与“正在拉取 timeline”的区别。

### Phase 4: Cloud archive/pin optional

- 将 local archive/pin 升级为 per-device cloud state。
- Android 本地修改先落 Room，再发 `session.archive.update` / `session.pin.update`。
- Relay index 默认排除 archived session。

验收：

- 换手机或重装后 archive/pin 可恢复。

## 15. Verification Plan

### Node / Relay

新增脚本：

- `npm run verify:relay-sync-index`
- `npm run verify:relay-sync-ack`
- `npm run verify:relay-sync-restart`
- `npm run verify:relay-sync-cursor-gap`

覆盖：

- pair device。
- host registers two sessions。
- 只给一个 session 发送 timeline event。
- index 只返回 dirty session。
- ack 后再次 index 返回 unchanged。
- Relay restart 后 device ack 状态仍有效。
- timeline 被裁剪时返回 `cursor_gap`。
- 未鉴权 client 被拒绝。

### Android unit tests

扩展 `RelayStateReducersTest` 或新增 sync reducer tests：

- clean index result 不触发 timeline request。
- dirty selected session 触发 timeline request。
- dirty archived session 默认不触发 request。
- live event unknown session 触发 sync index hint，不产生用户级错误。
- ack pending 状态重启后可恢复。

### Manual long-run

三端长测：

1. Server Relay 持续运行。
2. PC Host Bridge 开机自启动。
3. Android 打开 50+ sessions 缓存。
4. 只更新其中 1 个 session。
5. 杀掉 Android app 再打开。
6. 观察只同步该 dirty session 和当前 selected session。
7. 断开 PC Host Bridge 再恢复。
8. session stage 最终从 host offline / active 收敛到正确状态。

## 16. Completion Criteria

本 refactor 完成需要同时满足：

- Relay SQLite 持久化 session revisions 和 device sync ack。
- Android 连接后优先走 `session.sync.index`。
- Clean sessions 不再发 timeline request。
- Dirty sessions 可按推荐动作同步。
- Ack 后重连不会重复同步同一批历史。
- Relay restart 不丢 device sync state。
- Android 仍能兼容旧 Relay fallback。
- 现有 prompt、timeline、approval、Git、archive、notification 功能不退化。

## 17. 当前建议

下一步优先做 Phase 1。它的收益最大、边界清晰，并且能用 Node verifier 在不依赖真机的情况下验证核心逻辑。

Android 端当前启发式增量同步可以暂时保留，作为 Phase 2 接入前的稳定性缓冲。等 Relay sync index 通过后，再把 Android 自动同步入口切换到云端索引。
