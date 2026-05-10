# Progress Log

本文记录每次施工完成后的实际进展、验证结果、阻塞项和下一步。

## 2026-05-10: Delivery Strategy 主链路验证

状态：完成。

本次目标：

- 用 Node test client 代替 Android App，验证“移动端视角可以看到 Codex session，并能发送一条指令”。
- 不接真实 Codex、Git、Android 工具链或数据库。
- 完成后更新施工文档。

完成内容：

- 新增零依赖 Node 原型工程。
- 新增共享协议模块 `packages/protocol/`。
- 新增内存 Relay `relay/service/`，支持 JSON over WebSocket。
- 新增 Host Bridge `bridge/host-bridge/`。
- 新增 `MockCodexAdapter`，预留后续真实 Codex adapter 接口位置。
- 新增 test client `tools/test-client/`，模拟 Android 端订阅 session 并发送 prompt。
- 新增自动验证脚本 `tools/verify-delivery-strategy.mjs`。

已验证链路：

1. Relay 监听 `ws://127.0.0.1:8787`。
2. Host Bridge 连接 Relay。
3. Host Bridge 发送 `host.register`。
4. Host Bridge 发送 mock `session.snapshot`。
5. Test client 订阅 session 并看到 `mock-session-001`。
6. Test client 发送 prompt：`总结当前进度`。
7. Relay 将 `session.prompt` 路由到 Host Bridge。
8. Host Bridge 收到 prompt。
9. `MockCodexAdapter` 生成 `timeline.event`。
10. Test client 收到 `Prompt routed to Host Bridge`。

验证命令：

```powershell
npm run verify:delivery-strategy
```

验证结果：

```text
[relay] listening on ws://127.0.0.1:8787
[bridge] connected to ws://127.0.0.1:8787
[relay] host registered: local-dev-host
[relay] session snapshot: mock-session-001
[test-client] session visible: mock-session-001
[test-client] prompt sent: 总结当前进度
[relay] routing prompt to host local-dev-host: 总结当前进度
[bridge] received prompt for mock-session-001: 总结当前进度
[relay] timeline event: Prompt routed to Host Bridge
[test-client] timeline event received: Prompt routed to Host Bridge
[verify] Delivery Strategy main path verified.
```

已知阻塞：

- 当前机器未检测到 Java、Gradle、Android SDK 或 adb，因此 Android MVP Shell 暂缓。
- `codex --help` 和 `codex --version` 当前都返回 `Access is denied`，真实 Codex adapter 需要后续单独调研。
- Relay 目前是内存实现，不含认证、持久化、重连恢复或推送通知。
- Host Bridge 目前只接 `MockCodexAdapter`，不执行真实 shell/Git/Codex 操作。

下一步建议：

1. 继续 Milestone 0，形成 `docs/codex-api-coverage.md`，明确真实 Codex adapter 接口可行性。
2. 在 Relay/Bridge 原型上增加 approval request/decision 链路。
3. 选择 Android 工具链安装路径后再启动 Android MVP Shell。

## 2026-05-10: Codex adapter 覆盖与连接验证

状态：完成接口覆盖初判和 App Server loopback 连接验证。

本次目标：

- 找到本机可执行的 Codex CLI。
- 判断真实 Codex adapter 应优先接 App Server、exec JSON 还是 PTY wrapper。
- 产出 coverage matrix。

完成内容：

- 确认 WindowsApps app alias 的 `codex` 当前执行 `--help` / `--version` 会返回 `Access is denied`。
- 找到 VS Code 扩展内置 Codex CLI：`C:\Users\13372\.vscode\extensions\openai.chatgpt-26.506.21252-win32-x64\bin\windows-x86_64\codex.exe`。
- 确认该 CLI 可执行，版本为 `codex-cli 0.129.0-alpha.15`。
- 确认该 CLI 暴露 `app-server`、`app-server generate-ts`、`app-server generate-json-schema`、`exec --json`、`exec-server`、`mcp-server`。
- 使用临时目录生成 App Server TypeScript bindings 和 JSON Schema，没有写入仓库。
- 新增 `docs/codex-api-coverage.md`。
- 新增 `tools/probe-codex-app-server.mjs`。
- 验证 `codex app-server --listen ws://127.0.0.1:8791` 可以启动。
- 验证 Node WebSocket client 可以连接 App Server。
- 验证 JSON-RPC `initialize` 成功。
- 验证 `thread/list` 成功返回 5 条历史 thread。
- 观察到 App Server 会发送 `remoteControl/status/changed` notification。

结论：

- 首选真实 adapter 是 App Server Adapter。
- `codex exec --json` 可作为 batch task fallback。
- PTY wrapper 暂不建议使用。
- App Server Adapter 的只读 MVP 可以进入实现。

验证命令：

```powershell
npm run probe:codex-app-server
```

验证结果摘要：

```text
[probe] connected to ws://127.0.0.1:8791
[probe] initialize ok: Codex Desktop/0.129.0-alpha.15 ...
[probe] codex home: C:\Users\13372\.codex
[probe] notification: remoteControl/status/changed
[probe] thread/list ok: 5 thread(s)
```

下一步建议：

1. 实现 `AppServerCodexAdapter` 的只读最小版本。
2. 将 `thread/list` 映射为 Host Bridge `session.snapshot`。
3. 增加环境变量开关，在测试中默认继续使用 `MockCodexAdapter`。

## 2026-05-10: App Server readonly adapter MVP

状态：完成。

本次目标：

- 保持 `MockCodexAdapter` 为默认测试 adapter。
- 增加可通过环境变量启用的真实 App Server readonly adapter。
- 让 Host Bridge 可以从真实 Codex App Server 读取 threads，并映射成 Relay 的 `session.snapshot`。

完成内容：

- 新增 `AppServerCodexAdapter`。
- 新增 adapter factory：默认使用 mock，`CODEX_ADAPTER=app-server` 时使用真实 App Server。
- Host Bridge 启动时会调用 adapter `start()`，再注册 host 和发送 sessions。
- `AppServerCodexAdapter` 会启动 VS Code 扩展内置 Codex CLI：
  - `codex app-server --listen ws://127.0.0.1:<port>`
- `AppServerCodexAdapter` 会发送 JSON-RPC `initialize` 和 `thread/list`。
- 将 Codex `Thread` 映射为 Host Bridge session snapshot。
- 新增 `npm run verify:app-server-readonly`。

验证命令：

```powershell
npm run verify:delivery-strategy
npm run verify:app-server-readonly
```

验证结果摘要：

```text
[verify] Delivery Strategy main path verified.
[bridge] app-server initialized: Codex Desktop/0.129.0-alpha.15 ...
[relay] session snapshot: 019e100a-58f8-72f0-969d-3fb5bbefef97
[verify] App Server read-only adapter listed sessions through Relay.
```

当前限制：

- App Server adapter 当前只读，`sendPrompt()` 会显式报错。
- 还未实现 `thread/read`、`turn/start`、`turn/steer` 或 approval request resolution。
- 真实 adapter 依赖 VS Code 扩展内置 Codex CLI 路径；后续需要做 CLI discovery 更稳的实现。
- App Server stderr 会输出 remote plugin sync warning：`chatgpt authentication required to sync remote plugins; api key auth is not supported`。这不影响本次 `initialize` / `thread/list` 验证。

下一步建议：

1. 实现 `thread/read`，让移动端能看到真实 thread 的 turns/items。
2. 将 App Server notifications 映射为 timeline events。
3. 再实现 `turn/start` 或 `turn/steer`，让真实 session 支持手机 prompt。

## 2026-05-10: App Server thread/read timeline MVP

状态：完成。

本次目标：

