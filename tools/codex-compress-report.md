# 微信 8.0.70 Xposed 模块 WXGF Bitmap 随机挂起分析报告

日期：2026-08-08  
范围：只读静态分析 `apps/android-agent` 当前工作树，并结合 Android 官方文档/AOSP 说明平台机制；未修改源码、未构建、未提交。

## 一、结论摘要

最可能的根因不是“`Bitmap.compress` 在 Xposed 环境天然不稳定”，而是 **微信 WXGF JNI 解码器与传入 Bitmap 的像素所有权/锁/生命周期没有按其真实契约处理，已经造成像素锁未释放、use-after-free/双重释放或 native 堆破坏；`createScaledBitmap`/`compress` 只是下一批需要锁像素、分配 Skia 对象的 native 调用，因此最先表现为 futex/mutex 永久等待**。

当前最危险的顺序是：

```text
nativeDecodeBufferFrame(handle, ..., bmp, ...)
    -> bmp.copy(...)              // handle 仍存活，解码器可能仍持有 bmp/pixel lock
    -> bmp.recycle()              // 先释放 Bitmap
    -> finally nativeUninit(...)  // 后释放 decoder
```

尤其是项目注释/实测声称“`nativeUninit` 会释放 Bitmap native 像素”。这不是普通 Android Bitmap API 的正常所有权模型，恰恰说明该私有 JNI 可能接管或缓存了 PixelRef。此时在 `nativeUninit` 前 `recycle()` 是高风险逆序释放。即使 `safe = bmp.copy(...)` 偶尔成功，也不能证明 native 堆、锁状态和复制目标未被异步写入或间接破坏。

优先建议是：

1. 串行化整个 WXGF decoder 会话；验证微信实际调用顺序与 `nativeDecodeBufferFrame` 的同步性；绝不在 `nativeUninit` 前 recycle decoder 使用过的 Bitmap。
2. 将解码结果尽快“扁平化”为受控的原始像素（含明确 `width/height/rowBytes/config/premultiplied`），通过 `SharedMemory` 或 `ParcelFileDescriptor` 送到 Agent APK 自己的进程；缩放、JPEG、base64 和 WebSocket 均在 Agent 进程执行。
3. 若能定位微信自己的 WXGF→普通图片完整入口，优先直接截获其最终 JPEG/PNG 文件或 byte[]，不要把模块自行构造的 decoder Bitmap 再喂给微信/Skia 压缩器。

## 二、最可能原因排序与原理

### 1. WXGF JNI 的 Bitmap 像素所有权/锁/释放顺序错误（高概率，第一嫌疑）

代码证据：`Wechat8070Adapter.java:898-924`。`nativeDecodeBufferFrame` 返回后，代码在 handle 尚未 uninit 时执行 `bmp.copy`，随后 `bmp.recycle`，最后才在 `finally` 中 `nativeUninit`。

可能机制：

- JNI 内部通过 `AndroidBitmap_lockPixels`、Skia PixelRef 或微信自有包装持有像素锁，返回时没有真正释放，而是在 `nativeUninit` 才解锁。后续 `Bitmap.copy`、缩放、编码都会再次请求像素锁，于是卡在 native futex，Java 无异常。
- JNI 保存了 Bitmap/像素地址并在 decoder 销毁时释放或回写。提前 `recycle()` 会形成 use-after-free、双重释放或 allocator 元数据破坏。破坏发生点与暴露点分离，因而同样输入、同样代码可能偶尔成功。
- decoder 可能返回“完成”但内部工作仍异步收尾；copy/uninit/recycle 与其工作线程竞态，正好符合高度随机且与输出尺寸、JPEG/PNG、Java 线程类型无关的现象。

