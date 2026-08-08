# 任务（执行版）：微信 8.0.70 图片原图获取——你直接干活，交付可编译代码

你是这个项目的**执行工程师**，不是顾问。下面是完整项目上下文 + 已排坑清单 + 资源路径。你的交付物是**可以直接编译的 Java 代码**（Xposed hook）和**一步步的探测执行方案**，不是泛泛的方案讨论。可以查公开逆向资料（GitHub 开源微信 Xposed 模块、mmtls/微信 CDN 逆向文档、AES 解密实现），但**所有结论要以本项目实测证据为准**，并在代码里用日志标记验证。

---

## 一、项目与运行环境

- FEAGLE：个人微信机器人。三星平板 SM-X200（Android 13，root + Magisk + LSPosed）跑 Agent App（包名 `io.github.wdclouds.feaglewxbot.agent`），Agent 本身是 **Xposed 模块**（Xposed API 82，LSPosed/Vector 环境），hook 微信进程，把消息通过 WebSocket 上报阿里云服务器（国内），服务器接大模型（MiniMax M3 多模态）回复。
- 微信 **8.0.70**，**全混淆**（`pl.f2`/`y8`/`xv0.t9` 式类名），但字符串明文。
- Xposed API 82 注意：用 `XposedHelpers.getObjectField`（无 `getField`）。
- 主进程 + `:push` 进程都注入；**消息捕获在主进程**（storage-helper 路径）。
- 编译环境：Gradle（Android），JAVA 8+ 语法。代码风格参考现有 `WechatHook.java`（静态方法 + `appContext` + 后台线程 + `log()` 打日志 + `sendToAgent(Message)`）。

## 二、已跑通链路（复用，别重做）

1. hook 消息入库 → 拿 `y8` 消息对象：`field_content`（String）、`field_imgPath`（String）、`field_lvbuffer`（byte[]）、talker、createTime、msgId、msgSvrId。
2. 文本消息：content = `发送者wxid:\n正文`；群名来自 `pl.f2.field_nickname`（已缓存）。
3. 图片消息现状：`field_imgPath` = `THUMBNAIL_DIRPATH://th_<32hex>` → 解析 hash → 读本地 `/data/data/com.tencent.mm/MicroMsg/<用户目录>/image2/<前2>/<次2>/th_<hash>`（已解密 JPEG，497×340，~6.8KB）→ 压缩 base64 上报。**这就是现状，只有缩略图。**

## 三、目标

**拿到原图**（`length="38658"`，md5 `2f82350750a6c41fb6f07e15a7b60e94` 是实测那张图的原图指纹，可当验收标准）。微信默认不下载原图（点开大图才下载+解密落盘）。

## 四、实测证据（可信，别质疑；但欢迎补充解读）

1. `field_content` 是 XML：`<img aeskey="be3235a863a10f3089198a793bd443f3" encryver="1" cdnthumbaeskey="同aeskey" cdnthumburl="305f020100044b304902010002046ca1d9a602032f578b020456b92b6f02046a71f5bc042462396666326366352d333533312d343832662d393963382d306135646565623535343561020405150a02020100040d004c4dff000000000000000000" cdnthumblength="6802" cdnthumbheight="340" cdnthumbwidth="497" cdnmidimgurl="同上hex" length="38658" md5="2f82350750a6c41fb6f07e15a7b60e94" hevc_mid_size="22891" originsourcemd5="021c14f8403adb86be9ad0c65d82606b"/>`
2. `cdnthumburl`/`cdnmidimgurl` hex 解码 = **ASN.1/DER**：`30 5f 02 01 00 04 4b 30 49 02 01 00 02 04 6c a1 d9 a6 ...`，内嵌 IP `108.161.217.166` + UUID `b9ff2fcf5-3531-482f-99c8-0a5deeb5545a`。微信新版 CDN（mmtls）定位信息，非 HTTP URL。
3. 服务器 curl 该 IP 不通（mmtls 私有协议）→ 服务器直连 CDN 已死。
4. lvbuffer 335B 无 http 明文。
5. `th_` 本地文件 = 已解密 JPEG。
6. 本地 `image2/.ref/` 目录存在，内有 UUID 命名文件（如 `d/e15aadc4-d81b-4baf-862b-5bd46d826cd3`）——可能与 CDN 引用/缓存有关，**值得你分析**（可能有原图加密数据的线索）。
7. dexdump 可用（101 万行 dump 已生成）。

## 五、已排除（别浪费时间）