- 增加客户端请求真实 session timeline 的协议。
- Host Bridge 通过 App Server `thread/read` 读取真实 thread turns/items。
- 将 Codex Thread/Turn/ThreadItem 映射为移动端 timeline events。
- 验证真实历史 thread 可以通过 Relay 返回 timeline。

完成内容：

- 新增协议消息：`session.timeline.request`。
- Relay 支持将 timeline request 路由到对应 Host Bridge。
- Host Bridge 支持接收 timeline request 并调用 adapter `readTimeline()`。
- `MockCodexAdapter` 支持返回 mock timeline。
- `AppServerCodexAdapter` 支持 `thread/read`，并将 turns/items 映射为 timeline events。
- 新增 `tools/timeline-client/`。
- 新增 `npm run verify:app-server-timeline`。
- Relay 在 websocket send/error 失败时清理连接，减少验证退出时的断连噪音。

当前 timeline 映射支持：

- `turn_started`
- `turn_completed`
- `user_prompt`
- `assistant_message`
- `plan_update`
- `reasoning_summary`
- `command_execution`
- `file_changed`
- `tool_call`
- unknown item fallback

验证命令：

```powershell
npm run verify:delivery-strategy
npm run verify:app-server-readonly
npm run verify:app-server-timeline
```

验证结果摘要：

```text
[verify] Delivery Strategy main path verified.
[verify] App Server read-only adapter listed sessions through Relay.
[timeline-client] timeline event received: turn_started Turn started
[verify] App Server thread/read timeline mapped through Relay.
```

当前限制：

- timeline request 已支持 `limit`，但尚未做分页或游标。
- Relay 还没有缓存 timeline events。
- App Server live notifications 仍只打印日志，还没有增量映射成 timeline。
- App Server adapter 仍未实现 `turn/start` / `turn/steer`，真实 session 尚不能接收手机 prompt。

下一步建议：

1. 增加 timeline event limit/cursor，避免一次性推送过多历史事件。
2. 将 App Server live notifications 映射为增量 timeline events。
3. 实现真实 prompt 路由：优先验证 `turn/start`，再评估 active turn 场景下的 `turn/steer`。

## 2026-05-10: App Server live notification timeline mapping

状态：完成。

本次目标：

- 将 App Server server notifications 从日志输出升级为实时 timeline event。
- 保持 historical `thread/read` mapper 可复用。
- 补充不依赖真实长任务的 mapper 验证。

完成内容：

- 新增 `bridge/host-bridge/timeline-mapper.mjs`，集中管理 historical thread item 和 live notification 映射。
- `AppServerCodexAdapter` 在收到未匹配 request id 的 App Server notification 时，会调用 live notification mapper。
- Host Bridge 通过 `onTimelineEvent` callback 将 live timeline events 转发给 Relay。
- 新增 `npm run verify:live-notification-mapper`。
- 保留 `MockCodexAdapter` 默认路径，避免普通验证依赖真实 Codex App Server。

Live notification 映射覆盖：

- `thread/status/changed` -> `thread_status_changed`
- `turn/started` -> `turn_started`
- `turn/completed` -> `turn_completed`
- `turn/plan/updated` -> `plan_update`
- `turn/diff/updated` -> `diff_update`
- `item/started` / `item/completed` -> 复用 ThreadItem mapper
- `item/agentMessage/delta` -> `assistant_delta`
- `item/commandExecution/outputDelta` -> `command_output_delta`
- `item/fileChange/patchUpdated` -> `file_changed`
- `serverRequest/resolved` -> `request_resolved`
- `error` -> `error`

验证命令：

```powershell
npm run verify:live-notification-mapper
npm run verify:delivery-strategy
npm run verify:app-server-timeline
```

验证结果摘要：

```text
[verify] Live notification mapper verified.
[verify] Delivery Strategy main path verified.
[verify] App Server thread/read timeline mapped through Relay.
```

当前限制：

- live notification mapper 已接入，但还没有通过真实 `turn/start` 长任务触发端到端 live event。
- Relay 仍不缓存 timeline events，客户端必须在线订阅才能看到 live event。
- delta 类事件目前逐条转发，尚未做合并、节流或按 item 聚合。

下一步建议：

1. 实现真实 prompt 路由：先用 `turn/start` 在 idle thread 上启动新 turn。
2. 用真实 prompt 验证 live notification 从 App Server 到 Relay client 的端到端链路。
3. 再处理 active turn 场景下的 `turn/steer`。

## 2026-05-10: App Server turn/start prompt routing

状态：完成。

本次目标：

- 让 `session.prompt` 不再停留在 mock adapter，而是进入真实 Codex App Server。
- 对历史 `notLoaded` thread 做必要的 resume。
- 用真实 App Server 验证 test client -> Relay -> Host Bridge -> Codex App Server -> Relay -> test client 的 prompt 链路。

完成内容：

- `AppServerCodexAdapter.sendPrompt()` 改为调用 App Server `turn/start`。
- 调用 `turn/start` 前先通过 `thread/loaded/list` 判断 thread 是否已加载。
- 若 thread 未加载，先调用 `thread/resume`。
- `turn/start` 使用只读沙箱：
  - `approvalPolicy: "never"`
  - `sandboxPolicy: { type: "readOnly", networkAccess: false }`
- `turn/start` 成功后返回 `turn_start_requested` timeline event。
- `turn/start` 失败时返回 `error` timeline event，避免客户端一直等待。
- `tools/test-client/` 支持通过 `TEST_CLIENT_EXPECT_EVENT_TYPE` 等待指定 timeline event type。
- 新增 `npm run verify:app-server-prompt`。

验证命令：

```powershell
npm run verify:app-server-prompt
npm run verify:delivery-strategy
npm run verify:app-server-timeline
npm run verify:live-notification-mapper
```

验证结果摘要：

```text
[test-client] prompt sent: Reply with exactly: OK
[bridge] received prompt for 019e100a-58f8-72f0-969d-3fb5bbefef97: Reply with exactly: OK
[test-client] ignoring timeline event: thread_status_changed
[test-client] timeline event received: Prompt sent to Codex
[test-client] summary: Started turn 019e1050-beba-7ec2-81af-7e3fd3b53807.
[verify] App Server turn/start prompt routed through Relay.
```

关键发现：

- `thread/list` 返回的历史 threads 多数是 `notLoaded`，直接 `turn/start` 会失败：`thread not found`。
- 对历史 thread 需要先 `thread/resume`，然后才能 `turn/start`。
- App Server 会先发 `thread/status/changed` live notification，再返回本地确认事件 `turn_start_requested`。

当前限制：

- 只实现了 idle/resumed thread 的 `turn/start`。
- active turn 场景还没有使用 `turn/steer`。
- 验证脚本确认 prompt 已启动 turn，但不会等待模型最终回答完成。
- 当前 prompt 会真实写入所选 Codex thread 历史；后续应改成创建专用 ephemeral test thread，避免污染用户历史。

下一步建议：

1. 增加测试专用 ephemeral thread 创建，避免 prompt 验证写入真实历史 thread。
2. 实现 `turn/steer`，用于 active turn 的追加指令。
3. 让 test client 等待 `turn/completed` 或 assistant delta，验证完整回答链路。

## 2026-05-10: Ephemeral prompt verification

状态：完成。

本次目标：

- 避免 prompt 验证继续写入用户真实历史 thread。
- 通过 App Server `thread/start` 创建专用 ephemeral test thread。
- 在 ephemeral thread 上执行 `turn/start` 验证。

完成内容：

