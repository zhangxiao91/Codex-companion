# Codex API Coverage Matrix

查证日期：2026-05-10

本文记录 Host Bridge 接入真实 Codex Runtime 的可行性。结论基于本机 Codex CLI 探测和官方 OpenAI Codex 文档。

## 1. Environment Findings

本机发现两个 Codex CLI 入口：

- WindowsApps app alias：`C:\Program Files\WindowsApps\OpenAI.Codex_26.506.3741.0_x64__2p2nqsd0c76g0\app\resources\codex.exe`
- VS Code 扩展内置 CLI：`C:\Users\13372\.vscode\extensions\openai.chatgpt-26.506.21252-win32-x64\bin\windows-x86_64\codex.exe`

探测结果：

- WindowsApps app alias 执行 `codex --help` 和 `codex --version` 时返回 `Access is denied`。
- VS Code 扩展内置 CLI 可执行，版本为 `codex-cli 0.129.0-alpha.15`。
- VS Code 扩展内置 CLI 暴露了这些关键命令：
  - `codex app-server`
  - `codex app-server generate-ts`
  - `codex app-server generate-json-schema`
  - `codex app-server proxy`
  - `codex exec --json`
  - `codex exec-server`
  - `codex mcp-server`

## 2. Adapter Options

### Option A: Codex App Server Adapter

状态：首选，loopback 连接和 `thread/list` 已验证。

原因：

- CLI 自带 `app-server generate-ts` 和 `generate-json-schema`，可以生成协议绑定。
- App Server 协议覆盖 thread list/read/start、turn start/steer、plan/diff/status notifications、approval requests 等核心能力。
- CLI 支持 `--listen ws://IP:PORT`，理论上可由 Host Bridge 启动并通过 WebSocket 连接。

风险：

- 命令标记为 experimental。
- app-server 实际启动、JSON-RPC `initialize` 和 `thread/list` 已验证；后续还需要验证 `thread/read`、`turn/start`、`turn/steer` 和 approval request resolution。
- 生成协议很大，Host Bridge 需要只封装最小子集，避免被内部 API 变化拖垮。

### Option B: Codex Exec JSON Adapter

状态：可作为非交互 fallback。

原因：

- `codex exec --json` 可以输出事件 JSONL。
- 适合启动一次性任务，或让手机触发“运行一个新 prompt 并看结果”。

限制：

- 不适合接管现有 interactive session。
- approval、turn steering、thread list/read 能力不如 App Server 直接。
- 更像 batch task runner，而不是移动端 session control plane。

### Option C: CLI TUI/PTY Adapter

状态：不建议，除非 App Server 完全不可用。

原因：

- 可以理论上用 PTY 包裹 `codex` 交互式 CLI。

限制：

- 解析终端 UI 脆弱。
- 处理 approval 和状态同步困难。
- 不适合作为长期架构。

## 3. Capability Matrix

| Capability | App Server | Exec JSON | PTY Wrapper | Notes |
| --- | --- | --- | --- | --- |
| list sessions | covered | not covered | weak | App Server has `thread/list` and `thread/loaded/list`. |
| read session | covered | not covered | weak | App Server has `thread/read` and `thread/turns/list`. |
| start session | covered | covered for batch | possible | App Server has `thread/start`; exec can start non-interactive task. |
| send prompt to existing session | covered | limited | possible | App Server has `turn/start` and `turn/steer`. |
| stream status/events | covered | covered for batch | weak | App Server has server notifications for thread/turn/item events. |
| plan updates | covered | likely event-only | weak | App Server has `turn/plan/updated`. |
| diff updates | covered | likely event-only | weak | App Server has `turn/diff/updated`. |
| command output | covered | covered | weak | App Server has command/process output notifications. |
| shell approval | covered | uncertain | weak | App Server has `item/commandExecution/requestApproval`. |
| file-change approval | covered | uncertain | weak | App Server has `item/fileChange/requestApproval`. |
| user-input request | covered | uncertain | weak | App Server has `item/tool/requestUserInput`. |
| Git diff to remote | covered | possible via shell | possible | Root ClientRequest includes `gitDiffToRemote`; local Git adapter still recommended. |
| direct Git commit/push | use Host Git adapter | possible via shell | possible | Safer to keep commit/push in Host Bridge policy layer. |

## 4. Relevant App Server Protocol Surface

Generated from:

```powershell
codex app-server generate-ts --experimental --out <temp-dir>
codex app-server generate-json-schema --experimental --out <temp-dir>
```

Key client requests:

- `thread/list`
- `thread/loaded/list`
- `thread/read`
- `thread/start`
- `thread/resume`
- `thread/fork`
- `thread/rollback`
- `thread/unsubscribe`
- `turn/start`
- `turn/steer`
- `turn/interrupt`
- `thread/turns/list`
- `thread/shellCommand`
- `review/start`
- `gitDiffToRemote`

Key server notifications:

- `thread/started`
- `thread/status/changed`
- `thread/closed`
- `turn/started`
- `turn/completed`
- `turn/plan/updated`
- `turn/diff/updated`
- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- `item/commandExecution/outputDelta`
- `item/fileChange/outputDelta`
- `item/fileChange/patchUpdated`
- `remoteControl/status/changed`

Key server requests:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/tool/requestUserInput`
- `item/permissions/requestApproval`
- `applyPatchApproval`
- `execCommandApproval`

## 5. Recommended Decision

Use **App Server Adapter** as the primary real Codex adapter.

Implementation direction:

1. Keep current `MockCodexAdapter` for deterministic tests.
2. Add `AppServerCodexAdapter` behind the same Host Bridge interface.
3. Start with read-only operations:
   - launch/connect app-server
   - initialize
   - `thread/list`
   - `thread/read`
4. Then add write/interactive operations:
   - `turn/start`
   - `turn/steer`
   - map server notifications to mobile timeline events
5. Then add approval handling:
   - map server requests to mobile approval cards
   - send server request resolution back through App Server

Do not expose `thread/shellCommand` to Android in early builds because the generated protocol notes that it runs unsandboxed with full access.

## 6. Next Verification Step

Connection spike completed with:

```powershell
npm run probe:codex-app-server
```

Verified:

- Host Bridge can launch VS Code extension Codex CLI with `app-server --listen ws://127.0.0.1:<port>`.
- Node WebSocket client can connect to the app-server.
- `initialize` returns user agent, Codex home and platform details.
- Server emits `remoteControl/status/changed`.
- `thread/list` returns existing Codex threads.

Next step:

1. `AppServerCodexAdapter` read-only mode is implemented.
2. `thread/list` response is mapped to the Host Bridge `session.snapshot` shape.
3. `MockCodexAdapter` remains the default adapter for deterministic tests.
4. `CODEX_ADAPTER=app-server` enables the real App Server adapter.
5. `npm run verify:app-server-readonly` verifies Relay + Host Bridge + App Server session listing.

Next implementation target:

1. `thread/read` support for selected session details is implemented.
2. Historical turns/items are mapped into mobile timeline events through `session.timeline.request`.
3. Next: map live App Server notifications into incremental timeline events.
4. Next: add `turn/start` or `turn/steer` only after live timeline mapping is stable.
