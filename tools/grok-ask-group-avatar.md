# 提问稿：微信群名称 / 群头像 / bot 头像的获取（Hook 层逆向）

> 技术术语保留英文，回答请用中文。

## 背景（请先理解再回答）

**项目**：微信个人号机器人。通过 LSPosed Hook 微信（Android），把收到的消息转发到云端服务器（Bridge）→ OneBot → AstrBot LLM 自动回复。Dashboard 网页管理面板显示群列表。

**链路/架构**：
```
微信(Hook, LSPosed) → Agent(平板 Android 14, 前台服务) → WebSocket → Bridge(ECS 服务器, Node.js) → Dashboard(网页)
                                                  6191                           6190
```

**现状**：
- 已实现：群聊文本消息收发（Hook 捕获 → Agent → Bridge → LLM 回复）、引用图片多模态、私聊/群聊图片接收（本地缩略图文件 → 压缩 JPEG → base64 → WS 传输，链路已闭环）
- 已验证：Hook 捕获群消息时能拿到 talker（群 ID，格式 `@@群id@chatroom`）、sender（成员 wxid）、content（群聊格式 `发送者wxid:\n正文`）、被 @ 标记（在 lvbuffer 的 msgsource `<atuserlist>` 里）
- **缺口 1（群名）**：Agent 不上报群名，Bridge 用占位「Android group」。代码证据（Bridge 侧 `apps/bridge/src/android-client.js:769`）：
  ```js
  const groupName = displayName(message.groupName || 'Android group');
  ```
  Agent 侧（`apps/android-agent/.../WechatHook.java` captureTextFields）只上报 talker/sender/content 等字段，群名完全没提取。
- **缺口 2（群头像）**：群列表前端是「方形色块 + 群名首字」占位，没有真实头像。
- **缺口 3（bot 自己的头像）**：Dashboard 上机器人自己的微信头像完全没有。

**技术锚点**（逆向/定位需要的硬信息）：
- 微信版本 **8.0.70**（TARGET_VERSION 写死，版本不匹配 Hook 直接 inactive）
- LSPosed + Zygisk，Hook 层是自研 Java 代码（WechatHook.java + Wechat8070Adapter.java）
- 已确认的入站消息存储类/路径：`com.tencent.mm.storage.y8`（消息对象）、`modelbase.p0`（addMsg 包装）、`ox0.v9`（存储分发，方法 n(y8,p0) 文本专路）、`xv0.t9`、`storage.h8`
- 消息对象字段（已实测 dump 出）：msgId/msgSvrId/type/status/isSend/createTime/talker/content/imgPath/lvbuffer/talkerId/flag 等
- 现有图片链路（已闭环）：消息 `imgPath` = `THUMBNAIL_DIRPATH://th_<32hex>` → 解析出本地文件 → 轮询等待 → 压缩 JPEG 1024px/q72 → base64 → 协议 type 7/8（私聊/群聊图片）
- 字段提取方式：反射 + 继承链遍历 dump（`for (Class<?> cls = obj.getClass(); cls != null; cls = cls.getSuperclass())`），**混淆字段名一律实测，不猜**

**已验证的约束**：
1. **微信数据库加密**（EnMicroMsg.db = SQLCipher/WCDB，key 在 native 层），**不能读库**，只能 Hook 内存对象拿数据
2. **服务器外网被墙**，头像/图片不能走公网 URL（如微信 CDN），必须用微信本地缓存文件 → base64 内嵌传输
3. Hook → Agent 走 Android Binder，**单消息 ~1MB 限制**，图片必须压缩到 <200KB
4. 现有 WS 协议 maxPayload 10MB（Bridge 侧已放宽）
5. Hook 里诊断日志过重会触发微信 ANR（实测过），任何新提取逻辑要轻量、可开关
6. 群聊消息的 talker = `@@群id@chatroom`，群名不是从消息对象 content 里能拿到的（content 只有 sender + 正文）

