# Manual App Server Approval Test

本文用于手测真实 Codex App Server approval request 是否能到达 Android，并由 Android decision 回写到 App Server。

## 目标

- 使用真实 `CODEX_ADAPTER=app-server`。
- 使用 `CODEX_APPROVAL_POLICY=on-request`。
- 触发一个只读命令请求：`node --version`。
- Android 显示 `Needs attention` approval card。
- 在 Android 点击 Approve 或 Deny。
- Bridge 将 decision 写回 App Server，并产生 `approval_resolved` timeline event。

## 启动

在仓库根目录运行：

```powershell
npm run manual:app-server-approval
```

脚本会：

- 启动 Relay，默认端口 `8810`。
- 启动真实 App Server Bridge，默认 App Server 端口 `8811`。
- 自动生成 pairing token。
- 打印 Android 应填写的 Relay URL 和 Pairing token。
- 创建一个 ephemeral thread，并请求 Codex 运行 `node --version`。

可选环境变量：

```powershell
$env:MANUAL_RELAY_PORT='8810'
$env:MANUAL_APP_SERVER_PORT='8811'
$env:RELAY_DEV_TOKEN='your-manual-token'
$env:CODEX_APPROVAL_POLICY='on-request'
npm run manual:app-server-approval
```

## Android 操作

1. 打开 App。
2. Relay URL 填脚本输出的地址：
   - 模拟器通常是 `ws://10.0.2.2:8810`
   - 真机使用脚本输出的 `ws://<电脑局域网 IP>:8810`
3. Pairing token 填脚本输出的 token。
4. 点击 `Save`。
5. 点击 `Pair`，确认显示 `Paired device ...`。
6. 点击 `Test`，确认显示 `health ok`。
7. 点击 `Connect/Refresh`。
8. 等待 `Needs attention` 卡片出现。
9. 点击 `Approve` 或 `Deny`。

## 预期结果

电脑端日志应出现：

```text
[bridge] app-server approval requested: item/commandExecution/requestApproval ...
[relay] approval requested: ...
[relay] routing approval decision to host ...
[bridge] received approval decision for ...
[relay] timeline event: Approval resolved
```

Android timeline 应出现 `Approval resolved` 或后续 assistant/turn completion event。

## 当前限制

- 这是手测流程，不是 CI 自动验证；它依赖真实 Codex 模型是否按 prompt 触发命令。
- 如果 Codex 直接回答而没有请求执行命令，可能不会出现 approval card。可以重跑并把 prompt 改得更明确。
- 如果真机连不上 Relay，优先检查 Windows 防火墙、电脑和手机是否在同一局域网、Relay 是否监听 `0.0.0.0`。
- approval token 和 device token 仍是开发期机制，不适合公网暴露。
