# Implementation Plan

本文是 Codex Mobile Companion 的施工计划。目标是先验证关键链路，再逐步做成个人可用的 Android 移动协作工具。

## 1. Delivery Strategy

优先级排序：

1. 先证明 Android 可以看到 Codex session 并发送一条指令。
2. 再证明 approval 和通知链路可靠。
3. 再加入 Git status/diff/commit/push。
4. 最后扩展 PR、CI、团队权限和自托管能力。

不要在早期投入完整 IDE、复杂代码编辑器或大型平台能力。

当前执行状态（2026-05-10）：

- 第一条主链路已用 Node test client 代替 Android App 验证通过。
- 已完成最小 Relay、Host Bridge、MockCodexAdapter 和 test client。
- 当前机器已完成 Android 命令行工具链安装；Android MVP Shell 骨架已创建，并已通过 debug build。
- WindowsApps app alias 的 `codex --help` 和 `codex --version` 返回 `Access is denied`；VS Code 扩展内置 Codex CLI 可执行，版本为 `codex-cli 0.129.0-alpha.15`。
- App Server 协议覆盖初判和 loopback 连接验证已完成；`initialize` 与 `thread/list` 可用，首选真实 adapter 是 App Server Adapter，详见 `docs/codex-api-coverage.md`。
- `AppServerCodexAdapter` 只读 MVP 已完成，可通过 `CODEX_ADAPTER=app-server` 启用，并已验证能通过 Relay 发布真实 Codex threads。
- `thread/read` timeline MVP 已完成，真实 thread turns/items 可通过 `session.timeline.request` 映射为移动端 timeline events。
- App Server live notifications 已映射为增量 timeline events，但还未通过真实 `turn/start` 长任务做端到端验证。
- `turn/start` prompt routing 已完成，Host Bridge 会先 resume 未加载 thread，再将移动端 prompt 发送到真实 Codex App Server。
- prompt 验证已改为创建专用 ephemeral thread，避免污染用户真实历史会话。
- active turn 的 `turn/steer` prompt routing 已完成，移动端后续指令可以追加到正在运行的 Codex turn。
- prompt 验证已升级为等待 live `assistant_delta` 或 `turn_completed`，证明移动端可看到真实 Codex 回答事件。
- App Server prompt 链路已区分 retryable error 和 terminal error；`willRetry: true` 会显示为 `codex_retrying`，不再中断移动端等待。
- Relay 已实现最小内存 timeline cache 和 `after_cursor` 补发，可支撑移动端断线重连后的事件恢复原型。
- Android 应用骨架已开始构建，Gradle wrapper 已生成，`.\gradlew.bat :app:assembleDebug` 已通过。
- Android 已接入 Relay WebSocket，支持 session snapshot、timeline event 和 prompt send 的第一版真实链路。
- Android 已支持 Relay URL 编辑保存、重连和基础连接诊断，模拟器/真机可以切换不同 Relay 地址。
- Android 已用 SharedPreferences 持久化最近 sessions、timeline events、selected session 和 cursor recovery 状态。
- Relay 已加入临时配对安全模型：局域网监听必须配置 `RELAY_DEV_TOKEN`，Host Bridge 用 pairing token 注册，Android/Node client 必须通过 `/pair` 换取 device token 后才能订阅 session、请求 timeline 或发送 prompt。
- Approval request/decision 的协议壳、Relay 路由、Android 待处理卡片和真实 App Server approval request/response 映射已完成；真实危险操作端到端触发仍待手动验证。
- App Server adapter 默认审批策略已从 `never` 改为 `on-request` + `approvalsReviewer: "user"`，避免 Codex 诊断命令被直接 `blocked by policy`，同时保持命令需用户审批。
- Git Workflow MVP 已开始：Relay/Bridge 支持 `git.request` / `git.snapshot`，Host Bridge 增加本地 Git adapter，Android 增加选中 session 的 Git status/diff summary 面板、file-level diff preview、commit confirmation UI 和 tracked/untracked commit strategy，Relay 已产生 metadata-only Git action audit timeline events，并将 Git audit 以 NDJSON 持久化到 `RELAY_GIT_AUDIT_LOG_PATH` / `.relay/git-audit.ndjson`。commit/push 执行仍默认禁用，等 host write policy 补完后再开放。
- 详细记录见 `docs/progress.md`。

## 2. Milestone 0: Research Spike

目标：确认 Host Bridge 与 Codex Runtime 的可行集成方式。

任务：

- 调研 Codex App Server/SDK 是否能列出 projects、threads、events。
- 验证是否能向现有 session 追加 prompt。
- 验证 approval request 是否能捕获并回复。
- 验证 Git status/diff 是否可以通过 Codex 接口或 Host Bridge 本地 Git adapter 获取。
- 输出 API coverage matrix。

