# 微信 8.0.70 Xposed：方案 C 深入——hook 微信自己的图片解码/压缩入口

上一轮你已确认方案 B（跨进程压缩）为最简路线（getPixels 相对安全但仍有随机挂风险）。现在深入方案 C 作为备选/优化——**目标是完全不碰我们自己构造的 Bitmap**，截获微信自己安全解码/压缩的产物。

环境事实：
- 微信 8.0.70 全混淆，16 个 dex。我们已有 dexdump 产物（classes10-dis.txt 237MB 等，方法体反汇编）。
- 日志实证：`NativeImage: [WxImageLoader] file is loaded [wxfile://...] bitmap(not null)`——微信聊天页/大图加载走 WxImageLoader，**微信自己安全地把 wxgf/其他格式解码成 Bitmap**。
- 我们已能主动 CDN 下载 wxgf 文件到微信 cache 目录（`/data/user/0/com.tencent.mm/cache/...` 或 image2/）——**微信看到这个文件吗**？（wxfile:// 协议怎么映射到文件路径？）
- 我们 hook 微信下载时见过完整调用栈：`com.tencent.mm.modelcdntran.z.Y6`（协程）→ `w.invokeSuspend` → `r.invoke` → `l1.t`（构造 request）→ CdnManager.startC2CDownload。

问题：

## A. WxImageLoader 截获

1. **WxImageLoader 的类全名/包**？（日志 tag `NativeImage`，可能 `com.tencent.mm.media` 或 `com.tencent.mm.plugin.gif` 附近）在 8.0.70 混淆后类名是什么？给 dex grep 的字符串线索（"file is loaded" 是明文吗？在哪）？
2. **hook 点**：加载完成回调/返回 Bitmap 的方法签名？（参数：filePath/wxfile:// URI？返回：Bitmap？）——afterHookedMethod 拿 Bitmap 的姿势？
3. **关键**：微信加载「任意文件路径」的 wxgf 吗？——我们主动下载的 wxgf 文件（微信 cache 下），能不能**骗微信加载它**（构造 wxfile:// URL 或直接调 WxImageLoader 的加载方法传我们的路径）？——**如果微信能加载任意路径的 wxgf → 我们让微信解码 → 截获微信的 Bitmap（微信自己解码上下文健康）**——这个可行吗？
4. 截获微信 Bitmap 后：**微信进程内 compress 还挂吗**？（微信刚解码完同一张图，Skia 上下文健康？——还是只要是我们调 compress 就危险？）——如果不安全，截获后立刻 getPixels/Binder 传 Agent（回到方案 B 但省掉我们自己 decode 的挂起风险）。

## B. 微信发送图片的压缩链路

5. 微信发图（选图→压缩→上传）的入口类/方法？（历史类族 `com.tencent.mm.modelimage`、`CdnUtil`、ImageGalleryUI——8.0.70 混淆后具体是什么？给 dex 字符串线索：压缩参数 "quality"/"JPEG"/"compress" 附近的方法）
6. **复用可行性**：微信的压缩方法输入是「文件路径→输出路径」还是「Bitmap→byte[]」？能不能传我们的 wxgf 解码结果（或让微信直接压缩我们下载的文件）？——微信压缩会不会也调 MMWXGFJNI/我们踩过的 native？（微信自己压缩是安全路径吗？）
7. 微信**上传图片**的最终产物（压缩后 JPEG）在哪个目录/格式？（发图后 image2 或 cache 下的新文件？）——**被动观察**：让微信自己发图（用户操作）→ 我们找压缩产物？——还是只有 hook 才能拿？

## C. 对比与取舍

8. **方案 C 相比方案 B 的实际收益**：
   - B：我们自己 decode（MMWXGFJNI，串行化，有挂起风险）→ getPixels（相对安全）→ Binder 传 Agent 压缩——**微信进程只碰 decode+getPixels**
   - C：让微信自己 decode（WxImageLoader 或发送链路）→ 截获 Bitmap → 仍要 getPixels/Binder 传 Agent（如果微信进程 compress 不安全）——**省掉的是我们 decode 的挂起风险，多的是 hook 复杂度和「微信主动加载我们的文件」的不确定性**
   - 哪个更值得投入？C 有没有可能做到「微信进程完全零像素操作」？
9. **有没有更聪明的**：微信自己的「图片缩略/压缩」结果其实**已经缓存**在某个目录（比如发图后、显示后）？——我们被动扫目录找微信的压缩产物（JPEG），比 hook 简单？（之前查过 cdnTemp 用完即删、image2 只有 th_ 缩略图——但发送/查看大图后有没有留下 JPEG？）

请给「WxImageLoader 定位的具体类名/方法签名（含 dexdump grep 指引）+ 骗微信加载任意 wxgf 的可行性 + 微信压缩链路 hook 点 + C vs B 最终建议」，不要泛泛而谈。