- 新增协议消息：`session.create_ephemeral`。
- Relay 支持将 ephemeral session create 请求路由到指定 Host Bridge。
- Host Bridge 支持调用 adapter `createEphemeralSession()` 并发布 `session.snapshot`。
- `AppServerCodexAdapter.createEphemeralSession()` 使用 App Server `thread/start` 创建 ephemeral thread。
- 新增 `tools/ephemeral-prompt-client/`。
- `npm run verify:app-server-prompt` 已改为使用 ephemeral thread，不再选择历史 thread。
- `package.json` 新增 `ephemeral-prompt-client` 脚本。

验证命令：

```powershell
npm run verify:app-server-prompt
npm run verify:delivery-strategy
npm run verify:app-server-timeline
npm run verify:live-notification-mapper
```

验证结果摘要：

```text
[relay] routing ephemeral session create to host local-dev-host
[bridge] created ephemeral session 019e1063-d4e4-7fe0-bda7-2a3270f29a2b
[ephemeral-client] ephemeral session visible: 019e1063-d4e4-7fe0-bda7-2a3270f29a2b
[ephemeral-client] prompt sent: Reply with exactly: OK
[ephemeral-client] timeline event received: Prompt sent to Codex
[verify] App Server ephemeral turn/start prompt routed through Relay.
```

当前限制：

- ephemeral thread 解决了测试污染问题，但真实产品仍需要明确“新建会话”和“向已有会话发送指令”的 UI 区分。
- 验证仍只等待 `turn_start_requested`，没有等待 `turn/completed`。
- active turn 场景仍未实现 `turn/steer`。

下一步建议：

1. 实现 active turn 的 `turn/steer`。
2. 为 prompt 验证增加等待 assistant delta 或 `turn/completed` 的模式。
3. 将 Relay 的 session/timeline 状态做最小缓存，支持客户端断线重连后恢复。

## 2026-05-10: App Server turn/steer prompt routing

状态：完成。

本次目标：

- 在 Codex App Server 已有 active turn 时，不再启动新的 `turn/start`。
- 将移动端后续 prompt 映射为 App Server `turn/steer`。
- 继续使用专用 ephemeral test thread，避免污染用户真实历史会话。

完成内容：

- `AppServerCodexAdapter` 新增 active turn 追踪。
- `turn/start` 成功后记录当前 thread 的 active turn id。
- App Server live notification `turn/started` 会刷新 active turn id。
- App Server live notification `turn/completed` 会清理对应 active turn id。
- `sendPrompt()` 在检测到 active turn 时调用 `turn/steer`，并传入 `expectedTurnId`。
- `turn/steer` 成功后返回 `turn_steer_requested` timeline event。
- 新增 `tools/steer-client/`，用于模拟移动端在 active turn 中追加指令。
- 新增 `npm run verify:app-server-steer`。

验证命令：

```powershell
npm run verify:app-server-steer
npm run verify:app-server-prompt
npm run verify:delivery-strategy
npm run verify:app-server-timeline
npm run verify:live-notification-mapper
```

验证结果摘要：

```text
[steer-client] first prompt sent
[steer-client] steer prompt sent
[steer-client] steer event received: Steered turn ...
[verify] App Server turn/steer prompt routed through Relay.
[verify] App Server ephemeral turn/start prompt routed through Relay.
[verify] Delivery Strategy main path verified.
[verify] App Server thread/read timeline mapped through Relay.
[verify] Live notification mapper verified.
```

当前限制：

- `turn/steer` 验证依赖第二条 prompt 在 active turn 完成前发出；测试 prompt 已要求模型短暂等待，但后续仍应降低这种时序敏感性。
- 验证仍只确认 `turn/steer` 请求成功路由到 App Server，没有等待 assistant delta 或 `turn/completed`。
- active turn 状态当前保存在 Host Bridge 内存中，Relay 重启或 Bridge 重启后不会恢复。

下一步建议：

1. 让 prompt 验证等待 `assistant_delta` 或 `turn/completed`，证明完整回答链路。
2. 为 Relay 增加最小 timeline 缓存和 cursor，支持移动端断线重连。
3. 实现 approval request/decision 映射，把需要用户处理的事件做成移动端一等入口。

## 2026-05-10: Live assistant event prompt verification

状态：完成。

本次目标：

- 将 prompt 验证从“请求已送达 App Server”升级为“移动端能看到 Codex 的真实回答事件”。
- 继续使用 ephemeral thread，避免测试污染真实历史会话。
- 保持旧的 `turn_start_requested` 等待模式可配置，方便快速 smoke test。

完成内容：

- `tools/ephemeral-prompt-client/` 新增 `EPHEMERAL_CLIENT_EXPECT_EVENT_TYPES`。
- 默认等待目标仍是 `turn_start_requested`，保持手动调用兼容。
- `npm run verify:app-server-prompt` 改为等待 `assistant_delta` 或 `turn_completed`。
- 验证超时从 60 秒提高到 120 秒，给真实模型回答留出余量。
- timeline `error` 事件会让客户端立即失败，避免误判为超时。

验证命令：

```powershell
npm run verify:app-server-prompt
npm run verify:delivery-strategy
npm run verify:live-notification-mapper
npm run verify:app-server-steer
npm run verify:app-server-timeline
```

验证结果摘要：

```text
[ephemeral-client] prompt sent: Reply with exactly: OK
[ephemeral-client] ignoring timeline event: turn_start_requested
[relay] timeline event: Assistant message delta
[ephemeral-client] expected timeline event received: assistant_delta
[ephemeral-client] summary: OK
[verify] App Server ephemeral prompt produced a live assistant/completion event through Relay.
```

关键发现：

- App Server 会先通过 `turn/start` 返回本地确认事件，再通过 live notification 推送 `assistant_delta`。
- 当前 `Reply with exactly: OK` 场景下，端到端约 10 秒内可以看到 `assistant_delta`。
- App Server 仍会输出 remote plugin sync、PowerShell shell snapshot、plugin manifest 等 warning；这些没有影响本次 prompt/live event 验证。

当前限制：

- 验证接受 `assistant_delta` 或 `turn_completed` 任一事件，不检查最终完整文本聚合。
- delta 类事件仍是逐条转发，尚未做按 item 聚合、节流或重放。
- Relay 仍不缓存 timeline，客户端必须在线订阅才能看到 live assistant event。

下一步建议：

1. 为 Relay 增加最小 timeline cache/cursor，支持移动端断线重连后补齐 live events。
2. 将 `assistant_delta` 聚合为移动端可稳定展示的 assistant message 状态。
3. 实现 approval request/decision 映射，让等待用户处理的 Codex 请求进入移动端主入口。

## 2026-05-10: Relay timeline cache and cursor recovery

状态：完成 Node 原型。

本次目标：

- 让 Relay 不只是即时广播 timeline event，而是能短期缓存最近事件。
- 为移动端断线重连提供 `after_cursor` 补发能力。
- 保持实现为内存版，避免过早引入数据库或 Redis。

完成内容：

- Relay 新增每个 timeline event 的单调递增 `cursor`。
- Relay 按 session 缓存最近 timeline events。
- 新增环境变量 `RELAY_TIMELINE_CACHE_LIMIT`，默认每个 session 保留 200 条。
- `session.timeline.request` 支持 `after_cursor`，会先补发缓存中 cursor 更大的事件。
- `session.timeline.request` 支持 `cache_only: true`，用于只从 Relay 缓存恢复，不打到 Host Bridge。
- `session.subscribe` 支持带 `after_cursor` 订阅单个 session 时补发缓存事件。
- 新增 `npm run verify:relay-timeline-cache`。

验证命令：

```powershell
npm run verify:relay-timeline-cache
npm run verify:delivery-strategy
npm run verify:live-notification-mapper
npm run verify:app-server-prompt
```

验证结果摘要：

```text
[relay] timeline event: First cached event
[relay] timeline event: Second cached event
[verify] Relay timeline cache cursor replay verified.
[verify] Delivery Strategy main path verified.
[verify] Live notification mapper verified.
[verify] App Server ephemeral prompt produced a live assistant/completion event through Relay.
```

