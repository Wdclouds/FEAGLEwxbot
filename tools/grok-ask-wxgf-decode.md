# 微信 8.0.70 Xposed 图片原图链路——进度同步，请评估是否跑偏 + 给下一步

背景：微信 Android 8.0.70（全混淆）Xposed 机器人，目标是图片消息到达时**自动拿到原图**（不依赖用户点开），压缩后喂给多模态模型。请基于你微信 CDN/WXGF 的知识评估当前路线并给建议。

---

## 已解决（全部实测验证）

1. **主动 CDN 下载链路打通**：`CdnManager.OnJniStartC2CDownload` 调用成功（start=0）、QUIC 连接、回调 errorCode=0、文件落盘。
2. **-20003 根因**：request 字段用 `getField` 设置（private 字段静默失败，如 savePath）→ 改 `getDeclaredFields + setAccessible` 解决。
3. **下载规格（关键突破）**：微信原图下载 request 实测为——
   - `fileKey = adownimg_<hash>_<unix秒>_<seq>_hevc`（**hash 固定 = cf8f8e41a49c1185**，两次不同图相同 → CDN 会话标识，非图资源 ID；随机 hash 只返回 8-80KB 部分数据，固定 hash 才稳定）
   - `fileType = 2`、`customHeader = source_format:1\r\nmsgid:<svrid>\r\nsource_filesize:0`
   - `fileid`（DER）= XML 模板 DER + 新时间戳 + 规格码 152a（微信运行时同规格码）
4. **下载结果**：固定 hash 后稳定拿到 **~75KB wxgf 文件**（原图 len 197KB-1MB 不等）。
5. **wxgf = 微信私有 HEVC 图片格式**（文件头 `wxgf`）：微信用 HEVC 视频编码存图，BitmapFactory 无法解码。已定位解码器 `com.tencent.mm.plugin.gif.MMWXGFJNI`（JNI 反射 dump 到完整 API）。

## 当前在做

**用微信解码器 buffer API 解 wxgf**：
```
nativeInitWxAMDecoder() -> long handle
nativeDecodeBufferHeader(long, byte[], int) -> int      // 解析头
nativeGetOption(long, byte[], int, int[]) -> int        // 拿选项（盲猜 int[0]=宽 int[1]=高）
nativeDecodeBufferFrame(long, byte[], int, Bitmap, int[]) -> int  // 解码到预创建 Bitmap
nativeUninit(long) -> int
```
计划：Init → Header → GetOption(宽高) → createBitmap(w,h) → DecodeBufferFrame → Bitmap → 压缩 JPEG → 上报。

其他 API（已 dump）：`nativeAV2Gif(String,String)`（试过，rc=0 但输出文件不存在——疑似视频转 GIF 非图片）、`nativePic2Wxam*`（编码用）、`isWxGF(byte[],int)`、`nativeGetAigcInfoFromBuf`。

## 待探索 / 不确定点

1. **nativeGetOption 的 int[] 输出语义**：opts[0]/opts[1] 真是宽高吗？还是别的选项数组？微信自己怎么拿 wxgf 宽高？
2. **nativeDecodeBufferFrame 的 Bitmap 参数**：必须预创建正确尺寸的 Bitmap？还是 native 自己填？int[] 参数是什么（输出进度/状态？）？
3. **75KB wxgf vs 微信点开显示的 1MB 原图**：75KB 是「完整原图的 HEVC 压缩」（HEVC 高压缩比正常）还是「CDN 只给了部分数据」？**即：我们下载的 wxgf 解码后是完整原图分辨率，还是中档图？**
4. **nativeAV2Gif rc=0 但无输出**：可能原因？（未 nativeInit 初始化？参数语义不同？）
5. **路线选择**：A. 继续当前「主动下载 wxgf + 自己调解码器」B. hook 微信解码入口（微信显示原图时 nativeDecodeBufferFrame 被调 → 直接拿微信的 Bitmap）——**B 需要用户点开图（不自动），A 全自动**——但 A 依赖我猜对 buffer API 调用方式。

## 预计成果

- wxgf 解码成功 → 完整原图 Bitmap → 压缩 JPEG（1024px/q72，<200KB）→ base64 → 多模态模型看图
- 全自动（消息到达即下载+解码+上报，无人工）
- 若 75KB 是完整原图（HEVC），等于微信「查看原图」同等级清晰度

## 问 Grok

1. **这条路线是否跑偏**？还有没有更简单的正道？（例：hook 微信某个「给定消息对象下载原图」的入口方法，让它自己下载+解码，我们只读结果）
2. **nativeDecodeBufferFrame/GetOption 正确调用方式**：宽高怎么拿？Bitmap 怎么建？int[] 参数传什么？
3. **75KB wxgf 是完整原图吗**？（HEVC 压缩比判断——197KB 原图压缩到 75KB 合理吗？1MB 原图呢？）
4. **nativeAV2Gif 为什么 rc=0 无输出**？（要不要先 nativeInit(String)？——之前 dump 有 `nativeInit(String) -> int`，wechat-dump 博客提过 nativeInit 返回 -1 是 dlopen 失败——微信进程内应该已初始化？）
5. **微信显示原图时的调用链**：nativeDecodeBufferFrame 被调时，微信传的 Bitmap 尺寸从哪来？（如果是 nativeGetOption 拿的，那我的用法就对）

请直接给「结论 + 具体调用参数 + 验证点」，不要泛泛而谈。
