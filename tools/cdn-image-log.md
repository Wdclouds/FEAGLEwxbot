# FEAGLE 微信机器人「CDN 识图」原图链路攻坚日志

> 日期：2026-08-08（一下午） · 作者：Hermes Agent（协调）+ Grok/Codex（咨询）
> 用途：**给 Codex 彻底接管此部分的交接文档**——先看项目代码，再看本文档，然后实施方案 B（跨进程压缩）。
> 版本：当前已部署 commit `2da9ff6`（原图链路主体）+ `4fd466c`（Codex 分析报告归档）

---

## 一、项目背景

**FEAGLEwxbot**：微信个人号机器人（`FaSt_eAgle`，小号），Android 微信 8.0.70（全混淆）+ Xposed/LSPosed 模块（`apps/android-agent`）→ 消息捕获 → Binder 转发到 Bridge 服务 → 服务器 AstrBot（DeepSeek/MiniMax 多模态）→ 群聊应答。

**需求**：图片消息到达时，**自动获取原图**（不依赖用户点开），压缩后喂给 MiniMax 看图（多模态识别）。

**双路方案**：
- **浅路（已完成）**：微信本地缩略图（497×340）→ 压缩 base64 → MiniMax——日常够用，小字/细节糊。
- **深路（本日志主题）**：hook 微信内部 CDN 下载，拿更高规格图片 → 完整原图。

---

## 二、系统架构（当前实现）

```
图片消息到达
  → captureMessage hook（storage-helper + arg0 双路径）
    → 分支启动后台线程 feagle-orig（非 daemon）
      → fetchOriginalImage：CdnManager.OnJniStartC2CDownload 主动下载原图
        （request 构造：adownimg_<固定hash>_<ts>_1_hevc + fileType=2
         + customHeader(source_format:1/msgid/source_filesize:0)
         + fileid=buildFileId(模板 DER 改时间戳/规格码)）
      → pollOriginalFile：轮询落盘文件（>10KB 即用，8s 超时）
      → 检测文件头 "wxgf"（微信 HEVC 私有图片格式）
        → decodeWxgfToBitmap：MMWXGFJNI buffer API 解码（串行化锁保护）
          → Bitmap.copy(ARGB_8888)（nativeUninit 会释放 native 像素）
        → captureImageFromBitmap：320px JPEG q60 写临时文件 → base64
          → Binder 协议 7/8 上报（orig=wxgf）
      → 失败任意环节：缩略图兜底（不阻塞消息）
```

---

## 三、完整历程（阶段化）

### 阶段 0：问题定位（~14:40 前）
- 缩略图方案可用但糊 → 用户要求原图必须跑通。
- 深路探测：CDN 服务器直连（mmtls 加密）证伪；锁定 hook 微信进程内 `CdnManager`。

### 阶段 1：-20003 系列（request 构造，14:45–15:27）
**症状**：主动调用 `OnJniStartC2CDownload` 返回 -20003（请求构造不合法）。
**三层根因（全部实测）**：
1. 手工 `new` 缺默认值：`apptype=-1`（应为 0）、`supportFormats` 空（应为 `int[1,2]`）。
2. **`setStringField` 用 `getField` 只找 public 字段** → savePath（private）静默失败 → 改 `getDeclaredFields + setAccessible`（findField）。
3. 我们自己的调用污染 dump（hook 捕获自己的 request）→ hook 跳过 `feagle-orig` 线程。
**成果**：start=0（下载被接受）。

### 阶段 2：下载规格之谜（15:27–16:24）
**症状**：start=0 但只拿到 ~4KB（缩略图规格）。
**关键实验**：
- poll 抓到半成品（mars 边写边落盘）→ 完整性校验。
- `source_format:2` 无效；手动构造 DER 无效。
- **写文件 dump（非 logcat）抓微信真实 request**（logcat ~4KB 单行截断）。
- 💎 **决定性发现**：微信缩略图与原图下载用**同一个 fileid（DER）**——**规格完全由 request 字段决定**。
- 💎 **微信原图 request 金矿**：`fileKey=adownimg_<hash>_<ts>_<seq>_hevc`、`fileType=2`、`customHeader=source_format:1+msgid+source_filesize:0`。
**成果**：照抄微信构造 → 80KB 中档图（12 倍于缩略图）。

