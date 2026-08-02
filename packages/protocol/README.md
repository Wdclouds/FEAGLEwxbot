# FEAGLE Android Bridge Protocol

这里是 Android Agent 与服务器 Bridge 之间的公开协议契约，而不是运行时凭据或消息日志。

- 协议标识：`feagle.android.v1`
- JSON Schema：[`schemas/android-bridge-v1.schema.json`](./schemas/android-bridge-v1.schema.json)
- 组件兼容关系：[`compatibility.json`](./compatibility.json)
- 脱敏示例：[`examples/`](./examples/)

Agent 到 Bridge 的可靠消息使用稳定 `eventId`，Bridge 成功接纳后返回 `event_ack`；临时失败返回
`event_nack` 和有限的重试时间。Bridge 到 Agent 的发送命令使用 `commandId`，Agent 通过
`command_result` 返回结果。

协议文件不得包含设备 Token、配对码、真实微信 ID、消息正文、服务器地址或运行日志。
