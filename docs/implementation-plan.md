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
- 当前机器未检测到 Android 工具链，Android MVP Shell 暂缓到 Java/Gradle/Android SDK 可用后执行。
- WindowsApps app alias 的 `codex --help` 和 `codex --version` 返回 `Access is denied`；VS Code 扩展内置 Codex CLI 可执行，版本为 `codex-cli 0.129.0-alpha.15`。
- App Server 协议覆盖初判和 loopback 连接验证已完成；`initialize` 与 `thread/list` 可用，首选真实 adapter 是 App Server Adapter，详见 `docs/codex-api-coverage.md`。
- `AppServerCodexAdapter` 只读 MVP 已完成，可通过 `CODEX_ADAPTER=app-server` 启用，并已验证能通过 Relay 发布真实 Codex threads。
- `thread/read` timeline MVP 已完成，真实 thread turns/items 可通过 `session.timeline.request` 映射为移动端 timeline events。
- App Server live notifications 已映射为增量 timeline events，但还未通过真实 `turn/start` 长任务做端到端验证。
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
- 实现 event cursor。
- 实现短期 event cache。
- 实现 audit log。
- 实现 push notification stub。

验收标准：

- Host Bridge 可以通过出站连接连到 Relay。
- Android/test client 可以订阅 host sessions。
- 断线重连后可以通过 cursor 拉取漏掉的事件。
- Relay 不存储源码和未脱敏 terminal log。

## 5. Milestone 3: Android MVP Shell

目标：做出 Android 端的基本信息流体验。

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

任务：

- Host Bridge 实现 Git adapter。
- 支持 `git status --porcelain`。
- 支持 file diff summary。
- 支持 file-level diff。
- 支持生成 commit message。
- 支持 commit。
- 支持 push。
- Android 实现 Git status 页面。
- Android 实现 diff review 页面。
- Android 实现 commit/push confirmation flow。

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
