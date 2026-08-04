# 提问稿：微信图片如何从 Android Hook 传到 OneBot/AstrBot（给 Grok）

> 用法：整段复制给 Grok。背景部分帮助它理解架构，Q1-Q4 逐块回答。
> 技术术语保留英文，回答请用中文。

## 背景（请先理解再回答）

**项目**：FEAGLEwxbot —— 自托管微信个人号 AI 机器人（GitHub: Wdclouds/FEAGLEwxbot）

**链路**：
```
微信 8.0.70 (Android 14, Rooted, Magisk + LSPosed Hook)
→ Android Agent (Java, Xposed Hook 在微信进程内)
→ WebSocket (Agent 主动连服务器 ws://<tailscale-ip>:6191/android)
→ Bridge (Node.js, 阿里云 ECS, Docker)
→ OneBot v11 (反向 WS, ws://127.0.0.1:6199/ws)
→ AstrBot (v4.26.7) → LLM (默认 DeepSeek-v4-flash 对话 + MiniMax-M3 识图)
```

**现状**：
- 文本消息全通（私聊 + 群聊）
- AstrBot 识图已配好并验证闭环：MiniMax-M3 原生多模态，直连 API 带 base64 图片能准确描述图片；AstrBot 通过 `default_image_caption_provider_id=minimax/MiniMax-M3` 路由图片消息给 M3，实测回复正确描述图片内容
- **唯一缺口：Agent 不捕获图片消息**。代码证据（`WechatHook.java:113`）：
  ```java
  if (type != 1 || isSend != 0 || content.isEmpty()) {
      return;  // type==3(图片) 在这里被丢弃
  }
  ```

**Hook 技术细节**（微信 8.0.70 混淆代码，Xposed）：
- 消息对象类：`com.tencent.mm.storage.y8`（8.0.70 混淆名，已确认）
- Hook 点：`ox0.v9.n(msg, addMsg)` 和 `xv0.t9.n(msg, addMsg)`（消息入库路径，afterHookedMethod 拿到 msg 对象）
- 现有字段提取方式：反射 getDeclaredFields + 字段名/方法名候选列表兜底（如 `"field_type"→"getType"`、`"field_talker"→"P0"/"getTalker"/"E0"/"L0"`）——即混淆名不稳定，作者用候选名列表试探
- Agent↔Bridge 协议：`AgentProtocol` 现有 6 种消息（1=注册Hook / 2=私聊文本 / 3=发文本 / 4=命令结果 / 5=通知注册 / 6=群文本），WS JSON 传输
- Bridge 侧 `android-client.js`：按 `private_text`/`group_text` case 分发 → 构造 OneBot v11 事件推 AstrBot；目前 OneBot message 段只有 text，无 CQ:image

**已验证的约束**：
1. AstrBot 能接收 base64:// 内嵌图片（已用假 OneBot client 直连 AstrBot 6199 推 `[CQ:image,file=base64://...]` 验证，MiniMax-M3 正确描述图片）
2. ECS 服务器外网被墙（访问 upload.wikimedia.org 超时 60s），图片不能走公网 URL 中转
3. Agent（三星平板 SM-X200）与服务器之间有 Tailscale（平板 100.x / 服务器 100.70.137.52），但微信图片缓存在平板本地文件系统

## Q1：8.0.70 图片消息字段提取

微信 8.0.70 Android，消息对象 `com.tencent.mm.storage.y8` 中 type==3（图片）消息：

1. 图片数据存在哪些字段？（历史版本常见候选：imgPath / path / url / thumbImgPath / cdnUrl / compressImgUrl …）
2. 8.0.70 混淆后这些字段可能叫什么？（storage 实体类字段名常被混淆成短名 a/b/c/d，怎么高效定位到图片字段？）
3. 图片消息的 content 字段是什么内容？（历史版本是空串或图片占位描述）
4. 收到图片时（isSend=0），本地缓存文件是否已下载完成？有没有"消息入库但图片还没下完"的时序问题？怎么判断图片文件已就绪（监听下载完成回调？还是入库时路径下已有文件）？

## Q2：图片二进制怎么从平板传到服务器

Agent 在微信进程内（LSPosed），拿到图片缓存路径（如 /data/user/0/com.tencent.mm/MicroMsg/.../image2/...）后：

1. 方案 A：Agent 读文件 → base64 → 走现有 WS（JSON）发 Bridge。WS 消息大小限制？微信图片一般几十~几百 KB，base64 膨胀 1.33 倍，Node.js ws / Android WS 能扛吗？要不要在 Agent 侧压缩/缩图？
2. 方案 B：Agent 起本地 HTTP 上传给 Bridge。多一条链路，值不值？
3. 方案 C：Agent 只传路径，Bridge 通过 Tailscale 直接拉平板的文件（需要 Agent 侧起文件服务）。可行吗？
4. 微信缓存目录在 Hook 进程内直接可读吗？（com.tencent.mm 进程读自己的 data 目录应无障碍？）
5. 你最推荐哪个方案？理由和取舍？

## Q3：OneBot 侧怎么构造 image 段

Bridge 拿到图片（base64 或 URL）后：

1. OneBot v11 image 段：`file=base64://<b64>` 还是 `file=http://URL`？各有什么坑？
2. AstrBot MediaResolver 对 base64:// 有没有大小限制？（我们实测 42KB 可用）
3. 要不要压缩？微信原图可能几 MB；AstrBot 有 `image_compress_enabled=true` + `max_size=1280` 配置
4. 群聊图片消息：content 格式（"发送者wxid:\n..."）对图片适用吗？MENTION_ONLY 模式下群图片要不要过滤？

## Q4：协议和实现优先级

1. AgentProtocol 加 `MSG_PRIVATE_IMAGE=7` / `MSG_GROUP_IMAGE=8`？消息体建议字段（talker/sender/base64/size/width/height/thumb…）？
2. 实现顺序建议：先私聊图片 → 再群聊图片？先收图 → 再发图？
3. 有没有我们没想到的坑（内存占用、ANR、隐私、微信风控）？

## 期望输出

请按 Q1-Q4 逐块回答，给可直接落地的方案（字段名候选、代码结构、注意事项）。**如果 8.0.70 的具体混淆名你不确定，请给出定位方法（怎么在 8.0.70 上逆向出图片字段名），而不是猜。**