### 阶段 3：固定 hash 突破（16:24–16:34）
- 💎 **hash 是固定的 `cf8f8e41a49c1185`**（两次不同图、不同时间相同）——**CDN 会话标识**，非图资源 ID！随机 hash 只返回 8-80KB 部分数据。
- 用固定 hash → 稳定拿到 ~59-75KB wxgf 文件（HEVC 压缩的原图数据）。
- poll 阈值：10% 对大图过苛 → 超时后 >10KB 即用。

### 阶段 4：wxgf 格式破解（16:34–17:00）
- 💎 **wxgf = 微信 HEVC 私有图片格式**（文件头 `wxgf`）——微信用 HEVC 视频编码存静态图，BitmapFactory 无法解码。
- 定位解码器 `com.tencent.mm.plugin.gif.MMWXGFJNI`（JNI 反射 dump 签名）。
- **buffer API 调用链**：
  ```
  nativeInitWxAMDecoder() → long handle
  nativeDecodeBufferHeader(handle, data, len) → rc=0
  nativeGetOption(handle, data, len, int[16]) → rc=0, opts=[1,宽,高,...]（[1]=宽 [2]=高）
  Bitmap.createBitmap(w, h, ARGB_8888)
  nativeDecodeBufferFrame(handle, data, len, bmp, int[4]) → rc=0（解码到 Bitmap）
  nativeUninit(handle)
  ```
- `nativeAV2Gif` 是视频转 GIF（对静态图 rc=0 无输出）——弃用。
- **坑**：`nativeUninit` 释放 Bitmap 的 native 像素（copy 后仍坏引用）→ **必须先 `copy(ARGB_8888)` 再返回**。
- 💎 **解码成功**：`frame rc=0 bmp=2744x1280`——**完整原图分辨率**！

### 阶段 5：压缩卡死攻坚战（17:00–18:54，最漫长）
**症状**：解码成功（copy 后），但 `compress` 随机静默挂起（~43% 成功率）——线程不返回、无异常、XposedBridge.log 全失效。

**排查历程**（每步都实测）：
| 尝试 | 结果 |
|---|---|
| daemon worker 线程 | 饿死（start 日志不打） |
| 非 daemon / 完全同步 | 随机挂起依旧 |
| JPEG 640/1024px、PNG | 随机挂起依旧 |
| 文件日志（绕 log 失效）| ENTER 首行定位：有时卡在 bitmap.getWidth() |
| 宽高参数传入（零 bitmap 读取）| 部分改善，仍随机失败 |
| 去掉 recycle（连带释放 safe）| 部分改善，仍随机失败 |
| decoder 会话串行化（Codex 建议）| 仍随机失败 |

**Codex 诊断**（`tools/codex-compress-report.md`）：根因大概率是 **WXGF JNI 解码器破坏了微信进程的 native 状态**（像素锁未释放/越界写/堆破坏）——decode 之后的 `createScaledBitmap/compress` 只是「受害者」（Skia 锁等待）。**在微信进程内做任何 Bitmap 操作都不可靠**。

**收尾决策（用户拍板）**：方案 A 接受现状——成功时高清原图（~43%），失败自动缩略图兜底（不阻塞消息）。已 commit + 部署。

---

## 四、已验证事实（Codex 无需重新验证）

1. **CDN request 构造**（微信原图下载实测 dump 金矿）：
   - `fileKey = adownimg_cf8f8e41a49c1185_<unix秒>_<seq>_hevc`（**hash 固定**）
   - `fileType = 2`；`apptype = 0`；`supportFormats = int[1,2]`
   - `customHeader = source_format:1\r\nmsgid:<svrid>\r\nsource_filesize:0`
   - `savePath` 必须能写（findField+setAccessible）
2. **fileid（DER）**：CDN 只定位资源，不决定规格（缩略图/原图同一 DER）。XML 模板 DER + 新时间戳 + 规格码 152a + 尾部 4c4e63 可被接受（buildFileId 构造）。DER 结构：`30 5f` SEQUENCE → IPv4 → 业务码 2f578b → int A（会话）→ 时间戳（Unix 秒大端）→ UUID（36 ASCII）→ 规格码（152a）→ 尾部（4c4e63）。
3. **wxgf 解码**：MMWXGFJNI buffer API（见阶段 4）。宽高 = opts[1]/opts[2]。copy 防 nativeUninit 释放。全程零 bitmap 读取（getWidth 偶发挂起）。
4. **compress 挂起**：微信进程内不可靠（~43% 随机），原因见 Codex 报告。