当前限制：

- 缓存仍是 Relay 进程内存，Relay 重启后会丢失。
- `cursor` 当前是 Relay 进程内全局递增值，还不是持久化事件序列。
- 未实现客户端 ack、过期策略、按用户/host 隔离的存储策略或 Redis/PostgreSQL 后端。
- cached event 补发目前是逐条 WebSocket message，后续 Android 端需要做本地去重。

关于何时开始构建 Android 应用：

- 从产品闭环看，现在可以开始 Android MVP Shell。主链路已经包括 session list、timeline、prompt、live assistant event 和 cursor recovery。
- 从当前机器环境看，还不能直接构建 Android，因为 `java`、`gradle` 和 `adb` 都不可用。
- 推荐下一步并行：一边补 Android 工具链，一边继续做 approval request/decision 映射。工具链一可用，就先做 host/session/timeline/prompt 的 Android 信息流壳。

下一步建议：

1. 补齐 Android 工具链并创建 Kotlin + Jetpack Compose skeleton。
2. 实现 approval request/decision 映射，支撑移动端“需要处理”入口。
3. 将 Relay cache 从内存抽象成接口，后续替换为 Redis/PostgreSQL。

## 2026-05-10: Android toolchain preparation and shell skeleton

状态：完成；Android debug build 已通过。

本次目标：

- 在不依赖本机 Android 工具链的前提下，先创建 Android MVP Shell 可编辑骨架。
- 增加工具链自检脚本，明确剩余人工安装项。
- 记录 Android 构建版本组合和安装路径。

完成内容：

- 新增 `android/` Gradle/Kotlin DSL 项目骨架。
- 新增 `android/app` Android application 模块。
- 新增 Kotlin + Jetpack Compose 静态首页：
  - host summary
  - session summary
  - timeline list
  - prompt composer
- 新增基础 manifest、theme、launcher icon、资源文件。
- 新增 `.gitignore`，忽略 Gradle/Android 构建产物和 local properties。
- 新增 `tools/check-android-toolchain.mjs`。
- 新增 `npm run check:android-toolchain`。
- 新增 `docs/android-toolchain.md`。

选用版本：

- Android Gradle Plugin: `9.2.0`
- Gradle: `9.4.1`
- JDK: `17`
- Android SDK Platform: `36`
- Android SDK Build Tools: `36.0.0`
- Kotlin Gradle plugin: `2.2.21`
- Compose BOM: `2026.04.01`
- Activity Compose: `1.12.4`

验证命令：

```powershell
npm run check:android-toolchain
```

验证结果：

```text
[missing] Java: spawn java ENOENT
[warn] Gradle: spawn gradle ENOENT
[warn] ADB: spawn adb ENOENT
[missing] Android SDK: set ANDROID_HOME or ANDROID_SDK_ROOT
```

后续完成：

- 已定位 JDK：`C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot`。
- 已安装 Android command-line tools 到 `%LOCALAPPDATA%\Android\Sdk`。
- 已通过 `sdkmanager` 安装 `platform-tools`、`platforms;android-36`、`build-tools;36.0.0`。
- 已接受 Android SDK licenses。
- 已下载 Gradle 9.4.1 并生成 Gradle wrapper。
- 已执行 `.\gradlew.bat :app:assembleDebug`，生成 debug APK。

构建验证命令：

```powershell
npm run check:android-toolchain
cd android
.\gradlew.bat :app:assembleDebug
```

本机当前 shell 如果未配置 Java/Android SDK，需要临时带上：

```powershell
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot'
$env:ANDROID_HOME='C:\Users\13372\AppData\Local\Android\Sdk'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
$env:Path="$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
.\gradlew.bat :app:assembleDebug
```

下一步建议：

1. 接入 Relay WebSocket，把静态首页替换为真实 session/timeline 数据。
2. 加入本地状态模型和 cursor 保存。
3. 增加 prompt send 的真实调用路径。

## 2026-05-10: Android Relay WebSocket MVP

状态：完成第一版真实链路。

本次目标：

- 将 Android shell 从静态 mock UI 升级为连接本地 Relay 的信息流窗口。
- 显示真实 `session.snapshot` 和 `timeline.event`。
- 让 prompt composer 通过 `session.prompt` 发送指令。

完成内容：

- 新增 `RelayClient`，使用 OkHttp WebSocket 连接 Relay。
- 新增 `RelayViewModel`，维护连接状态、sessions、selected session 和 timeline。
- 新增 `RelayModels`，定义 Android 端 session/timeline/ui state。
- App 启动后自动连接 `ws://10.0.2.2:8787`。
- 连接成功后发送 `session.subscribe`，订阅全部 sessions。
- 收到 session 后自动请求该 session 的 timeline。
- session list、timeline list 和 prompt composer 已改为真实状态驱动。
- Send 按钮发送 `session.prompt`。
- Android manifest 允许本地明文 WebSocket 调试。

验证命令：

```powershell
cd android
.\gradlew.bat :app:assembleDebug
npm run verify:delivery-strategy
npm run verify:relay-timeline-cache
```

验证结果：

```text
BUILD SUCCESSFUL
[verify] Delivery Strategy main path verified.
[verify] Relay timeline cache cursor replay verified.
```

当前限制：

- Relay URL 仍写死为模拟器地址 `ws://10.0.2.2:8787`。
- 真机需要后续增加设置页或 build config，改用电脑局域网 IP。
- Android 端还没有本地 Room cache，cursor 只在内存中计算。
- 还没有处理 approval card、push notification、Git 页面。
- 未做 UI 自动化测试或真机截图验证。

下一步建议：

1. 增加 Relay URL 设置和连接诊断。
2. 持久化 selected session、timeline cursor 和最近 events。
3. 实现 approval request/decision 映射，并在 Android 首页做“需要处理”入口。

## 2026-05-10: Android Relay URL settings and diagnostics

状态：完成。

本次目标：

- 让 Android App 不再只能连接写死的模拟器 Relay URL。
- 支持保存最近使用的 Relay URL。
- 增加基础连接诊断，便于模拟器、真机和云端 devbox 调试。

完成内容：

- 新增 `RelaySettings`，使用 SharedPreferences 保存 Relay URL。
- 新增 `RelayViewModelFactory`，向 ViewModel 注入 settings。
- `RelayViewModel` 支持 `saveRelayUrl()`，保存后清空旧 session/timeline 并自动重连。
- Relay URL 做最小校验：必须以 `ws://` 或 `wss://` 开头。
- UI Host 面板新增 Relay URL 输入框。
- UI Host 面板新增 Save 和 Connect/Refresh。
- UI 显示连接状态、session 数、timeline event 数、最后连接时间和最近错误。
- Relay 新增 `RELAY_HOST`，开发时可用 `RELAY_HOST=0.0.0.0` 允许真机局域网访问。

连接方式：

- Android 模拟器：`ws://10.0.2.2:8787`
- Android 真机：`ws://<电脑局域网 IP>:8787`
- 云端开发机：`wss://<relay domain>` 或通过 SSH/VPN 暴露的 WebSocket 地址

验证命令：

```powershell
cd android
.\gradlew.bat :app:assembleDebug
```

验证结果：

```text
BUILD SUCCESSFUL
```

## 2026-05-10: Git status snapshot MVP

Status: completed.

Goal:

- Advance the next MVP milestone by adding a minimal mobile Git workflow.
- Keep the phone as an information/control window, not a mobile IDE.
- Validate that Android/test client can request Git status for the selected Codex session and receive a structured snapshot.
- Keep Git write actions disabled by default.

Changes:

