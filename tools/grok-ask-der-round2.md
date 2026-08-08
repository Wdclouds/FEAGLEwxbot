# 微信 8.0.70 CDN 下载：手动构造 DER 失败——第二轮反馈，Grok 请聚焦「规格决定字段」

续上次讨论（微信 Xposed 8.0.70，CdnManager OnJniStartC2CDownload 下载图片）。按你上次的建议做了「手动构造 DER」实验，**失败**——下载到的仍是缩略图规格。以下是完整实验数据 + 新证据，请聚焦回答：**到底什么决定 CDN 返回缩略图 vs 原图**。

---

## 实验数据（全部实测）

### 1. 下载链路本身完全通畅（排除链路问题）
- `OnJniStartC2CDownload(req, callback)` 返回 **0**（接受）
- QUIC 连接成功（`cdntask N connect ok <CDN_IP>:443@QUIC`）
- 回调 `onC2CDownloadCompleted(String, C2CDownloadResult)` 触发，**errorCode=0**
- 文件落盘到指定 savePath（JPEG 头正常）

### 2. 三种 fileid 都只拿到缩略图（~4-6KB，497×340 或更小）

**A. XML 模板 DER（cdnbigimgurl 原文，直接用）：**
```
305f020100044b304902010002046ca1d9a602032f578b020456b92b6f02046a71f5bc042462396666326366352d333533312d343832662d393963382d306135646565623535343561020405150a02020100040d004c4dff000000000000000000
```

**B. 微信缩略图下载时的运行时 DER（消息到达微信自动下载缩略图时，hook 抓的）：**
```
305f020100044b304902010002046ca1d9a602032f578b020427b92b6f02046a76dd71042437653331616665352d343735352d346364382d616337302d363138303631643838303839020405152a01020100040d004c4e63000000000000000000
```

**C. 我们手动构造的 DER（A 为基：时间戳→当前 Unix 秒、规格码 150a→152a、尾部 4c4dff→4c4e63，UUID/int A 保留 A 的）：**
```
305f020100044b304902010002046ca1d9a602032f578b020456b92b6f02046a76e0d2042462396666326366352d333533312d343832662d393963382d306135646565623535343561020405152a01020100040d004c4e63000000000000000000
```

**三者都返回缩略图。** 配套 request 字段：aeskey（消息 XML 的）、fileKey=`downimgbig_msginfo_big_<svrId>_<wxid>_250_497`、fileType=3、bizid=1、msgType=1、requestVideoFormat=1、apptype=0、customHeader=`source_format:2`、supportFormats=int[1,2]、savePath=image2 下。

### 3. 字段差异表（A 模板 vs B 微信运行时）

| 偏移(hex字符) | 字段 | A 模板 | B 运行时 | 我们 C 改了没 |
|---|---|---|---|---|
| 28-36 | IPv4 | 6ca1d9a6 | 6ca1d9a6（同） | 否 |
| 40-46 | int(3B) | 2f578b | 2f578b（同） | 否 |
| 50-58 | int A | **56b92b6f** | **27b92b6f** | 否（保留 A） |
| 62-70 | 时间戳 | 6a71f5bc（2026-08-04） | 6a76dd71（2026-08-08 下载瞬间） | 改了（→当前秒） |
| 74-146 | UUID | b9ff2cf5-3531-482f-99c8-0a5deeb5545a | 7e31afe5-4755-4cd8-ac70-618061d88089 | 否（保留 A） |
| 152-156 | 规格码 | 150a | 152a | 改了（→152a） |
| 170-176 | 尾部 | 4c4dff | 4c4e63 | 改了（→4c4e63） |

### 4. 关键新事实
- **微信缩略图下载（B）用的是 152a**——我们改成 152a 后还是缩略图 → **152a = 缩略图规格**，不是原图。
- **原图（用户点开大图）下载时的 fileid 一直没抓到**：hook 到过（customHeader=source_format:2 那次），但 logcat 截断 + 我们 dump 的字段顺序问题，**原图 fileid 的规格码/尾部从未完整拿到**。
- C2DownloadResult 回调显示 fileSize=下载大小（4-6KB）——mars 认为「下载完成」。

## 问 Grok（聚焦，别发散）

1. **152a 是缩略图规格（微信缩略图下载用它），原图规格码是什么？** 微信 C2C 图片的规格体系：150a/152a/153a/154a...？**原图（big/hd）对应哪个值**？尾部 4c4dff/4c4e63/4c4fxx 是否随规格联动？
2. **int A（50-58，56b92b6f vs 27b92b6f）是什么**？它变了但我们保留模板值——如果它是「会话/签名」一部分，保留模板值是否导致 CDN 降级？
3. **UUID 语义**：模板 UUID（消息里的）vs 微信运行时新 UUID——**UUID 是资源 ID（必须匹配消息）还是会话 ID（可任意）**？保留模板 UUID 对不对？
4. **有没有可能「下载规格」根本不看 DER，而是看 request 其他字段**（fileKey 前缀 downimgthumb/downimgbig？downloadMode？fileType？）——**微信下载缩略图时 fileKey=downimgthumb_msginfo_thumb_...，我们用 downimgbig_msginfo_big_...——这个前缀差异重要吗**？
5. **最可靠拿到原图 fileid 的办法**：微信点开大图下载原图时，我们 hook 抓到的 request 里 fileid 应该就是原图规格的完整有效 DER——**请给出「确保抓到微信原图下载 fileid」的 hook/dump 建议**（怎么避免 logcat 截断 + 怎么确认抓到的是原图下载而不是缩略图）。
6. **你的最终判断**：在我们当前证据下，要让主动触发下载拿到原图，最可能的两个突破口是什么？（例：A. 原图规格码 + int A/UUID 全部按运行时模式生成 B. hook 微信的 DER 生成方法 C. 其他）

请直接给可执行的下一步（改什么、试什么、验证什么），不要泛泛而谈。
