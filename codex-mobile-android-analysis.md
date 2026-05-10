# Codex Android 移动协作应用分析

查证日期：2026-05-10

## 1. 背景与目标

目标是开发一个 Android 优先的移动端应用，让用户在通勤、外出或不便使用电脑时，也能跟踪 Codex 任务进度、处理阻塞点、发出基本命令，并完成常见 Git 操作。它应该同时支持两类运行位置：

- 本地电脑上的 Codex：用户的仓库、工具链、凭据、MCP、本地服务仍在本机运行，手机只是远程监督与指挥入口。
- 云端服务器上的 Codex：Codex 运行在 VPS、开发机、CI runner 或团队托管环境中，手机连接到一个受控的服务端。

结论先行：这个产品不应该做成“手机里的完整 IDE”。更合理的定位是 **Codex Session Control Plane**：移动端负责观察、确认、轻量指挥、Git 审阅和告警；真正的执行仍发生在本地电脑或云端机器。

## 2. Claude Code 移动端支持现状

Claude Code 已经形成了比较清晰的移动协作闭环，主要由三类能力组成。

### 2.1 Remote Control：手机/浏览器接管本地会话

Claude Code 官方文档明确说明，Remote Control 可以让用户从手机、平板或任意浏览器继续本地 Claude Code 会话，并且支持 `claude.ai/code` 和 Claude iOS/Android 移动应用。它的关键点是：

- 会话仍在本机运行，Web/移动端只是进入该本地会话的窗口。
- 支持本地文件系统、MCP servers、工具、项目配置和文件路径自动补全。
- 多端会话同步，用户可以在 terminal、browser、phone 之间互相发送消息。
- 本地进程通过对 Anthropic API 的出站 HTTPS 连接通信，不需要在本机开放入站端口。
- 支持二维码/URL 连接移动端。
- 支持长任务完成或需要用户决策时的移动推送通知。

官方文档也列出了限制：本地进程必须保持运行；长时间网络中断可能导致会话超时；部分交互式 terminal-only 命令不能从移动/Web 端执行。