- Protocol added `git.request` and `git.snapshot`.
- Relay now routes `git.request` from paired clients to the Host Bridge that owns the target session.
- Relay broadcasts `git.snapshot` only to clients subscribed to that session.
- Host Bridge now declares `git.status` and `git.diff` capabilities.
- Host Bridge added `bridge/host-bridge/git-adapter.mjs`.
- Git adapter supports read-only status/diff summary and guarded commit/push.
- Android added a compact Git panel for branch, changed file count, diff stat preview, Status, and Diff.
- Added `tools/verify-git-flow.mjs` and `npm run verify:git-flow`.

Verification commands:

```powershell
npm run verify:git-flow
cd android
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot'
$env:ANDROID_HOME='C:\Users\13372\AppData\Local\Android\Sdk'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
$env:Path="$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
.\gradlew.bat :app:assembleDebug
```

Verification result:

```text
[verify] Git status snapshot flow verified.
BUILD SUCCESSFUL
```

Current limitations:

- Android currently exposes only Status and Diff summary. It does not show full file diff yet.
- Commit and push exist in the Host Bridge adapter but are intentionally hidden from Android UI and disabled unless `GIT_WRITE_ACTIONS_ENABLED=true`.
- Commit currently uses `git commit -am`, so it only commits tracked files. Untracked files need an explicit stage/add design before this becomes user-facing.
- Relay still does not persist Git snapshots; they are live messages only.
- There is no audit log yet for Git requests.

当前限制：

- 只保存 Relay URL，还没有保存 selected session、timeline cursor 或最近 events。
- 真机连接仍要求 Relay 地址在网络上可达；开发模式可用 `RELAY_HOST=0.0.0.0`，正式方案仍需要认证和 TLS。
- 没有 TLS、认证或 pairing flow。

下一步建议：

1. 持久化 selected session、timeline cursor 和最近 events。
2. 实现 approval request/decision 映射。
3. 增加 pairing/auth，替换开放局域网开发模式。

## 2026-05-10: Android local session and timeline cache

状态：完成轻量持久化。

本次目标：

- App 重启后不再从空白状态开始。
- 保存 selected session、最近 sessions、最近 timeline events 和 cursor。
- 重连后使用本地 cursor 向 Relay 补齐新事件。

完成内容：

- `RelaySettings` 新增 SharedPreferences 持久化：
  - Relay URL
  - selected session id
  - 最近 20 个 sessions
  - 最近 100 条 timeline events
- `RelayViewModel` 初始化时加载本地缓存。
- 收到 `session.snapshot` 后更新并保存 session cache。
- 收到 `timeline.event` 后更新并保存 timeline cache。
- 切换 selected session 时保存 selected session id。
- 连接成功后对 selected session 使用本地最新 cursor 请求增量 timeline。
- 切换 Relay URL 时清空旧 session/timeline cache，避免跨 host 混淆。
- UI 连接诊断增加 selected session 信息。

验证命令：

```powershell
cd android
.\gradlew.bat :app:assembleDebug
npm run verify:delivery-strategy
npm run verify:relay-timeline-cache
```

验证结果：

```text
BUILD SUCCESSFUL
[verify] Delivery Strategy main path verified.
[verify] Relay timeline cache cursor replay verified.
```

当前限制：

- 当前持久化使用 SharedPreferences + JSON，适合 MVP，不适合长期大规模 timeline。
- timeline event 去重只按 `event_id`，如果上游 event id 不稳定，后续需要更强的去重键。
- 只对 selected session 自动做 cursor recovery；多 session 背景同步留到后续。

下一步建议：

1. 实现 approval request/decision 映射。
2. 增加 Android “需要处理”入口。
3. 后续再把 SharedPreferences cache 替换为 Room。

## 2026-05-10: Relay health diagnostics for mobile LAN setup

状态：完成。

本次目标：

- 增强 Relay `/health`，让真机局域网调试时能快速判断 Relay 是否可达。
- 在 Android App 中增加 Test Connection，直接检查当前 Relay URL 对应的 `/health`。

完成内容：

- Relay `/health` 返回更完整诊断：
  - service name
  - listen host/port
  - websocket URL
  - health URL
  - LAN access flag
  - host/session/client/subscription counts
  - timeline cache counts
  - next cursor
- Android `RelayClient` 新增 `testHealth()`。
- Android 将 `ws://` 转换为 `http://.../health`，将 `wss://` 转换为 `https://.../health`。
- Android Relay 面板新增 Test 按钮。
- Android UI 显示 health check 摘要或错误。
- 新增 `npm run verify:relay-health`。

验证命令：

```powershell
npm run verify:relay-health
npm run verify:delivery-strategy
npm run verify:relay-timeline-cache
cd android
.\gradlew.bat :app:assembleDebug
```

验证结果：

```text
[verify] Relay health endpoint verified.
[verify] Delivery Strategy main path verified.
[verify] Relay timeline cache cursor replay verified.
BUILD SUCCESSFUL
```

真机调试路径：

1. 电脑启动 Relay：
   ```powershell
   $env:RELAY_HOST='0.0.0.0'
   npm run relay
   ```
2. 电脑启动 Bridge：
   ```powershell
   $env:RELAY_URL='ws://127.0.0.1:8787'
   npm run bridge
   ```
3. 手机 App Relay URL 填 `ws://<电脑局域网 IP>:8787`。
4. 点击 Test，确认 health 显示 `health ok`。

当前限制：

- `/health` 未加认证，只适合受信任局域网开发模式。
- Test Connection 只验证 HTTP health，不保证 WebSocket prompt 权限。
- Windows 防火墙仍可能阻止真机访问，需要用户手动放行端口 8787。

下一步建议：

1. 增加临时 dev token，避免局域网任意设备可发 prompt。
2. 实现 approval request/decision 映射。
3. 做真机端到端操作记录和故障排查文档。

## 2026-05-10: Relay temporary dev token guard

状态：完成。

本次目标：

- 给 Relay 增加临时 `RELAY_DEV_TOKEN`，避免局域网任意设备连接后发送 `session.prompt`。
- 让 Android、Host Bridge 和 Node 测试客户端都能携带同一个 dev token。
- 顺手减少 prompt 正文在本机日志中的暴露。

完成内容：

- 协议层 `createMessage()` 支持顶层 `auth` 对象。
- Relay 在设置 `RELAY_DEV_TOKEN` 后校验所有 WebSocket 入站消息的 `auth.dev_token`。
- Relay 监听 `0.0.0.0` 时如果没有 `RELAY_DEV_TOKEN` 会拒绝启动。
- Relay `/health` 支持 `X-Relay-Dev-Token`：
  - 未认证时只返回 `auth_required` 和基础可达信息。
  - 认证后返回完整 host/session/client/cache 诊断。
- Host Bridge 支持读取 `RELAY_DEV_TOKEN` 并给注册、心跳、session snapshot、timeline event 带 token。
- test/timeline/ephemeral/steer 客户端支持读取 `RELAY_DEV_TOKEN`。
- Android App 新增 Dev token 设置项，保存到 SharedPreferences。
- Android WebSocket 消息携带 `auth.dev_token`，Test Connection 会设置 `X-Relay-Dev-Token`。
- Relay 和 Bridge 日志不再打印 prompt 正文。
- 新增 `npm run verify:relay-dev-token`。

运行命令：

```powershell
$env:RELAY_HOST='0.0.0.0'
$env:RELAY_DEV_TOKEN='choose-a-random-dev-token'
npm run relay

$env:RELAY_URL='ws://127.0.0.1:8787'
$env:RELAY_DEV_TOKEN='choose-a-random-dev-token'
npm run bridge
```

Android 真机设置：

- Relay URL: `ws://<电脑局域网 IP>:8787`
- Dev token: 与 Relay/Bridge 的 `RELAY_DEV_TOKEN` 相同