AOSP 中 Bitmap copy、像素复制、压缩最终都进入 native；老版本实现对像素访问使用 `SkAutoLockPixels`。所以坏 PixelRef/未释放锁能同时影响 `copy`、缩放和编码，而不会转化为可 catch 的 Java 异常。参考：[AOSP Bitmap native 方法与像素锁](https://android.googlesource.com/platform/frameworks/base/%2B/7b2f8b8/core/jni/android/graphics/Bitmap.cpp)、[Android Bitmap API](https://developer.android.com/reference/android/graphics/Bitmap)。

### 2. MMWXGFJNI 存在进程级全局状态，多个 decoder 会话并发破坏状态（高概率）

代码证据：`Wechat8070Adapter.java:329-394` 对每条图片消息创建独立 `feagle-orig` 线程；未见围绕 MMWXGFJNI 全会话的全局锁。虽然每次有独立 handle，私有库仍可能使用全局 HEVC context、线程池、静态 scratch buffer 或单例硬解码器。handle 独立并不等于底层可重入。

如果一条消息被多个 hook 入口捕获，去重发生在解码完成后的 `captureImageFromBitmap`，无法阻止前面的 CDN/decoder 并发。7/8 失败、偶发一次成功很像全局解码器或硬件 codec 会话竞态。

建议用单线程 executor 或 `synchronized(WXGF_DECODER_LOCK)` 包住 init→header→getOption→frame→像素脱离→uninit 的完整区间验证。只锁 `nativeDecodeBufferFrame` 不够。

### 3. 输出尺寸、stride、格式或 JNI 参数契约不完整，导致越界写/内存破坏（中高概率）

代码只用 `opts[1]`、`opts[2]` 创建 ARGB_8888 Bitmap，并只检查 `rc3`：

- `rc1`、`rc2` 被读取但没有要求为成功值；header/getOption 失败后仍可能继续。
- `outInfo=[60,0,0,0]` 的语义未知；不能确认是否包含像素格式、stride、帧状态或延迟完成标志。
- 异常尺寸时直接 fallback 为 1080×1920（`Wechat8070Adapter.java:884-889`）。若真实帧更大，decoder 按真实 stride 写入较小分配，会直接越界；这个 fallback 不安全，应该失败关闭而不是猜尺寸。
- 未验证 `bmp.getRowBytes()`、`getByteCount()`、宽高乘法溢出、decoder 所需色彩格式/alpha premultiplication，以及 `outInfo` 数组所需真实长度。

越界写通常不会在 JNI 返回处稳定 crash；它可在后续 malloc、Skia 锁或 libjpeg 中表现为随机死锁。

### 4. 卡点其实在 `captureImageFromBitmap` 的压缩前路径，而日志证据不足（中概率，必须先排除）

`WechatHook.java:748-790` 的“第一行日志”并不是真正无依赖：它先调用 `appContext().getCacheDir()`、打开文件、写入、close，且所有异常被无声吞掉。XposedBridge.log 全部失效只能证明日志通道不可依赖，不能证明 `createScaledBitmap` 已进入。

压缩前还有：

- `bitmap.isRecycled()`；
- `parseImageSender`/`eventId`；
- `synchronized(recentEvents)`；
- `recentEvents.containsKey(eventId)` 的提前 return。

当前 `recentEvents` 临界区很短，静态代码中未发现持锁做慢操作，因此它本身造成永久死锁的概率不高；但重复事件会在压缩前静默返回。并且事件在压缩成功前就写入，首次挂起/失败后同事件的后续重试会被永久吞掉（直到 LRU 淘汰/进程重启）。

用户当前描述为“调用方返回后日志不出现”，这支持线程确实被阻塞；但仓库内旧诊断材料曾记录过“`bitmap dispatched` 出现、方法已返回但内部日志不出现”的相反现象。两批现象应分开统计，不能用同一根因解释。建议用线程 dump 和单调递增的文件检查点定案。

### 5. Skia/libjpeg 的进程内锁被微信其他 hook/native 代码破坏，或同一 Bitmap 仍被其他线程使用（中低概率）

`Bitmap.compress` 是同步 native 编码，`createScaledBitmap` 也会读取源像素。AOSP API 不提供超时或中断语义；native mutex 卡死不会抛 Java 异常。微信进程中有大量图像/硬解码 native 库，若前述 JNI 已破坏全局锁/堆，症状会集中暴露在 Skia。

但“微信自身渲染线程正常占用 Skia”通常只造成短暂竞争，不应以 7/8 概率永久挂起；Xposed/LSPosed 注入本身也没有让普通 software ARGB_8888 Bitmap 随机挂起的已知必然机制。因此这一项更可能是上游破坏的后果，而非独立根因。

### 6. 内存、输出流、格式、daemon 调度（低概率）

580×398 也挂、320/640/1024 都挂、JPEG/PNG 都挂、同步/worker 都挂，已显著削弱这些假设。`FileOutputStream` 若是普通 cache 文件，最多更像 I/O 阻塞；它不能解释 `createScaledBitmap` 同样异常，也不能解释与 WXGF JNI 生命周期的高度相关性。

## 三、基于当前代码的具体可疑点

1. **逆序销毁**：`Wechat8070Adapter.java:910-924` 在 `nativeUninit` 前 `bmp.recycle()`。应由真实 JNI 调用链决定所有权；在契约未知时，最保守顺序是先完成受控像素快照，再 uninit，最后才 recycle decoder Bitmap。
2. **handle 存活期间 copy**：`bmp.copy(...)` 可能与 decoder 锁/异步写冲突。即使必须在 uninit 前取像素，也更适合一次性复制到明确的 `int[]`/direct buffer，并在 uninit 后创建新 Bitmap；这样至少不会让新 Bitmap 的 PixelRef 与 decoder 生命周期交织。
3. **没有 decoder 全局串行化**：每条图片各起 `feagle-orig`；去重太晚，无法保护 JNI。
4. **忽略 rc1/rc2**：header 或 option 失败仍继续；`findMethod` 返回 null 后也只会在外层以反射异常结束，诊断粒度不足。
5. **危险 fallback 尺寸**：猜 1080×1920 可能比真实输出小，最坏是 native 越界写。应 fail closed。
6. **未校验真实输出布局**：没有核对 rowBytes、allocationByteCount、outInfo 含义及 premultiplied/alpha；只看 `getWidth/getHeight/isRecycled` 不能证明像素后端健康。
7. **safe Bitmap 未 recycle**：`captureImageFromBitmap` 只回收 scaled，不回收传入的 safe；调用方也没有回收。它不是这次小图随机挂起的首因，但持续运行会累积 native/Java 像素内存并放大后续故障。
8. **资源清理不完整**：`FileOutputStream`、`FileInputStream`、临时文件、scaled recycle 没有统一 finally/try-with-resources；一旦 native compress 卡住无法补救，一旦 Java 异常则可能泄漏 fd/Bitmap。
9. **压缩前去重且失败不回滚**：`WechatHook.java:767-781` 成功前登记 event。重复捕获或重试会静默 return，容易被误判为“压缩没执行”。
10. **诊断日志会吞证据**：文件日志每次重新打开且异常全吞；XposedBridge.log 与目标 native 图像链共享同一故障进程，不能作为唯一证据。
11. **现有 Binder 只适合最终小 JPEG**：`sendImageToAgent` 将 base64 放进 Bundle；Android 官方说明 Binder 事务缓冲区目前约 1MB且为进程共享。服务虽允许微信 UID，但 `InboundHandler` 跑主线程。不能照此方式直接传 10MB+ ARGB。参考：[TransactionTooLargeException](https://developer.android.com/reference/android/os/TransactionTooLargeException)。

## 四、三个可执行替代方案

### 方案 A（首选）：原始像素经 FD/共享内存交给 Agent 进程压缩

目标：微信进程只做无法搬走的 WXGF 解码和一次像素快照；任何 Skia 缩放、JPEG、base64、WebSocket 都在 `io.github...agent` 自己的进程执行。现有 `BridgeForegroundService` 本来就运行在 Agent APK 进程，且 `isAllowedUid` 已允许 `com.tencent.mm`，基础链路可复用。

协议建议新增 `MSG_RAW_IMAGE_FD`，Bundle 只放小元数据与 Parcelable FD/SharedMemory，不放 raw byte[]：

```java
// 微信进程：整个 decoder 会话严格串行
synchronized (WXGF_DECODER_LOCK) {
    handle = nativeInit...();
    check(nativeDecodeBufferHeader(...) == 0);
    check(nativeGetOption(...) == 0);
    checkExactDimensionsAndAllocation();      // 禁止猜测 fallback
    Bitmap decoderBmp = Bitmap.createBitmap(w, h, ARGB_8888);
    check(nativeDecodeBufferFrame(..., decoderBmp, outInfo) == 0);

    // handle 尚有效时只做一次确定性快照；不要 recycle decoderBmp
    int[] argb = new int[w * h];
    decoderBmp.getPixels(argb, 0, w, 0, 0, w, h);

    nativeUninit(handle);                     // 先销毁 decoder
    decoderBmp.recycle();                     // 后销毁传给 decoder 的 Bitmap
}

// API 27+：SharedMemory，大小为 header + w*h*4；写入后 setProtect(PROT_READ)
SharedMemory shm = SharedMemory.create("feagle-wxgf", HEADER + w*h*4);
ByteBuffer map = shm.mapReadWrite();
writeHeaderAndArgb(map, w, h, /*rowBytes=*/w*4, PREMULTIPLIED_ARGB8888, argb);
SharedMemory.unmap(map);
shm.setProtect(PROT_READ);
Bundle b = metadataPlus("raw_shm", shm);
messenger.send(Message.obtain(null, MSG_RAW_IMAGE_FD).withData(b));
```

Agent 服务端：

```java
case MSG_RAW_IMAGE_FD:
    RawJob job = validateAndDetachMetadata(message.getData());
    imageExecutor.execute(() -> {
        // 限制 w/h、总字节、eventId；超时/失败关闭 FD
        IntBuffer pixels = mapOrRead(job).order(nativeOrder()).asIntBuffer();
        Bitmap src = Bitmap.createBitmap(job.w, job.h, ARGB_8888);
        src.copyPixelsFromBuffer(pixels);
        Bitmap scaled = scaleAtMost(src, 1024);
        byte[] jpeg = compressJpeg(scaled, 72); // 这里是干净的 Agent 进程
        forwardPrivateOrGroupImage(metadata, jpeg);
        recycleAndCloseEverything();
    });
```

兼容 API 26 时用 `ParcelFileDescriptor.createReliablePipe()`：Bundle 传 read end，微信进程在专用 writer 线程写固定 header + ARGB，Agent 收到后立即把 read end交给 `imageExecutor` 读取，绝不能在当前主线程 `InboundHandler` 中读，否则 pipe 缓冲区写满会互相等待。官方说明 pipe 第一项为读端、第二项为写端：[ParcelFileDescriptor](https://developer.android.com/reference/android/os/ParcelFileDescriptor)。API 27+ 的 `SharedMemory` 是 Parcelable，可 map 且能切只读：[SharedMemory](https://developer.android.com/reference/android/os/SharedMemory)。

工程注意：

- `int[]` 仍在微信进程产生，但它是 Java 管理的平坦数据，不带 Skia PixelRef/decoder handle。若 `getPixels` 本身挂住，说明锁问题发生在 decoder 输出阶段，跨进程压缩并不能掩盖，必须先修正/替换 WXGF 解码入口。
- 给每个 job 加最大像素数（例如 32MP）、精确总长度、CRC32/xxHash、10–20 秒读取超时和单并发队列。
- 不建议直接 Bundle `Bitmap` 或 raw `byte[]`；`Bitmap.asShared()` 直到 API 31 才提供，且大 Bundle 受 Binder 1MB共享缓冲约束。
- 该方案的最大价值是故障隔离：即使微信进程的 Skia/native 堆后续失常，Agent 编码进程不受污染。

### 方案 B：hook 微信自己的 WXGF→普通图片完整入口，截获最终文件/byte[]

优先级次于 A，但如果定位成功，代码量和像素内存都可能更小。关键不是“调用微信某个 Bitmap 压缩工具”，而是复用微信自己已经验证过的 **从 wxgf 输入到 JPEG/PNG 输出** 的整条入口，让它自己处理 decoder 生命周期、stride、线程和 codec。

当前源码已知道 `MMWXGFJNI` 并在注释中提到 `nativeWxam2PicBuf`，但仓库没有保存该方法的精确签名，因此不能负责任地硬编码类/参数。落地步骤：

1. 用已有 `getDeclaredMethods()` dump 获取 `nativeWxam2PicBuf` 及所有 wxam/wxgf→pic 方法的精确签名。
2. 从微信 dex 的 JNI 调用点向上找 Java wrapper；优先寻找同时含输入 wxgf path/byte[]、输出 path/byte[]、quality/width 的方法。
3. hook wrapper 的 before/after：记录输入 magic `wxgf`、返回码、输出 magic（JPEG `FFD8FF`/PNG）、尺寸与文件长度；先通过用户正常打开大图触发，确认微信真实调用顺序。
4. 正式链路只调用已验证 wrapper，或被动截获其输出；不要直接反射猜 JNI 参数。

伪代码：

```java
// exactWrapperClass / exactMethod / signature 必须来自 8.0.70 实机验证
hook(exactWrapperMethod, new XC_MethodHook() {
    protected void afterHookedMethod(MethodHookParam p) {
        Output out = parseVerifiedOutput(p.args, p.getResult());
        if (isOurWxgf(out.input) && out.rc == 0 && isJpegOrPng(out.bytesOrFile)) {
            // 已经是压缩图片：直接通过 FD 或小 byte[] 交给 Agent；无需 Bitmap.compress
            enqueueToAgent(out, messageMetadata);
        }
    }
});

// 主动调用只在确认 wrapper 无 UI/Looper 前置条件后进行
verifiedWxgfToPictureWrapper(wxgfPath, outputPath, requestedMaxEdge, quality);
```

若只有“微信发送图片压缩”入口可定位，也要让该入口读取文件/URI并产生新文件，避免把当前 decoderBmp/safe Bitmap 作为参数；否则仍会继承本报告第一类 PixelRef 风险。版本混淆使该方案维护成本高，应把“签名探测→实机确认→版本白名单”作为正式流程。

### 方案 C：绕开 Bitmap 缩放/编码，ARGB→NV21 后走 `YuvImage.compressToJpeg`

这是 Android 原生的另一条 JPEG 路径：输入是普通 byte[] 的 NV21/YUY2，不依赖源 Bitmap 的 PixelRef，也不调用 `Bitmap.createScaledBitmap`。最好仍放在 Agent 进程；若短期无法改 IPC，也可以在微信进程对已脱离 decoder 的 `int[]` 使用，以判断问题是否局限于 Bitmap/Skia 像素锁。

```java
// 1) 在 decoder 会话中仅取得 int[] argb；按正确顺序 uninit 后再继续
int dstW = fitWidth(w, h, 1024);
int dstH = fitHeight(w, h, 1024) & ~1; // NV21 色度 2x2，宽高取偶数
byte[] nv21 = new byte[dstW * dstH * 3 / 2];

// 2) 纯 Java/Kotlin CPU 路径：一次完成缩放 + ARGB(pre-multiplied) 转 YUV420sp
for (int y = 0; y < dstH; y++) {
    int sy = y * srcH / dstH;
    for (int x = 0; x < dstW; x++) {
        int sx = x * srcW / dstW;
        int c = argb[sy * srcW + sx];
        // 若 alpha 非 255，先按确定背景色合成；随后 BT.601 full/limited-range 转换并 clamp
        writeY(nv21, x, y, rgbToY(c));
        if ((x & 1) == 0 && (y & 1) == 0) writeInterleavedVU(nv21, x, y, c);
    }
}

// 3) 不创建 Bitmap，不走 Bitmap.compress
YuvImage yuv = new YuvImage(nv21, ImageFormat.NV21, dstW, dstH, null);
ByteArrayOutputStream out = new ByteArrayOutputStream();
boolean ok = yuv.compressToJpeg(new Rect(0, 0, dstW, dstH), 72, out);
byte[] jpeg = ok ? out.toByteArray() : null;
```

优点：完全绕开 `createScaledBitmap` 和源 Bitmap 编码；输入布局明确；易于做单元校验。缺点：ARGB→YUV 的 CPU 成本、色彩矩阵/alpha 处理需要严谨；`YuvImage` 最终仍进入系统 native JPEG encoder，如果 WXGF JNI 已经破坏整个进程 native 堆，它在微信进程仍可能受牵连，所以“放 Agent 进程”比仅替换 API 更可靠。

不建议把 `ImageDecoder` 当替代方案：它是解码 API，且 WXGF 不是系统支持的标准容器；它也不提供这里需要的独立 JPEG 编码出口。

## 五、建议的验证顺序与判定标准

1. **先拿线程 dump，不再猜日志。** 挂起时对微信进程触发 Java/native stack dump（例如受控环境 `kill -3 <pid>`，或 Android Studio/Perfetto）。若 `feagle-orig` 在 `SkPixelRef::lockPixels`、`AndroidBitmap_lockPixels`、`futex_wait`、`Bitmap_nativeCopy/nativeCompress`，支持像素锁假设；若在 `FileWriter/open/fsync`、`recentEvents` monitor 或 Binder，则改排位。
2. **单会话实验。** 全局只允许一个 WXGF decoder 会话，禁用猜尺寸 fallback，并检查 rc1/rc2/rc3。若成功率从 1/8 显著变稳定，证明库不可重入或生命周期竞态。
3. **只做像素快照实验。** frame→`getPixels(int[])`→uninit→recycle，不做任何 Bitmap 缩放/压缩；对数组算 CRC。重复同一文件 20 次，CRC 必须一致。CRC 不一致说明 decoder 尚未同步完成、尺寸/stride 错或发生越界。
4. **Agent 进程固定样本实验。** 将一份已知正确 ARGB 通过 SharedMemory/pipe 重建 Bitmap并连续压缩 100 次。若稳定，压缩 API 无罪，问题在微信进程或 decoder 输出；若 Agent 也挂，才查设备 ROM/系统 codec。
5. **故障边界。** 任何 native 调用一旦永久阻塞，Java `Future.cancel`/interrupt 无法可靠终止它；超时只能让上层放弃等待，不能回收卡住线程。生产上需要单并发、熔断（连续一次超时即停用 WXGF 原图链路，退回已验证缩略图）以及进程隔离。

最终推荐实施顺序：先修正/验证 decoder 生命周期和串行性；随后实施方案 A；并行逆向方案 B 作为性能最优路径；方案 C 作为不依赖 Bitmap 编码的可靠兜底与诊断对照。
