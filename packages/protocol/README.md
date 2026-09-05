# FEAGLE Android Bridge Protocol

这里是 Android Agent 与服务器 Bridge 之间的公开协议契约，而不是运行时凭据或消息日志。

- 协议标识：`feagle.android.v1`
- JSON Schema：[`schemas/android-bridge-v1.schema.json`](./schemas/android-bridge-v1.schema.json)
- 组件兼容关系：[`compatibility.json`](./compatibility.json)
- 脱敏示例：[`examples/`](./examples/)

Agent 到 Bridge 的可靠消息使用稳定 `eventId`，Bridge 成功接纳后返回 `event_ack`；临时失败返回
`event_nack` 和有限的重试时间。Bridge 到 Agent 的发送命令使用 `commandId`，Agent 通过
`command_result` 返回结果。

## 静默联系人同步（2026-08-13 新增）

Bridge → Agent 请求完整联系人快照（不发微信消息、不重连、不切换会话）：

```json
{ "type": "refresh_contacts", "commandId": "<uuid>", "includeAvatars": true }
```

Agent → Bridge 返回完整快照。`full` 标记完整性语义：**仅当 Agent 通过微信自身
ContactStorage 主动枚举 rcontact 完整成功**（存储可用、查询执行完毕、结果可信）才为
`true`；存储不可用 / 查询异常 / 结果可疑为空 / Hook 未就绪时一律 `false`——Bridge 在
`full !== true` 时只做 upsert，**禁止对 contacts 表执行物理删除**。

```json
{
  "type": "contacts_snapshot",
  "commandId": "<对应 uuid>",
  "full": true,
  "generatedAt": "<ISO 8601>",
  "groups": [{ "talker": "xxx@chatroom", "name": "群名称", "avatarBase64": "", "memberCount": 0 }],
  "privateContacts": [{ "talker": "wxid_xxx", "name": "联系人名称", "avatarBase64": "" }]
}
```

`privateContacts` = 微信通讯录（rcontact 表 `deleteFlag=0` 的个人联系人），与最近会话
（conversation 列表）是两个不同的数据集合，不混用。枚举过程不发送任何微信消息、
不切换微信会话、不重连。

失败路径复用 `command_result`（`ok: false` + `error`：`hook_not_connected` /
`contacts_sync_busy` / `invalid_command` / `sender_disconnected`）。

协议文件不得包含设备 Token、配对码、真实微信 ID、消息正文、服务器地址或运行日志。