验收标准：

- 明确首选 adapter：Codex App Server/SDK 或 CLI wrapper。
- 能描述 session event、prompt、approval、Git 四类能力的可行方案。
- 明确哪些能力必须降级或暂缓。

产物：

- `docs/codex-api-coverage.md`
- 最小 adapter demo。

## 3. Milestone 1: Host Bridge Prototype

目标：在本机或服务器上运行一个 bridge，能把 Codex session 状态变成结构化事件。

任务：

- 创建 Host Bridge 项目骨架。
- 实现 host config 和 host id。
- 实现与 Relay 的出站连接。
- 实现 session list。
- 实现 timeline event normalization。
- 实现 send prompt。
- 实现 approval request/decision 的最小链路。
- 实现 host heartbeat。

验收标准：

- Host Bridge 启动后能注册到 Relay。
- Relay 能看到 host online。
- Android 或测试 client 能看到 session list。
- 从测试 client 发送 prompt 后，Codex session 能收到。
- approval request 能从 Codex 传到测试 client，并能 approve/deny。

风险控制：

- 所有 shell/Git 写操作默认 disabled。
- 原始 terminal log 不上传，除非测试模式显式开启。

## 4. Milestone 2: Relay Prototype

目标：实现可支撑单用户 MVP 的 session routing 和事件同步。

任务：

- 创建 Relay Service 项目骨架。
- 实现用户认证的临时方案。
- 实现 device registration。
- 实现 host registration。
- 实现 pairing code flow。
- 实现 WebSocket/SSE event subscription。
- 实现 event cursor。（Node 原型已完成内存版）
- 实现短期 event cache。（Node 原型已完成内存版）
- 实现 audit log。
- 实现 push notification stub。

验收标准：

- Host Bridge 可以通过出站连接连到 Relay。
- Android/test client 可以订阅 host sessions。
- 断线重连后可以通过 cursor 拉取漏掉的事件。
- Relay 不存储源码和未脱敏 terminal log。

## 5. Milestone 3: Android MVP Shell

目标：做出 Android 端的基本信息流体验。

启动条件：

- Relay/Bridge 已支持 session list、timeline、prompt 和 cursor recovery 原型。
- 开发机器具备 JDK、Gradle/Android Gradle Plugin、Android SDK 和 adb。
- 初版 Android 只连接本地开发 Relay，不做账号体系、推送和复杂 Git 操作。

任务：

- 创建 Android 项目。
- 搭建 Jetpack Compose navigation。
- 实现登录或本地开发 token 输入。
- 实现扫码/配对码绑定 host。
- 实现 host list。
- 实现 session list。
- 实现 session detail timeline。
- 实现 command composer。
- 实现 approval card。
- 实现本地 Room cache。
- 实现 WebSocket/SSE 订阅和 cursor recovery。

验收标准：

- 手机可以绑定一台 host。
- 手机可以看到 active sessions。
- 手机可以打开 session 并看到 timeline 更新。
- 手机可以发送一条 prompt。
- 手机可以处理 approval request。
- App 重启后可以恢复最近 session 摘要。

UI 要求：

- 首页优先展示“需要处理”的 session。
- Timeline 默认展示摘要，不刷 raw log。
- Approval card 明确展示风险、影响和动作。
- 所有危险动作必须二次确认。

## 6. Milestone 4: Notifications

目标：让用户离开 App 后仍能知道 Codex 是否需要处理。

任务：

- 接入 FCM 或兼容推送服务。
- Android 注册 push token。
- Relay 保存 device push target。
- Host Bridge 上报 notification-worthy events。
- Relay 根据用户策略发送通知。
- Android notification deep link 到 session/approval/diff。
- 实现通知偏好设置。

验收标准：

- 任务完成时手机收到通知。
- 需要 approval 时手机收到通知。
- 点击通知进入对应 session 或 approval card。
- 用户可以关闭低优先级通知。

通知事件首批支持：

- `waiting_for_input`
- `waiting_for_approval`
- `completed`
- `failed`
- `tests_failed`
- `ready_for_review`

## 7. Milestone 5: Git Workflow

目标：支持移动端完成常见 Git 收尾。

当前状态（2026-05-10）：