## Q1：字段提取 / 逆向定位（最难，请给定位方法）

**Q1.1 群名称**：微信群消息对象（y8/p0 这些）里**没有群名**的情况下，8.0.70 上正确的群名获取途径是什么？
1. 群名在哪个对象里？是群会话对象（conversation/chatroom 缓存）还是需要 hook 特定的 getter（如 `getChatroomName` / `getNickName` 的混淆版本）？
2. 群名和群 ID（`@@群id@chatroom`）的映射在哪个存储类？hook 什么方法能在**收到群消息时顺带**拿到群名（避免额外查询）？
3. 有没有可能消息对象本身带群名缓存字段（比如 y8 的某个 String 字段，只是我们之前没 dump 到）？

**Q1.2 群头像**：微信群头像在 8.0.70 上从哪里拿？
1. 群信息对象（chatroom 对象，如 `com.tencent.mm.modelmulti` 相关或 chatroom 缓存类）里头像字段长什么样？是**本地文件路径**还是 URL？
2. 微信群头像的**本地缓存文件**在哪个目录、文件名规律是什么（类似个人头像 `headImg/` 缓存目录）？能否像图片链路那样直接读本地文件？
3. hook 什么方法能拿到群头像（群信息加载方法？群详情刷新？）

**Q1.3 bot 自己的头像**：微信个人资料（self profile）对象是哪个类？头像字段 + 本地缓存文件路径规律？hook 什么方法/字段能拿到？

**Q1.4 通用**：以上三个对象在 8.0.70 上的**类名/方法名的定位方法论**——如果我们自己 dump，优先 hook 哪些入口方法（能触发这些对象加载的）？给可操作的验证路径。

## Q2：传输方案权衡

背景：头像本质是本地文件（微信缓存），Bridge/前端需要的是 base64 或可渲染的数据。

1. **方案 A**：完全复用现有图片链路——Hook 读本地头像文件 → 压缩 → base64 → 新协议 type 传输。优点：链路现成。缺点：每次群消息都读文件/压缩的开销？
2. **方案 B**：头像/群名作为「群信息」独立同步——发现新群时推一次，之后本地缓存（Bridge 侧存 base64），只有群名/头像变更时才重新推。优点：省流量。缺点：变更感知需要额外 hook。
3. **方案 C**：定时全量同步（如每次 Agent 启动 + 每 N 分钟）。优点：实现简单、自愈。缺点：浪费。
4. 你最推荐哪个？按 8.0.70 的 Hook 能力，哪个改动最小且稳？

## Q3：协议/格式问题

1. 现有协议 type 1-8（文本/图片等），群信息同步建议**新 type（如 9）还是复用现有消息通道带扩展字段**？考虑到 Bridge 的 handleGroupText 已经在处理群消息，群名/头像要不要搭群消息的便车？
2. 群头像压缩规格建议（尺寸/JPEG 质量/base64 大小上限）？Dashboard 显示需要多大？（我们现有图片链路是 1024px/q72/<200KB）
3. 头像 base64 在 Bridge/前端侧的缓存与更新策略？群名变更的感知方案？

## Q4：实现顺序 / 风险

1. **实现顺序**：群名（纯字段）→ bot 头像 → 群头像（最深层对象），这个顺序对吗？还是你有更稳的顺序？
2. **风控/性能风险**：频繁反射读微信内部对象（尤其群信息/个人资料）会不会触发微信安全机制或拖慢 Hook（我们实测过日志过重会 ANR）？有没有经验法则（如只在特定时机读、结果缓存）？
3. 有没有我们没想到的坑（头像文件读取权限、文件路径变化、多账号、hook 时机）？

## 期望输出

请按 Q1-Q4 逐块回答，给可直接落地的方案（具体类名/字段/方法/结构/注意事项）。**如果不确定 8.0.70 的具体细节，请给出定位方法（怎么验证/逆向出来），而不是猜。**