---

## 五、当前代码状态

| 文件 | 关键内容 |
|---|---|
| `apps/android-agent/.../agent/Wechat8070Adapter.java` | `fetchOriginalImage`（adownimg 构造+固定 hash）、`pollOriginalFile`（>10KB 兜底）、`decodeWxgfToBitmap`（串行化+buffer API+copy）、`buildFileId`、`ensureCdnHookEarly`、`writeDumpFile`/`dumpLog` 分段、`findField`(setAccessible)、图片分支后台线程 |
| `apps/android-agent/.../agent/WechatHook.java` | `captureImageFromBitmap`（320px q60 写文件+零 bitmap 访问+dedupEvent 短锁）、`captureImageFromFile`（缩略图兜底 orig=1）、`appContext()` |

**构建/安装**（Windows + 平板 SM-X200 adb `R8YW40TQ64R`）：
```
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File feagle.ps1 android build-agent
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File feagle.ps1 android install-agent -ConfirmAgentInstall
adb shell "am force-stop com.tencent.mm" && adb logcat -c
adb shell "am start -n com.tencent.mm/.ui.LauncherUI"   # 等 35s
adb logcat -d | grep "inbound adapter installed"        # Hook 装载确认（一拉失败二拉）
```

**验收指纹**：
- 成功：`image forwarded type=7/8 bytes=12-42KB b64len=... orig=wxgf`
- 失败兜底：`image forwarded type=7 bytes=~5KB`（缩略图）
- 解码过程：`wxgf opts rc=0: 1 <宽> <高> ...` → `wxgf frame rc=0 ... bmp=WxH` → `wxgf copy WxH`

---

## 六、方案 B：跨进程压缩（Codex 接手任务）

**目标**：compress 移出微信进程（Agent 独立进程内压缩），根治 ~43% 随机挂起。

**Codex 报告推荐路径**（`tools/codex-compress-report.md` 完整版）：
1. **解码结果扁平化**：`frame` 后通过 `getPixels(int[])` 或 SharedMemory/ParcelFileDescriptor 拿到受控原始像素（width/height/rowBytes/config/premultiplied）→ 传给 Agent 自己的进程。
2. **Agent 进程压缩**：重建 Bitmap → 缩放 → JPEG → base64 → WebSocket。Agent 进程内存隔离，微信进程崩/卡不影响。
3. **验证**（Codex 报告「验证顺序」）：先线程 dump 定案 → 单会话实验 → Agent 进程固定样本压缩 100 次（证明 compress API 无罪）→ 熔断（连续超时停用 WXGF 链路退回缩略图）。

**备选**（方案 C）：hook 微信自己的图片压缩入口（微信压缩图片安全），截获其 JPEG——性能最优但需继续逆向。

**架构注意**：
- Agent 服务进程（`BridgeForegroundService`）与微信进程是**独立进程**（Binder 通信）。
- 现在 `captureImageFromBitmap` 在微信进程内压缩 → 改：微信进程只 decode + 传像素/文件路径，Agent 进程压缩。
- 传输量：320px 原始 ARGB ≈ 400KB（Binder 单消息 ~1MB 内）——或传 wxgf 文件路径让 Agent 进程读（Agent 进程能访问微信目录吗？——可能需要 ContentProvider 或文件共享）。

---

## 七、资源路径

- Codex 分析报告：`tools/codex-compress-report.md`
- Grok 提问稿（背景事实）：`tools/grok-ask-der-generation.md`、`tools/grok-ask-der-round2.md`、`tools/grok-ask-wxgf-decode.md`、`tools/grok-ask-compress-stuck.md`
- 微信 dexdump 产物（可复用）：`C:\Users\Administrator\AppData\Local\Temp\wxdex\`（classes10-dis.txt 237MB 等）
- 运行时写文件 dump：`/data/user/0/com.tencent.mm/cache/wx_orig_dump.txt`（平板）

---

## 八、运维纪律（沿用）

- 混淆字段**一律实测不猜**（Grok/Codex 答案必须对照 dexdump/运行时验证）。
- 诊断代码与正式实现分离，**验证完必须全清**。
- 每次改代码：验证脚本（临时，跑完即删）→ build → install → 用户发图 → 拉日志确认。
- 验证计数轨迹参考：v6→v48（每轮 fresh ad-hoc 验证）。
- 服务器一律 `git fetch + reset --hard origin/main` 防分叉。