- 已完成最小 status snapshot 链路：Android/test client -> Relay -> Host Bridge -> local Git adapter -> Relay -> Android/test client。
- 已验证 `npm run verify:git-flow`。
- Android 已有紧凑 Git 面板，支持 Status / Diff summary 和点击 changed file 查看单文件 diff preview。
- Relay 已有 metadata-only Git action audit，记录 requested/completed、device、action、file path 和结果摘要；当前已支持 NDJSON 持久化和 `GET /git/audit` 查询。
- Android Git 面板已支持按 selected session 刷新最近 Git audit entries。
- Android 已有 commit message 输入和二次确认 UI；commit 执行默认受 `GIT_WRITE_ACTIONS_ENABLED=true` 保护。
- Git snapshot 已区分 tracked/untracked files；Android commit confirmation 支持 `tracked_only` 和 `include_untracked` 两种策略。`include_untracked` 只有在 Host Bridge 显式启用 `GIT_WRITE_ACTIONS_ENABLED=true` 后才会执行 `git add -A`。
- push 已接入 Android 二次确认 UI 和 Host Bridge policy；执行需同时启用 `GIT_WRITE_ACTIONS_ENABLED=true` 与 `GIT_PUSH_ACTIONS_ENABLED=true`，并要求已知 branch、upstream tracking branch 和 clean worktree。
- push 正向路径已通过 disposable bare remote 自动验证：`npm run verify:git-push-disposable`。

任务：

- Host Bridge 实现 Git adapter。（已完成最小版）
- 支持 `git status --porcelain`。（已完成）
- 支持 file diff summary。（已完成最小 diff stat）
- 支持 file-level diff。（已完成 compact preview）
- 支持生成 commit message。
- 支持 commit。（已完成确认 UI、tracked/untracked 提示和显式 commit strategy；执行仍 gated）
- 支持 push。（已完成确认 UI 和 host policy；执行仍 gated）
- Android 实现 Git status 页面。（已完成紧凑面板）
- Android 实现 diff review 页面。（已完成 Git 面板内 compact preview；后续可拆成完整页面）
- Android 实现 commit/push confirmation flow。（已完成 commit 和 push confirmation）

验收标准：

- 手机能看到 changed files。
- 手机能打开单个文件 diff。
- 手机能让 Codex 根据 diff 生成 commit message。
- 手机能编辑 commit message 并提交。
- 手机能在二次确认后 push。
- 高风险 Git 命令被 host policy 拦截。

暂缓：

- hunk-level stage。
- merge/rebase conflict 处理。
- force push。
- 多 remote 管理。

## 8. Milestone 6: Hardening

目标：把原型变成个人可长期使用的工具。

任务：

- 完善 host policy。
- 增加 dangerous command classifier。
- 增加 token rotation。
- 增加 relay audit log 查询。
- 增加 event redaction。
- 增加 Android offline/poor network 状态处理。
- 增加 bridge auto-update 或版本检查。
- 增加 crash/error reporting。

验收标准：

- relay 重启后 host 和 Android 可以重连。
- Android 网络中断后不会重复发送命令。
- approval decision 有幂等保护。
- push/commit 等动作有 audit log。
- secrets 不出现在 relay event storage 中。

## 9. Milestone 7: PR and CI Extensions

目标：把 Git 收尾扩展到 GitHub PR 工作流。

任务：

- GitHub OAuth 或 host-side GitHub CLI adapter。
- 创建 PR。
- 打开 PR deep link。
- 同步 CI 状态。
- 同步 review comments。
- 触发 Codex 修复 CI failure。
- 触发 Codex 回应 review comments。

验收标准：

- 手机能从 session 创建 PR。
- 手机能看到 PR CI 状态。
- CI 失败时能让 Codex 继续修复。
- review comment 能转成 Codex task。

## 10. Initial Repository Structure

建议后续代码结构：

```text
.
├── android/
│   └── app/
├── bridge/
│   └── host-bridge/
├── relay/
│   └── service/
├── packages/
│   ├── protocol/
│   └── shared/
├── docs/
│   ├── architecture.md
│   └── implementation-plan.md
└── codex-mobile-android-analysis.md
```

说明：

- `packages/protocol` 放事件 schema、API types 和 shared contract。
- `bridge/host-bridge` 只负责 host-side adapter 和本机策略。
- `relay/service` 只负责 routing、metadata 和 notification。
- `android/app` 只负责移动端 UI 和本地状态。

## 11. Early Technical Choices

建议默认选择：

- Android: Kotlin + Jetpack Compose。
- Relay: TypeScript + Node.js + PostgreSQL + Redis。
- Host Bridge: TypeScript/Node.js，后续如果需要更强本机能力再评估 Rust。
- Protocol: JSON over WebSocket/SSE for MVP。
- Push: FCM。

这些选择的优势是开发速度快、跨端 schema 容易共享、早期调试成本低。

## 12. Definition of Done for MVP

MVP 完成应满足：

- 一台本地电脑或云端开发机可以成功配对。
- 手机可以看到该 host 上的 Codex sessions。
- 手机可以实时看到 session timeline。
- 手机可以发送 prompt。
- 手机可以批准或拒绝请求。
- 手机可以收到关键通知。
- 手机可以查看 Git status/diff。
- 手机可以 commit/push。
- 关键敏感信息不会进入 Relay 长期存储。
- 所有高风险动作都有确认和审计。
