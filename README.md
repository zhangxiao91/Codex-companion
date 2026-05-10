# Codex Mobile Companion

Codex Mobile Companion 是一个 Android 优先的 Codex 移动协作入口。它不是手机 IDE，而是一个面向通勤、外出和碎片时间的 **信息流转窗口**：用户可以在手机上查看 Codex 会话进度、处理阻塞点、批准操作、发送轻量命令，并完成常见 Git 收尾动作。

项目初期聚焦 Android 平台，支持连接两类运行环境：

- 本地电脑上的 Codex：代码、工具链、凭据和本地服务仍在电脑上，手机通过安全桥接查看和控制会话。
- 云端开发机上的 Codex：Codex 运行在 VPS、开发机、CI runner 或团队服务器上，手机连接受控的服务端入口。

## Product Positioning

一句话定位：

> Android-native control plane for Codex sessions.

核心原则：

- 手机端负责观察、确认、轻量指挥、Git 审阅和通知。
- 实际代码执行、构建、测试和文件访问发生在本地电脑或云端开发机。
- 不在手机上保存长期敏感凭据。
- 不把移动端做成完整 IDE。
- 不要求用户把本地电脑暴露到公网。

## Core Scenarios

- 离开电脑后继续跟踪 Codex 当前在做什么。
- 收到“需要确认/任务完成/测试失败/PR ready”等通知。
- 在手机上批准或拒绝 Codex 请求的 shell、文件、网络或 Git 操作。
- 发送简短指令，例如“继续”“总结进度”“只修复测试失败”“运行测试”“准备提交”。
- 查看 Git status、diff 摘要、文件 diff，并执行 commit/push。
- 同时管理本地电脑和云端开发机上的多个 Codex session。

## Planned Architecture

项目采用四层结构：

- Android App：Kotlin + Jetpack Compose，负责移动端 UI、通知、离线缓存、设备密钥和深链。
- Relay Service：云端或自托管中继，负责认证、配对、会话路由、事件游标、WebSocket/SSE 转发和推送通知。
- Host Bridge：运行在本地电脑或云端开发机，连接 Codex CLI/App Server/SDK，采集事件并执行受控命令。
- Codex Runtime：现有 Codex、Git、shell、仓库、测试工具和本地开发环境。

详细设计见 [docs/architecture.md](docs/architecture.md)。

## MVP Scope

第一版只做一条闭环：

1. 用户在本地电脑或云端开发机启动 Host Bridge。
2. Android App 扫码或通过配对码绑定 host。
3. 手机能看到 active sessions、状态、timeline 和最近摘要。
4. 手机能发送 prompt 到现有 session。
5. 手机能处理 approval request。
6. 手机能接收需要确认和任务完成通知。
7. 手机能查看 Git status/diff，并在确认后 commit/push。

不在 MVP 中处理：

- 完整移动 IDE。
- 手机本地执行构建或测试。
- 多人团队权限。
- 复杂 PR 管理。
- 完整 Codex Cloud 深度集成。
- hunk-level stage。

## Repository Documents

- [codex-mobile-android-analysis.md](codex-mobile-android-analysis.md)：竞品调研、产品定位和总体分析。
- [docs/architecture.md](docs/architecture.md)：系统架构、组件职责、协议边界和安全模型。
- [docs/implementation-plan.md](docs/implementation-plan.md)：分阶段施工计划、里程碑和验收标准。
- [docs/android-toolchain.md](docs/android-toolchain.md)：Android 构建工具链安装和验证说明。

## Current Status

当前仓库已完成 Node 原型主链路验证，并已创建 Android MVP Shell 骨架。

已验证：

- 最小 Relay、Host Bridge、MockCodexAdapter 和测试客户端。
- Codex App Server adapter 的 `thread/list`、`thread/read`、`turn/start`、`turn/steer`。
- App Server live notifications 到移动端 timeline events 的映射。
- 专用 ephemeral test thread，避免污染真实历史会话。
- prompt 后等待真实 `assistant_delta` 或 `turn_completed`。
- Relay 内存 timeline cache 和 `after_cursor` 补发。

Android 骨架位于 [android/](android/)，使用 Kotlin + Jetpack Compose。当前机器已安装命令行 Android SDK，并已通过 `.\gradlew.bat :app:assembleDebug`。工具链说明见 [docs/android-toolchain.md](docs/android-toolchain.md)。

常用验证命令：

```powershell
npm run verify:delivery-strategy
npm run verify:relay-timeline-cache
npm run verify:app-server-prompt
npm run check:android-toolchain
```