参考：[Claude Code Remote Control](https://code.claude.com/docs/en/remote-control)

### 2.2 Claude Code on the web：云端任务与移动端监控

Claude Code on the web 运行在 Anthropic 托管的云基础设施上。官方文档说明，云端 session 即使关闭浏览器也会持续存在，并且可以从 Claude 移动应用监控。其特点包括：

- 每个云端 session 在隔离的 Anthropic-managed VM 中运行。
- 代码来自 GitHub 仓库 clone。
- 可以配置环境、setup scripts、网络访问策略。
- 支持 GitHub issue/PR 相关工作。
- 支持把云端会话移动回终端，例如通过 teleport 类能力。
- 移动端可用于让 Claude 对 PR 执行 auto-fix，例如“watch this PR and fix any CI failures or review comments”。

参考：[Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)

### 2.3 移动端深链与 Code tab

Claude 移动应用支持 `claude://` URL scheme，可打开 Code tab、跳转到已有 Code session，或预填新 session composer。它也支持 universal links，例如 `https://claude.ai/code/{session-id}`。这意味着第三方入口、快捷方式和通知可以直接把用户带到移动端的具体 coding session。

参考：[Open the Claude mobile app with a link](https://support.claude.com/en/articles/14898120-open-the-claude-mobile-app-with-a-link)

### 2.4 对我们的启示

Claude 的优势不只是“有手机 App”，而是把移动端放进了 agent 生命周期：

- 启动：从手机、Web、Slack 或本地命令创建任务。
- 观察：移动端 session list、状态、进度、push notification。
- 介入：发送消息、确认权限、回答问题、调整方向。
- 迁移：本地与云端会话可以在不同表面之间移动。
- 收尾：查看结果、GitHub PR、CI/review auto-fix。

我们要做的 Codex Android 应用也应围绕 agent 生命周期设计，而不是只做一个终端转发器。

## 3. Codex 当前相关能力与空位

OpenAI Codex 当前已有不少基础能力，但它们分散在桌面、Web、CLI、IDE、GitHub、Slack 和 App Server/SDK 里。

### 3.1 已有能力

Codex Web/Cloud 可以在云端后台执行任务，支持并行，并通过 GitHub 仓库工作。官方文档描述它可以 read/edit/run code，并用云环境完成后台任务。

参考：[Codex web](https://developers.openai.com/codex/cloud)

Codex App 是桌面端重点入口，支持多项目、多线程、Local/Worktree/Cloud 模式、内置 Git diff、stage/revert、commit、push、create pull request、集成 terminal、artifact preview、IDE extension 同步、thread automation、MCP 和 web search。

参考：[Codex app features](https://developers.openai.com/codex/app/features)

Codex 已有 SSH remote connections alpha。官方文档说明，Codex App 可以添加 SSH host，并在远程文件系统和 shell 上运行 threads。这意味着“Codex 运行在服务器开发机上”已经有官方方向，但目前还是桌面 App 发起，不是 Android 原生入口。

参考：[Codex remote connections](https://developers.openai.com/codex/remote-connections)

GitHub 集成支持在 PR 评论里用 `@codex review` 请求 review，也可以启用 automatic reviews。Slack 集成支持在频道或 thread 中 `@Codex` 发起云端 coding task，完成后回帖结果和任务链接。

参考：[Codex GitHub integration](https://developers.openai.com/codex/integrations/github)、[Codex Slack integration](https://developers.openai.com/codex/integrations/slack)

OpenAI Help Center 还提到 Codex 的 workspace controls 覆盖 ChatGPT web、Atlas、ChatGPT mobile 和 Codex 等表面，并且管理员可能需要启用 Remote Control 权限，说明 OpenAI 侧已有“跨客户端控制本地 Codex 环境”的产品/权限概念。

参考：[Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540/)

### 3.2 主要空位

从 Android-first 产品角度看，当前明显空位是：

- 没有清晰的 Android 原生 Codex 控制台，能够统一展示本地电脑、远程服务器、Codex Cloud 的所有会话。
- 没有面向通勤场景优化的轻量命令入口：快速 approve、pause、continue、summarize、run tests、commit、push、PR。
- 没有移动端优先的 Git diff review 体验。
- 没有用户可控的 push notification 策略，例如“需要我确认时”“测试完成时”“PR ready 时”“任务超过 N 分钟无输出时”。
- 没有面向个人开发者的“一键把本地 Codex 暴露给手机”的桥接形态。

## 4. 产品定位

建议产品名可以暂定为 **Codex Pocket / Codex Relay / Codex Mobile Companion**。

一句话定位：**一个 Android 原生的 Codex 会话监督、轻量指挥和 Git 收尾工具，连接本地电脑或云端开发机上的 Codex。**

非目标：

- 不做完整移动 IDE。
- 不在手机本地执行复杂构建或测试。
- 不直接在手机保存长期敏感凭据。
- 不绕过 Codex/仓库权限模型执行高风险命令。

核心用户：

- 高频使用 Codex CLI/App 的个人开发者。
- 有云开发机或 homelab/VPS 的开发者。
- 想在碎片时间处理 agent 阻塞点的工程师。
- 团队中负责 review/merge/CI 修复的人。

## 5. 必备功能

### 5.1 会话总览

移动端首页应该按“运行位置 + 项目 + 状态”组织：

- Local PC：例如 `ThinkPad / desktop-4090 / office-mac`。
- Remote Server：例如 `devbox-prod / staging-runner / GPU-host`。
- Codex Cloud：从官方云端任务或自建后台同步。

每个 session 展示：

- 项目名、分支、工作目录或 repo。
- 当前状态：idle、running、waiting_for_input、waiting_for_approval、tests_running、failed、ready_for_review、completed。
- 最近一条高信号摘要。
- 运行时长、最后活动时间。
- 未处理事项数量。

### 5.2 进度同步

移动端不应该原样刷 terminal log，而应提供分层信息：

- Timeline：用户指令、Codex plan、文件修改、命令运行、测试结果、Git 动作。
- Live activity：当前正在做什么。
- Summary：Codex 自动生成的短摘要。
- Artifacts：diff、测试报告、截图、生成文件。
- Raw log：必要时展开查看 terminal 片段。

同步机制应支持：

- WebSocket/SSE 实时流。
- 断线后按 event cursor 增量恢复。
- 本地缓存最近 N 个 session 的摘要与关键事件。
- 后台 push 唤醒后快速拉取最新状态。

### 5.3 轻量命令

移动端 composer 支持自然语言 prompt，也要提供常用快捷命令：

- `继续` / `暂停` / `停止当前任务`
- `总结当前进度`
- `列出阻塞点`
- `运行测试`
- `只修复测试失败`
- `查看 diff`
- `生成 commit message`
- `提交`
- `推送`
- `创建 PR`
- `回应 review comments`
- `回滚本次 session 的修改`

为了移动场景，命令应做成按钮 + 可编辑 prompt，而不是让用户手打长命令。

### 5.4 权限确认与安全操作

Codex 需要用户确认时，手机应能处理：

- shell 命令批准/拒绝。
- 文件写入或 patch 批准/拒绝。
- 网络访问批准/拒绝。
- Git push / PR / merge 前确认。
- 高风险命令二次确认，例如删除、重置、部署、生产环境操作。

确认卡片应包含：

- Codex 想做什么。
- 为什么需要做。
- 影响范围。
- 实际命令或 diff 摘要。
- 允许一次、允许本 session、拒绝并说明原因。

### 5.5 Git 功能

Android 端最核心的 Git 功能不是全量 Git porcelain，而是 agent 工作流收尾：

- 查看 `git status`。
- 查看文件级 diff 和 hunk diff。
- 对 diff 添加评论并让 Codex 修改。
- stage/unstage 文件或 hunk。
- 生成/编辑 commit message。
- commit、push。
- 创建 PR 或打开 GitHub PR。
- 触发 Codex review 或请求修复 review comments。
- 查看 CI 状态，并让 Codex 修复失败。

移动端 diff UI 要重点优化：

- 默认按文件摘要展示。
- 大 diff 先显示 Codex 总结和风险点。
- 支持只看新增/删除/测试文件。
- 支持按 hunk 评论，而不是要求用户精确复制行号。

### 5.6 通知

通知应可配置，而不是完全由 agent 决定：

- 任务完成。
- 需要输入。
- 需要权限确认。
- 测试失败。
- 测试通过。
- PR 创建成功。
- CI 失败。
- 长时间无进展。
- Codex 判断需要人工决策。

通知深链应打开具体 session、具体 approval 或具体 diff。

### 5.7 连接管理

移动端应支持三种连接形态：

1. 本地电脑桥接
   - 桌面端或 CLI helper 启动 bridge。
   - 手机扫码配对。
   - 本机只发出站连接到 relay，不开公网端口。
   - 手机通过 relay 与本地 Codex App Server/CLI 通信。

2. 云端服务器直连
   - 用户在服务器部署 agent bridge。
   - Android 连接到用户自己的 HTTPS endpoint。
   - 可选 Tailscale/WireGuard/VPN/LAN 模式。

3. 官方 Codex Cloud/GitHub/Slack 辅助入口
   - 对官方可用接口做深链或集成。
   - GitHub/Slack 用于补充任务触发与 PR 状态，不把它们当作唯一控制通道。

## 6. 推荐实现形态

### 6.1 总体架构

推荐采用四层架构：

- Android App：Kotlin + Jetpack Compose，负责 UI、通知、离线缓存、设备密钥、深链。
- Relay Service：云端中继，只做身份验证、会话路由、WebSocket/SSE 转发、push fanout。
- Host Bridge：运行在本地电脑或云端服务器，连接 Codex App Server/CLI/SDK，采集事件并执行用户指令。
- Codex Runtime：现有 Codex CLI/App/App Server/SDK、Git、shell、仓库。

数据流：

1. Host Bridge 与 Relay 建立出站 TLS 长连接。
2. Android 登录后订阅用户有权限的 hosts/sessions。
3. Host Bridge 把 Codex thread events、terminal events、approval requests、Git status 发给 Relay。
4. Android 发送 prompt/approval/git action 到 Relay。
5. Relay 路由给对应 Host Bridge。
6. Host Bridge 调用 Codex 或 Git 执行，并回传结果。

这套形态接近 Claude Remote Control 的安全优点：用户本机无需开放入站端口，移动端不直接拿本机 SSH key。

### 6.2 Host Bridge

Host Bridge 是成败关键，应尽量薄，但要强约束权限。

职责：

- 启动或连接 Codex App Server。
- 列出 projects、threads、worktrees。
- 订阅 thread event stream。
- 接收用户 prompt 和 approval。
- 执行受控 Git 操作。
- 读取必要 terminal 输出。
- 上报 host 心跳和版本。

接口建议：

- 首选：使用 Codex App Server/SDK。如果 API 覆盖足够，这是最稳的方式。
- 备选：CLI wrapper + PTY + 结构化日志解析。只适合 MVP，不宜长期依赖。
- 云端模式：Host Bridge 可以作为 systemd service 或 Docker container 运行。

### 6.3 Relay Service

Relay Service 不应拥有代码仓库内容的长期副本，也不应存储完整 terminal log。它更像 session router。

职责：

- 用户认证。
- 设备配对。
- host registry。
- session routing。
- event cursor。
- push notification。
- 短期缓存 session 摘要。
- audit log。

不建议在 Relay 保存：

- 仓库源码。
- 私钥、GitHub token、OpenAI token。
- 全量 terminal 输出。
- 未脱敏环境变量。

### 6.4 Android App

Android 技术栈建议：

- Kotlin。
- Jetpack Compose。
- Room 存储本地 session 摘要与事件 cursor。
- WorkManager 处理后台同步。
- Firebase Cloud Messaging 或自建推送网关处理通知。
- Android Keystore 保存设备密钥和 refresh token。
- OkHttp WebSocket/SSE。

主要页面：

- Host 列表。
- Session 列表。
- Session 详情。
- Approval Inbox。
- Diff Review。
- Git Actions。
- Settings / Security。

移动端 UI 原则：

- 信息密度高，但不模拟 desktop。
- 优先展示“我现在需要做什么”。
- 把危险动作集中到明确的 confirmation flow。
- 所有长文本都可以一键总结。
- 所有命令都允许用户发送前编辑。

## 7. MVP 范围

建议 MVP 只做一条主链路：**Android App + Local/Server Host Bridge + Relay + Codex CLI/App Server**。

MVP 必须包含：

- 扫码配对本地电脑或服务器。
- 展示 hosts 和 active sessions。
- 展示 session timeline、当前状态、最近摘要。
- 手机发送 prompt 到现有 session。
- 处理 approval request。
- 任务完成/需要确认 push notification。
- 查看 `git status`。
- 查看 diff 摘要和文件 diff。
- commit/push 前确认。

MVP 可以暂缓：

- 完整 PR 创建 UI。
- 多人团队权限。
- hunk-level stage。
- 云端 Codex 官方任务的深度集成。
- 复杂 artifact preview。
- 语音输入。
- 自动 CI 修复。

## 8. 版本路线

### V0：技术验证

- 在本机启动 Codex session。
- Host Bridge 能捕获状态和输出。
- Android 能看到 session 并发送一条 prompt。
- 手机能批准一个简单操作。

### V1：个人可用

- 本地/服务器 host 管理。
- 会话列表与实时进度。
- push notification。
- 基本 Git diff、commit、push。
- 安全确认与 audit log。

### V2：GitHub/PR 工作流

- GitHub OAuth。
- PR 创建与查看。
- CI 状态同步。
- review comments 修复。
- Codex review 触发。

### V3：团队与云

- 多用户、多 host 权限。
- 组织策略。
- session sharing。
- relay 自托管版本。
- 与 Codex Cloud 官方接口更深集成。

## 9. 关键风险

### 9.1 Codex 内部接口稳定性

如果依赖 CLI 输出解析，版本升级会很脆。应优先使用官方 App Server/SDK，并把 Host Bridge 做成可适配多版本的 adapter。

### 9.2 安全边界

移动端批准 shell 命令和 Git push 风险高。必须有：

- 明确权限分级。
- 高风险命令二次确认。
- host 端策略文件。
- 可审计日志。
- 默认 deny 的危险命令列表。

### 9.3 移动端误操作

通勤场景容易误触。危险操作需要延迟确认、长按确认或要求用户输入分支名/PR 名。

### 9.4 后台保活与通知

Android 后台限制严格，不能依赖 App 常驻 WebSocket。应采用 FCM push 唤醒 + 前台打开后恢复 event cursor。

### 9.5 官方产品变化

OpenAI 可能推出官方 Android Codex 入口或完整 Remote Control。我们的应用应避免与官方客户端正面重复，重点保持：

- 自托管/私有 relay。
- 多后端统一。
- 更强 Git review。
- 更细通知策略。
- 对云端开发机/VPS 的支持。

## 10. 建议的差异化

与 Claude Code 移动支持相比，我们可以做得更“工程控制台”：

- 同时管理本地电脑和多台云端开发机。
- 通知策略由用户配置，而不是完全由 agent 判断。
- Git diff review 做成移动端一等功能。
- 支持自托管 relay，适合隐私敏感用户。
- 支持跨工具：未来可接 Codex、Claude Code、opencode、Aider 等 agent，但首期聚焦 Codex。

## 11. 初步技术任务拆分

1. 调研 Codex App Server/SDK 可用事件与命令覆盖面。
2. 实现 Host Bridge 原型：list sessions、stream events、send prompt、approve/deny。
3. 实现 Relay 原型：device pairing、WebSocket routing、event cursor。
4. 实现 Android 原型：host list、session timeline、composer、approval card。
5. 加入 Git adapter：status、diff summary、commit、push。
6. 做安全策略：danger command classifier、host policy、audit log。
7. 做通知：FCM、deep link、notification categories。

## 12. 推荐产品决策

建议先做 **“本地/云端开发机 Codex Remote Companion”**，不要一开始试图完整复制 Codex Web 或 GitHub/Slack。

第一版成功标准：

- 用户在电脑上启动 Codex 后，可以放心离开座位。
- 手机能及时通知“需要你确认”或“任务完成”。
- 用户能在手机上看懂 Codex 正在做什么。
- 用户能用少量点击让 Codex 继续、修正方向、跑测试、提交或推送。
- 整个链路不要求用户暴露本机公网端口或把 SSH/Git token 放进手机。

这是最接近真实痛点、也最容易形成可靠 MVP 的方向。
