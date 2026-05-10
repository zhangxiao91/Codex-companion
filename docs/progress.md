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