验证命令：

```powershell
npm run verify:relay-dev-token
npm run verify:relay-health
npm run verify:delivery-strategy
npm run verify:relay-timeline-cache
cd android
.\gradlew.bat :app:assembleDebug
```

验证结果：

```text
[verify] Relay dev-token guard verified.
[verify] Relay health endpoint verified.
[verify] Delivery Strategy main path verified.
[verify] Relay timeline cache cursor replay verified.
BUILD SUCCESSFUL
```

当前限制：

- 这是临时共享 token，不是正式认证体系；token 一旦泄露，需要手动更换。
- Android 端目前用 SharedPreferences 保存 token，适合开发原型；后续应迁移到 Android Keystore。
- 仍未启用 TLS/WSS，受信任局域网之外不能使用明文 WebSocket。
- Relay 还没有 per-device identity、审计日志、速率限制或 host 操作策略。

后续安全建议：

1. 做 pairing flow：一次性配对码 + 设备密钥，替代手填共享 token。
2. Android 使用 Keystore 保存设备密钥或 token。
3. Relay 增加连接数、消息频率和 prompt 长度限制。
4. Host Bridge 增加 command policy：危险操作仍需审批，且按能力白名单执行。
5. 对 timeline、health、日志、通知做统一 secret redaction。

## 2026-05-10: Pairing and device-token security hardening

状态：完成。

本次目标：

- 把上一轮共享 dev token 收口为开发期配对模型。
- 避免手机端长期直接用 `RELAY_DEV_TOKEN` 发 prompt。
- 给 Android 控制凭据加系统级加密存储。

完成内容：

- Relay 新增 `POST /pair`：
  - 请求必须带 `X-Relay-Dev-Token` 或 `X-Relay-Auth-Token`。
  - 成功后返回随机 `device_token`。
  - Relay 在内存中记录 paired devices。
- Relay 授权模型调整：
  - Host 消息使用 pairing token：`host.register`、`host.heartbeat`、`session.snapshot`、`timeline.event`。
  - Client 控制消息必须使用 device token：`session.subscribe`、`session.timeline.request`、`session.prompt`、`session.create_ephemeral`。
  - `/health` 支持 pairing token 或 device token 获取详细诊断。
- Relay 新增基础滥用防护：
  - `RELAY_MAX_MESSAGE_BYTES`，默认 65536。
  - `RELAY_MAX_PROMPT_LENGTH`，默认 4000。
- Android App 新增 Pair 按钮：
  - Relay URL + Pairing token 保存后，点击 Pair 调用 `/pair`。
  - 成功后保存 device id/device token，并自动重连。
  - WebSocket、prompt、Test Connection 优先使用 device token。
- Android 新增 `SecureTokenStore`，使用 Android Keystore + AES/GCM 加密保存 pairing token 和 device token。
- Node test/timeline/ephemeral/steer clients 改为读取 `RELAY_DEVICE_TOKEN`。
- 相关 verify 脚本会先 `/pair`，再用 device token 执行 client 路径。
- README 和 implementation plan 已更新。

真机测试路径：

1. 电脑启动 Relay：
   ```powershell
   $env:RELAY_HOST='0.0.0.0'
   $env:RELAY_DEV_TOKEN='choose-a-random-dev-token'
   npm run relay
   ```
2. 电脑启动 Bridge：
   ```powershell
   $env:RELAY_URL='ws://127.0.0.1:8787'
   $env:RELAY_DEV_TOKEN='choose-a-random-dev-token'
   npm run bridge
   ```
3. Android App 填：
   - Relay URL: `ws://<电脑局域网 IP>:8787`
   - Pairing token: `choose-a-random-dev-token`
4. 点击 Save。
5. 点击 Pair，看到 `Paired device ...`。
6. 点击 Test，看到 `health ok`。
7. 点击 Connect/Refresh，看到 session 后发送 `总结当前进度`。

当前安全限制：

- `/pair` 仍使用手填共享 pairing token，不是一次性扫码配对。
- Relay device tokens 仅在内存中，Relay 重启后需要重新 Pair。
- 还没有 TLS/WSS，不适合离开受信任局域网。
- 还没有 per-device revoke、审计日志、速率限制和 IP allowlist。

MVP 剩余缺口：

1. Approval request/decision 映射。
2. Git status/diff/commit/push 最小入口。
3. Android 系统通知。
4. Relay/Bridge 自动重连与退避策略。
5. 真机端到端测试手册和故障排查清单。

## 2026-05-10: Approval request/decision protocol shell

状态：完成。

本次目标：

- 继续 MVP 主线，先打通移动端 approval request/decision 的协议和 UI 主链路。
- 暂不直接接真实 Codex App Server approval request，先用 Mock adapter 验证端到端路由。

完成内容：

- 协议新增：
  - `approval.request`
  - `approval.decision`
- Relay 新增 approval 内存状态：
  - Host Bridge 可上报 pending approval。
  - Client subscribe `*` 或具体 session 时会收到 pending approval。
  - Client 发送 decision 后，Relay 路由到对应 Host Bridge。
  - Relay 广播 resolved approval 状态。
- Mock Host Bridge 新增一个 mock approval：
  - `mock-approval-001`
  - kind: `shell`
  - command: `npm test`
  - allowed decisions: `approve_once`, `deny`
- Mock adapter 支持 `resolveApproval()`，收到 decision 后回传 `approval_resolved` timeline event。
- Android 新增 approval inbox：
  - 展示 selected session 的 pending approvals。
  - 展示 title、summary、command、risk。
  - 支持 Approve / Deny。
- 新增 `npm run verify:approval-flow`。

验证命令：

```powershell
npm run verify:approval-flow
npm run verify:delivery-strategy
npm run verify:relay-dev-token
cd android
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot'
$env:ANDROID_HOME='C:\Users\13372\AppData\Local\Android\Sdk'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
$env:Path="$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
.\gradlew.bat :app:assembleDebug
```

当前限制：

- 真实 Codex App Server server request 还没有接到 `approval.request`。
- Android approval 状态暂不持久化，重连后依赖 Relay pending approval replay。
- Relay approval 状态仍是内存态，Relay 重启后丢失。

下一步建议：

1. 调研并接入 App Server `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval` 的 request/response。
2. 再做 Git status/diff/commit/push 最小入口。

## 2026-05-10: Real App Server approval request mapping

状态：完成。

本次目标：

- 把真实 Codex App Server 的 approval server request 接入上一轮 `approval.request` / `approval.decision` 通道。
- 让手机端 decision 能回写到 App Server JSON-RPC request。

完成内容：

- `AppServerCodexAdapter` 现在识别 App Server server request：
  - `item/commandExecution/requestApproval`
  - `item/fileChange/requestApproval`
  - `item/permissions/requestApproval`
  - `execCommandApproval`
  - `applyPatchApproval`
- 将 App Server params 映射为移动端 approval card 字段：
  - session id
  - kind
  - title / summary
  - command / cwd
  - risk level
  - allowed decisions
  - app-server request id
- `resolveApproval()` 会把手机端 decision 转回 App Server response：
  - command execution: `accept` / `acceptForSession` / `decline`
  - file change: `accept` / `acceptForSession` / `decline`
  - permissions: granted permission profile + `turn` / `session` scope
  - legacy exec/applyPatch: `approved` / `approved_for_session` / `denied`
- `CODEX_APPROVAL_POLICY` 可控制 App Server session 的 approval policy；默认仍是 `never`。
- 新增 `npm run verify:app-server-approval-mapper`：
  - 验证真实 App Server approval params 到 mobile approval 的映射。
  - 验证 mobile decision 到 App Server result 的映射。
  - 用 fake socket 验证 `handleMessage()` server request 和 `resolveApproval()` 写回路径。