❌ 服务器直连 CDN（mmtls） ❌ 微信「自动下载」设置（无效） ❌ 读数据库（加密+铁律） ❌ DexKit（实测不可用） ❌ 手动点图（不可自动化）

## 六、你可以访问的资源（如果是能读本地文件的模型，直接用）

- 本地 dexdump 产物：`C:\Users\Administrator\AppData\Local\Temp\wxdex\classes.dump.txt`（101 万行，可搜类名/方法/字段；`classes10.dump.txt` 含 `pl.f2` 全字段/方法定位）、`classes.dex`、`classes10.dex`
- 平板微信 APK：`/data/local/tmp/base.apk`（255MB，root 可访问）+ 已解出的 classes*.dex（`/data/local/tmp/`，可 grep 字符串）
- Agent 源码：`C:\Users\Administrator\FEAGLEwxbot\apps\android-agent\app\src\main\java\io\github\wdclouds\feaglewxbot\agent\WechatHook.java`（726 行）、`Wechat8070Adapter.java`（509 行）——你的代码要能融进这个风格
- 平板实时状态：微信进程内可反射（但 hook 代码需编译安装后验证）
- 公开资料：GitHub 上开源的微信 Xposed 模块（图片下载/解密部分）、微信 CDN/mmtls 逆向文档、AES 解密参考实现

## 七、大胆要求——直接交付这些（按优先级）

1. **完整探测方案代码**：在 `Wechat8070Adapter.java` 的图片分支（type==3 处，`probeImageUrl` 函数位置）加一段**探测代码**（`[IMG-ORIG-PROBE]` 日志标记，后台线程），用于定位「原图下载/解密入口」。必须包含**多个探测点并行**（不要只试一个）：
   a. 遍历 `y8` 消息对象及继承链的所有字段，找**非 th_ 的路径字段**（原图/中图路径）、byte[] 字段（可能是加密原图或 CDN 描述）、含 `image2`/`orig`/`big`/`hd` 的 String；
   b. 遍历 `y8` 的方法（无参/单参 String/单参 byte[]），尝试调用，看返回是否含 CDN 信息或图片数据（日志记录方法名+返回类型）；
   c. 从 dex dump 搜图片下载相关类：搜字符串如 `cdn`、`ImageInfo`、`MMBitmap`、`decode`、`aes`、`downloadImage`、`bigImg`、`origImg` 等，列出候选类名；
   d. 检查 `.ref` 目录文件内容（Agent 有 root 吗？——Agent 进程非 root，但可以读自己目录？`.ref` 在微信目录下，Agent 作为模块在微信进程内可读，验证是否能读到 `.ref` 文件 + 内容格式）；
   e. hook 图片查看链路：如果 dex 定位到「图片查看 activity/组件」，给出 hook 它的方法签名候选。
2. **方案选型 + 正式实现代码**：根据探测结果（或你的静态分析结论），给出你推荐的**正式实现**——完整 Java 方法（可编译、风格贴合 WechatHook），包含：定位/触发 → 拿到原图 byte[] 或文件 → 压缩 → 复用现有上报链路。如果最优是「主动调用微信下载方法」，给出确切的调用方式（静态/实例、参数构造）；如果是「hook 下载方法拿 byte[]」，给出 hook 点 + 怎么把 byte[] 传回。
3. **验收标准**：每步的验证点（日志标记、文件大小 38658、md5 `2f82350750a6c41fb6f07e15a7b60e94`、JPEG magic `FF D8 FF`）。
4. **风险 + 备选**：最可能失败点 + 备选路线（比如最终退回「hook 微信大图预览下载」或「接受缩略图」的判定标准）。

## 八、硬约束

- 主进程执行；回调不阻塞（下载/IO 全后台线程）；不 ANR。
- 不读数据库；不尝试服务器直连 CDN；不把微信 Cookie/Token 外传。
- 探测代码与正式实现分开标注；代码加注释说明「探测用，验证后删除」。
- 混淆环境下：所有类/方法定位给出「怎么确认找到了」（反射实测日志），**不要假设类名存在**。
- 如果你只能输出方案不能执行：请把「执行者需要的每一步命令/代码」写到我照抄就能跑的程度。

## 九、你的回答格式

1. 一句话选型结论
2. 探测代码（完整可粘贴，含所有并行探测点）
3. 正式实现代码（完整方法体）
4. 分步执行清单（改哪、装平板、发图、看什么日志、怎么判定）
5. 风险与备选

现在就干。如果某项需要先静态分析再定，先给出静态分析命令/方法，再给基于分析的代码。
