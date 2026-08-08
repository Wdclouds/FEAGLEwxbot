# 微信 8.0.70 Xposed：wxgf 解码后 Bitmap 压缩「随机静默失败/卡死」——请给诊断方向

背景：微信 Android 8.0.70 Xposed 模块（LSPosed，注入微信主进程）。图片原图链路已打通：CDN 下载 wxgf（微信 HEVC 私有格式）→ 调微信解码器 `com.tencent.mm.plugin.gif.MMWXGFJNI` 的 buffer API（nativeInitWxAMDecoder → nativeDecodeBufferHeader → nativeGetOption(宽高) → nativeDecodeBufferFrame(输出 Bitmap) → nativeUninit）→ 得到完整原图分辨率 Bitmap（如 1280×2535）→ **之后 Bitmap 压缩/上报**——**这里随机卡死/静默失败**。

---

## 完整链路（已验证通过的部分）

```
1. CDN 下载 wxgf 文件（~59-75KB，HEVC 压缩的原图数据）✓
2. MMWXGFJNI 解码：
   nativeInitWxAMDecoder() → handle
   nativeDecodeBufferHeader(handle, data, len) → rc=0
   nativeGetOption(handle, data, len, int[16]) → rc=0, opts=[1, 1280, 2535, 0...]（[1]=宽 [2]=高，实测）
   Bitmap bmp = Bitmap.createBitmap(w, h, ARGB_8888)
   nativeDecodeBufferFrame(handle, data, len, bmp, int[4]) → rc=0, out=[60,0,0,0]
   // nativeUninit 会释放 Bitmap 的 native 像素 → 必须先 copy：
   Bitmap safe = bmp.copy(ARGB_8888, false)  // ✓ copy 成功，日志显示 1280x2535
3. captureImageFromBitmap(safe)：同步压缩 createScaledBitmap(640px) → compress(JPEG/PNG) → base64 → Binder 上报
```

## 核心问题：第 3 步随机静默失败

**现象**（多次实测）：
- **17:37 一次成功**：`sync start 1280x2535` → `sync scaled 323x640` → `sync compressed size=42580` → `image forwarded ... orig=wxgf`（完整上报 42KB JPEG）
- **其他 6+ 次全静默**：解码（frame rc=0 + copy 成功）后，**压缩没有任何日志**——没有 compressed 日志、没有失败日志、没有异常日志——**只有**调用方（adapter）的 `bitmap dispatched WxH` 日志（在 captureImageFromBitmap 返回后打印）——**然后**约 9 秒后另一条消息路径上报缩略图（type=7）

**关键矛盾**：`bitmap dispatched` 日志打印 = captureImageFromBitmap 方法**已经返回**——但方法内**同步压缩块**（加过 start/scaled/compressed 分步日志）**一条都没打**——**即压缩块从未执行**（或执行了但 log 全部失效）。

**已尝试且无效**：
| 变量 | 尝试 | 结果 |
|---|---|---|
| 压缩格式 | JPEG q72 / PNG | 都静默 |
| 压缩尺寸 | 640px / 1024px | 都静默 |
| 线程 | daemon worker / 非 daemon worker / 完全同步（调用线程） | 都静默 |
| 日志 | XposedBridge.log 分步日志 | 失败时一条不打 |

**失败的「成功」判定**：17:37 成功那次配置（640px + JPEG + 同步 + 诊断日志）后来原样复现也失败——**随机性**。

## 待确认的假设

1. **压缩块实际没执行**（提前 return）：`bitmap == null || isRecycled()` 或 `recentEvents.containsKey(eventId)` 去重——但 bitmap 刚 copy 成功（非 null），且 dispatch 只调用一次（无双路径）——**不太可能**
2. **压缩块执行了但 log 失效**：XposedBridge.log 在特定上下文（如 native 调用后的线程状态）不输出？——但 17:37 成功时打了
3. **compress 内部 native 挂起但方法最终返回**（native 卡住后超时/异常返回 0 字节）——`jpeg.length == 0` 分支有 log（bitmap compress failed）——**没打**
4. **catch(Throwable) 吞了异常但 logError 也失效**
5. **线程饿死**：调用线程（fetch 线程，feagle-orig）在低内存平板（SM-X200，4GB？）被系统饿死——但 adapter 的 dispatch 日志打了（同线程后续代码执行了）——**矛盾**：dispatch 日志在 captureImageFromBitmap 调用**之后**——如果线程饿死，dispatch 也不会打

## 问 Grok

1. **Bitmap.compress / createScaledBitmap 在 Xposed 注入的微信主进程内「随机静默失败」的最可能原因**？（native 锁竞争？Skia/硬件位图？微信渲染线程占用？内存？）
2. **怎么可靠诊断**：压缩块到底执行没有、卡在哪一步？（文件写日志绕 XposedBridge.log？线程 dump？）
3. **Bitmap.copy(ARGB_8888) 的产物**有什么特殊性？nativeDecodeBufferFrame 输出的 Bitmap 是 native 分配（可能 Hardware/特殊配置）——copy 后 compress 是否可能走异常路径？
4. **替代编码方案**（不依赖 Bitmap.compress）：a) decodeWxgfToBitmap 直接输出小尺寸（native 层支持缩放输出吗？）b) safe.compress 换成 `Bitmap.compress` 之外的方式（如 `BitmapFactory` 重编码？）c) 用 Android `ImageDecoder`（API 28+）解码 wxgf 的内存副本？d) 微信进程内有没有可复用的图片压缩入口（微信自己压缩图片用哪个 API——hook 它）？
5. **最终兜底建议**：如果压缩在微信进程内不可靠，是否应该「解码 → 存 PNG 文件 → 用另一个进程/组件压缩」？（Agent 服务是独立进程吗？Binder 传 Bitmap/文件过去压？）

请给「最可能原因排序 + 可执行诊断 + 绕过方案」，不要泛泛而谈。
