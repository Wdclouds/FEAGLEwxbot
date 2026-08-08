# 微信 8.0.70 Xposed：原图链路「跨进程压缩（方案B）」与「hook 微信压缩（方案C）」实施细节咨询

背景：微信 Android 8.0.70 Xposed 模块（LSPosed）。图片原图链路已打通：CDN 下载 wxgf（微信 HEVC 私有格式）→ 调微信解码器 `com.tencent.mm.plugin.gif.MMWXGFJNI` buffer API 解码出完整原图 Bitmap（1280×2535 级）→ **微信进程内 `Bitmap.compress` 随机挂起（~43% 成功率）**——根因（Codex 诊断 + 我们实测佐证）：WXGF JNI 破坏微信进程 native 状态（像素锁/堆），**微信进程内任何 Bitmap 操作不可靠**。

架构：模块（注入微信进程 `com.tencent.mm`）与 Agent 服务（独立进程，同 APK `io.github.wdclouds.feaglewxbot`，Binder Messenger 通信）是两个进程。当前压缩在微信进程内做，要移到 Agent 进程（方案 B），或彻底绕开自己压缩（方案 C）。

---

## 方案 B：跨进程压缩（请细化）

微信进程：CDN 下载 wxgf → MMWXGFJNI 解码 → **把像素数据传给 Agent 进程** → Agent 进程：重建 Bitmap → 缩放 320px → JPEG q60 → base64 → 上报。

请给可执行细节：

1. **解码后怎么把像素「安全脱离」微信进程**？
   - `Bitmap.getPixels(int[])` 在微信进程内安全吗？（Codex 说 native 状态已破坏——getPixels 会不会也随机挂？）
   - 有没有不碰 Bitmap API 的方式？（比如 decode 时直接让 native 输出到 byte[]？MMWXGFJNI 有没有输出 byte[] 的 API——我们只见过输出 Bitmap 的 nativeDecodeBufferFrame）
   - `SharedMemory`（Android 8+）跨进程传像素是正道吗？Binder 传 `SharedMemory` 对象（API 27+）还是传 int[]/byte[] 数组？（320px 图 ARGB ≈ 400KB，Binder 单消息 1MB 内——数组可行吗？）

2. **Agent 进程侧重建 Bitmap 的正确姿势**？
   - `Bitmap.createBitmap(w, h, ARGB_8888)` + `setPixels(int[], ...)`（setPixels 慢但 320px 可接受？）
   - 还是 SharedMemory 直接映射成 Hardware/software Bitmap（`Bitmap.wrapHardwareBuffer` 或 ImageReader 管道）？
   - Agent 进程是普通应用进程——BitmapFactory/compress 在该进程绝对安全？（模块进程 vs 普通进程有区别吗？）

3. **更简单的中间态**：微信进程 decode 后**直接写 PNG 文件**到模块自己可写的目录（模块 APK 私有目录，Agent 进程同 APK 可读？），Agent 进程读文件 → BitmapFactory.decodeFile → 压缩——**但 decode 后写 PNG 也要 compress（PNG 编码）**——又碰 Bitmap API——死路？还是 PNG 编码比 JPEG 安全？（我们试过 PNG compress 也挂）

4. **微信进程 decode 后把像素画到 Canvas 再取？**（Canvas.drawBitmap → 不同 native 路径？）——还是所有像素操作都死？

## 方案 C：hook 微信自己的压缩/解码入口（请给逆向路径）

5. **微信自己压缩图片（发送图片时）用什么方法？**怎么定位（类名/方法/字符串线索）？hook 它传任意 Bitmap/文件路径 → 拿压缩后 JPEG？
6. **微信显示 wxgf 图片时**（聊天页/大图）——日志见过 `NativeImage: [WxImageLoader] file is loaded [...] bitmap(not null)`——**微信自己安全地解码了 wxgf 为 Bitmap**——hook `WxImageLoader` 或图片加载回调，能不能**截获微信解码后的 Bitmap**（微信自己的解码上下文，像素锁正常）？然后我们只做 `bitmap.compress`（还是碰 Skia——但微信自己刚解码完同一张图，上下文健康？）——或者直接截获微信加载链路里更下游的 JPEG/PNG 产物？
7. **微信发送图片的压缩链路**：发图前必压缩（上传大小限制）——hook 发送压缩方法，输入换成我们的 wxgf 解码 Bitmap？——微信的压缩 API 对任意 Bitmap 可用吗（还是绑定发送流程）？

## 其他

8. **为什么 17:37 那次（640px JPEG 同步+诊断日志版）能成功**，其他全挂？——有没有可能是「日志/时序」偶然因素（XposedBridge.log 在某些线程/时刻输出成功）而不是 compress 真成功？（我们有文件日志证据：那次 compress 真的完成了 size=42580）
9. **微信进程内有没有「不碰 Skia 的 JPEG 编码」**（比如直接调 native libjpeg/libheif 的 Java 包装、或 MediaCodec 转码）？MediaCodec（硬件编码）能编码 Bitmap 吗（要 Surface/InputBuffer 格式转换——绕开 Skia？）

请给「方案 B 的精确实现步骤（含 API 级细节）+ 方案 C 的逆向定位线索 + 最简可行路线」，不要泛泛而谈。