验证命令：

```powershell
npm run verify:app-server-approval-mapper
npm run verify:approval-flow
npm run verify:delivery-strategy
npm run verify:relay-dev-token
cd android
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot'
$env:ANDROID_HOME='C:\Users\13372\AppData\Local\Android\Sdk'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
$env:Path="$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
.\gradlew.bat :app:assembleDebug
```

当前限制：

- 尚未用真实 Codex dangerous action 触发端到端 approval，因为这会执行/尝试执行真实 shell 或文件写操作；需要手动选择安全命令验证。
- Android approval card 目前只支持 approve once / approve session / deny 的通用动作，不展示 App Server 的全部细粒度 amendment 选项。
- Permissions deny 当前映射为授予空权限并 strict auto review，后续需要确认 App Server 是否有更明确的 deny 语义。

下一步建议：

1. 用安全命令手测真实 approval，例如在 `CODEX_APPROVAL_POLICY='on-request'` 下请求运行只读命令。
2. 进入 Git status/diff/commit/push MVP。

## 2026-05-10: Manual App Server approval test flow

状态：完成。

本次目标：

- 提供一个可复用的真实 App Server approval 手测流程。
- 让用户可以在 Android 上实际点击 Approve/Deny 验证闭环。

完成内容：

- 新增 `npm run manual:app-server-approval`。
- 新增 `tools/manual-app-server-approval.mjs`：
  - 启动 Relay，默认端口 `8810`。
  - 启动真实 `CODEX_ADAPTER=app-server` Bridge。
  - 设置 `CODEX_APPROVAL_POLICY=on-request`。
  - 自动生成 pairing token。
  - 打印模拟器/真机 Relay URL 和 Pairing token。
  - 使用 ephemeral client 请求 Codex 运行只读命令 `node --version`。
- `tools/ephemeral-prompt-client/` 支持 `EPHEMERAL_CLIENT_EXPECT_EVENT_TYPES=any`，便于手测观察真实事件。
- 新增 `docs/manual-app-server-approval-test.md`，记录 Android 操作步骤、预期日志和故障排查。

运行命令：

```powershell
npm run manual:app-server-approval
```

Android 操作：

1. 填脚本输出的 Relay URL。
2. 填脚本输出的 Pairing token。
3. 点击 Save。
4. 点击 Pair。
5. 点击 Test。
6. 点击 Connect/Refresh。
7. 等 `Needs attention` 卡片出现后点击 Approve 或 Deny。

当前限制：

- 这是手测流程，不是 CI 自动测试。
- 是否出现 approval card 取决于真实 Codex 是否按 prompt 请求执行命令。
- 如果 Codex 直接回答而未请求命令，需要重跑并把 prompt 改得更明确。

## 2026-05-10: Android dashboard scroll fix

Status: completed.

Goal:

- Fix small Android screens where the dashboard could not scroll and bottom prompt/actions were unreachable.

Changes:

- Added vertical scrolling to the top-level `SessionDashboard` content.
- Replaced the timeline panel `weight(1f)` with a bounded height range so it does not push the prompt composer off-screen.
- Changed the default Chinese prompt string to Kotlin unicode escapes to avoid Windows encoding corruption.

Verification command:

```powershell
cd android
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot'
$env:ANDROID_HOME='C:\Users\13372\AppData\Local\Android\Sdk'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
$env:Path="$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
.\gradlew.bat :app:assembleDebug
```

Expected result:

```text
BUILD SUCCESSFUL
```

## 2026-05-10: Android Relay action button layout fix

状态：完成。

本次目标：

- 修复 Relay connection 面板里四个操作按钮在手机窄屏上被挤压的问题。

完成内容：

- 将 Save / Pair / Connect-Refresh / Test 从单行四按钮改为两行 2x2 布局。
- 每个按钮使用等宽 `weight(1f)` 和最小高度，避免第四个按钮被压成极小块。
- 按钮文本限制单行并使用 ellipsis，避免长状态文案撑破布局。

验证命令：

```powershell
cd android
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot'
$env:ANDROID_HOME='C:\Users\13372\AppData\Local\Android\Sdk'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
$env:Path="$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
.\gradlew.bat :app:assembleDebug
```

验证结果：

```text
BUILD SUCCESSFUL
```

## 2026-05-10: Git file-level diff preview

Status: completed.

Goal:

- Let the mobile client inspect a changed file before any future commit/push flow.
- Keep diff review compact and read-only.
- Avoid turning Android into a source editor.

Changes:

- Reused `git.request` with `action: "diff"` and optional `file_path`.
- Host Bridge now returns:
  - `selected_file_path`
  - `selected_file_diff`
  - `selected_file_diff_truncated`
- Host Bridge validates requested diff paths as relative repo paths and rejects absolute/parent traversal style paths.
- Host Bridge reads file diff using `git diff HEAD -- <file>`.
- File diff payload is capped by `GIT_FILE_DIFF_MAX_BYTES`, default `20000`.
- Android Git panel now shows a compact changed-file list.
- Tapping a changed file requests and displays a compact diff preview.
- `npm run verify:git-flow` now creates a temporary README diff, verifies the file-level diff payload, then restores the file.

Verification commands:

```powershell
npm run verify:git-flow
cd android
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot'
$env:ANDROID_HOME='C:\Users\13372\AppData\Local\Android\Sdk'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
$env:Path="$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
.\gradlew.bat :app:assembleDebug
```

Verification result:

```text
[verify] Git status and file diff snapshot flow verified.
BUILD SUCCESSFUL
```

Current limitations:

- Diff preview is compact and capped; it is not a full diff review screen yet.
- Binary diffs, renames, staged-only edge cases, and untracked file contents are not handled as first-class UX yet.
- Commit/push remain hidden from Android and disabled by default.

Next recommended step:

1. Add Relay/Bridge audit events for Git requests.
2. Add an explicit commit confirmation flow after audit logging exists.

## 2026-05-10: Git action audit events

Status: completed.

Goal:

- Add traceability before exposing any Git write action in Android.
- Record who requested Git status/diff/commit/push, for which session, and what result came back.
- Avoid storing source diff contents or commit messages in audit metadata.

Changes:

- Relay now keeps an in-memory `gitAuditEvents` log capped by `RELAY_AUDIT_LOG_LIMIT`, default `500`.
- `/health` detailed diagnostics now include `counts.git_audit_events`.
- On `git.request`, Relay records a `requested` audit event with:
  - audit id
  - session id / host id
  - action
  - optional file path
  - paired device id/display name
- Relay injects `audit_id` into the routed Host Bridge request.
- Host Bridge echoes `audit_id` back in `git.snapshot`.
- On `git.snapshot`, Relay records a `completed` audit event with:
  - result ok/blocked state
  - result message summary
  - changed file count
- Relay converts each audit entry into a metadata-only `git_audit` timeline event so Android can see the audit trail without a new UI surface.
- `npm run verify:git-flow` now verifies requested/completed audit events and `/health` audit counts.

Verification command:

```powershell
npm run verify:git-flow
```

Verification result:

```text
[verify] Git status, file diff, and audit flow verified.
```

Current limitations:

- Audit storage is in-memory only; Relay restart clears it.
- There is no audit query endpoint yet beyond timeline events and `/health` counts.
- Audit events intentionally do not include diff contents.

Next recommended step:

1. Add explicit commit confirmation UI and keep write execution behind `GIT_WRITE_ACTIONS_ENABLED=true`.
2. Add persistent audit storage before broader use outside local development.

## 2026-05-10: Android commit confirmation flow

Status: completed.

Goal:

- Add the mobile-side confirmation step for Git commit without enabling writes by default.
- Keep the write boundary on Host Bridge policy, not Android UI state alone.

