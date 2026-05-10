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