Changes:

- Android Git panel now includes a commit message field.
- Commit button is enabled only when there is a selected online session, changed files are present, and the message is non-empty.
- Tapping Commit opens a confirmation dialog showing changed file count and commit message.
- Confirm sends `git.request` with `action: "commit"` and `message`.
- Host Bridge behavior remains unchanged: real commit execution requires `GIT_WRITE_ACTIONS_ENABLED=true`.
- With default settings, confirmed commits return the existing blocked/disabled `git.snapshot` result and are covered by Git audit events.

Verification commands:

```powershell
npm run verify:git-flow
cd android
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot'
$env:ANDROID_HOME='C:\Users\13372\AppData\Local\Android\Sdk'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
$env:Path="$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
.\gradlew.bat :app:assembleDebug
```

Verification result:

```text
[verify] Git status, file diff, and audit flow verified.
BUILD SUCCESSFUL
```

Current limitations:

- The current commit adapter uses `git commit -am`, so it only covers tracked files.
- Push confirmation is still not implemented.

Next recommended step:

1. Add explicit stage/add strategy before enabling untracked-file commits.
2. Then add push confirmation with host policy checks.

## 2026-05-10: Tracked and untracked Git handling

Status: completed.

Goal:

- Prevent the mobile commit flow from implying untracked files will be committed.
- Keep the current write strategy conservative and explicit.

Changes:

- Host Bridge now marks each Git file as `tracked: true/false`.
- Git snapshots include:
  - `tracked_file_count`
  - `untracked_file_count`
  - `commit_strategy: "tracked_only_commit_am"`
- Commit blocked/validation messages now mention that the current strategy covers tracked files only.
- If untracked files exist, commit result messages include how many will not be committed.
- Android parses tracked/untracked counts.
- Android Git panel shows tracked and untracked counts.
- Android commit confirmation warns when untracked files will not be included.
- `npm run verify:git-flow` now creates a temporary untracked file and verifies it is marked `tracked=false`.

Verification commands:

```powershell
npm run verify:git-flow
cd android
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot'
$env:ANDROID_HOME='C:\Users\13372\AppData\Local\Android\Sdk'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
$env:Path="$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
.\gradlew.bat :app:assembleDebug
```

Verification result:

```text
[verify] Git status, file diff, and audit flow verified.
BUILD SUCCESSFUL
```

Current limitations:

- Untracked files are identified and warned about, but not staged or committed.
- Real commit execution is still gated by `GIT_WRITE_ACTIONS_ENABLED=true`.
- Push confirmation is still not implemented.

Next recommended step:

1. Add an explicit stage/add policy for untracked files.
2. Add push confirmation after commit semantics are clear.

## 2026-05-10: Explicit Git commit strategy

Status: completed.

Goal:

- Let mobile users choose whether a commit request should cover tracked files only or include untracked files.
- Keep real Git writes host-gated and disabled by default.

Changes:

- Protocol payloads now accept `commit_strategy` on `git.request`.
- Host Bridge normalizes commit strategy to:
  - `tracked_only`
  - `include_untracked`
- `tracked_only` keeps the existing `git commit -am` behavior when Git writes are enabled.
- `include_untracked` runs `git add -A` and then `git commit -m` only when `GIT_WRITE_ACTIONS_ENABLED=true`.
- When Git writes are disabled, commit requests still return a blocked `git.snapshot`, but the selected strategy is preserved in `commit_strategy` and result messaging.
- Android Git panel shows a two-option strategy selector when untracked files exist.
- Android confirmation dialog reflects whether untracked files will be excluded or staged.
- `npm run verify:git-flow` now sends `commit_strategy: "include_untracked"` and verifies the disabled path preserves that strategy.

Verification commands:

```powershell
npm run verify:git-flow
cd android
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot'
$env:ANDROID_HOME='C:\Users\13372\AppData\Local\Android\Sdk'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
$env:Path="$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
.\gradlew.bat :app:assembleDebug
```

Verification result:

```text
[verify] Git status, file diff, and audit flow verified.
BUILD SUCCESSFUL
```

Current limitations:

- Real commit execution is still gated by `GIT_WRITE_ACTIONS_ENABLED=true`.
- Push confirmation is still not implemented.
- Git audit events remain in-memory metadata events; they are not persistent/queryable yet.

Next recommended step:

1. Add push confirmation with host policy checks.
2. Add persistent/queryable Git audit storage.

## 2026-05-10: Push confirmation and host policy

Status: completed.

Goal:

- Add a mobile push request path without making push easy to trigger accidentally.
- Keep real push execution behind host-side policy gates.

Changes:

- Android Git panel now exposes Push only when the latest Git snapshot has a clean worktree.
- Tapping Push opens a confirmation dialog explaining the branch and host policy requirements.
- Android sends `git.request` with `action: "push"` only after confirmation.
- Host Bridge push execution now requires both:
  - `GIT_WRITE_ACTIONS_ENABLED=true`
  - `GIT_PUSH_ACTIONS_ENABLED=true`
- Host Bridge blocks push unless:
  - the repository is valid,
  - the current branch is known and not detached,
  - the branch has an upstream tracking branch,
  - the worktree is clean.
- Host Bridge uses `git push --porcelain` when all policy gates pass.
- `npm run verify:git-flow` now covers the default blocked push path and verifies requested/completed Git audit events.
- The verify script now removes WebSocket message listeners after matching messages to avoid listener accumulation warnings.

Verification commands:

```powershell
npm run verify:git-flow
cd android
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot'
$env:ANDROID_HOME='C:\Users\13372\AppData\Local\Android\Sdk'
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
$env:Path="$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
.\gradlew.bat :app:assembleDebug
```

Verification result:

```text
[verify] Git status, file diff, commit strategy, push policy, and audit flow verified.
BUILD SUCCESSFUL
```

Current limitations:

- Push has not been manually tested against a disposable remote with host gates enabled.
- Git audit events remain in-memory metadata events; they are not persistent/queryable yet.

Next recommended step:

1. Add persistent/queryable Git audit storage.
2. Add a disposable-remote manual test checklist before enabling push for real repositories.

## 2026-05-10: Persistent Git audit storage

Status: completed.

Goal:

- Preserve Git action audit events across Relay restarts.
- Provide a small authenticated query endpoint before Git write operations are used on real repositories.

Changes:

- Relay now writes Git audit events as NDJSON.
- Default audit path is `.relay/git-audit.ndjson`.
- `RELAY_GIT_AUDIT_LOG_PATH` can override the audit file location.
- Relay loads the latest `RELAY_AUDIT_LOG_LIMIT` events from the audit file on startup.
- Added authenticated `GET /git/audit` query endpoint.
- Query filters:
  - `session_id`
  - `host_id`
  - `action`
  - `phase`
  - `limit`
- `/health` detailed diagnostics now include Git audit storage settings.
- `.relay/` is ignored by Git.
- Added `npm run verify:git-audit-storage`.

Verification commands:

```powershell
npm run verify:git-audit-storage
npm run verify:git-flow
npm run verify:relay-health
```

Verification result:

```text
[verify] Git audit persistent storage and query endpoint verified.
[verify] Git status, file diff, commit strategy, push policy, and audit flow verified.
[verify] Relay health endpoint verified.
```

Current limitations:

- Audit storage is a local append-only NDJSON file, not a database.
- There is no Android audit browser yet; audit events remain visible through timeline and queryable through Relay HTTP.
- There is no log rotation/compaction beyond loading only the latest `RELAY_AUDIT_LOG_LIMIT` records into memory.

Next recommended step:

1. Add a disposable-remote manual test checklist before enabling push for real repositories.
2. Consider Android read-only audit view after real-device Git testing.
