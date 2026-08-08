# 微信 8.0.70 CDN 图片下载：DER 生成机制 + 规格码含义——Grok 请给知识

背景：微信 Android Xposed 机器人（8.0.70，全混淆，字符串明文）。我已打通微信 CDN 下载链路（CdnManager 的 `OnJniStartC2CDownload` 调用成功 start=0、QUIC 连接正常、回调正常、文件落盘），但**下载到的始终是缩略图规格（~4KB）而不是原图（~500KB）**。刚发现根因：**微信下载时用的 fileid（ASN.1/DER）是运行时生成的，与消息 XML 里带的 DER 完全不同**。请基于你对微信 CDN 协议的知识回答以下问题。

---

## 已验证事实（可信）

1. 图片消息 XML 含：`aeskey`（32 hex）、`cdnthumburl`/`cdnmidimgurl`/`cdnbigimgurl`（三者 hex 内容相同）、`encryver="1"`、`length`（原图大小）、`md5`、`hevc_mid_size`。
2. XML 里的 CDN URL 是 **hex 编码的 ASN.1/DER**（非 HTTP URL）——内嵌 IPv4 + UUID + 若干 int。
3. **微信自己下载缩略图时（消息到达自动下载）传给 OnJniStartC2CDownload 的 fileid 与 XML 的 DER 不同**——具体对比：

**XML 里的 cdnthumburl（模板）：**
```
305f020100044b304902010002046ca1d9a602032f578b020456b92b6f02046a71f5bc042462396666326366352d333533312d343832662d393963382d306135646565623535343561020405150a02020100040d004c4dff000000000000000000
```

**微信实际下载时的 fileid（运行时生成）：**
```
305f020100044b304902010002046ca1d9a602032f578b020427b92b6f02046a76dd71042437653331616665352d343735352d346364382d616337302d363138303631643838303839020405152a01020100040d004c4e63000000000000000000
```

**差异**：
- UUID 不同：模板 `6239666632666366352d...`（="b9ff2fcf5-3531-482f-99c8-0a5deeb5545a"）vs 运行时 `37653331616665352d...`（="7e31aafe-4755-4cd8-ac70-618061d88089"）——**每次下载新 UUID**？
- 第 5 个 int：模板 `02 04 6a71f5bc` vs 运行时 `02 04 6a76dd71`——疑似时间戳（hex unix 时间？6a71f5bc≈2028-06，6a76dd71 相差几分钟——**是生成时间**？）
- 尾部规格码：模板 `02 04 05 15 0a 02 02 01 00 04 0d 00 4c 4d ff` vs 运行时 `02 04 05 15 2a 02 02 01 00 04 0d 00 4c 4e 63`——**差异在 `15 0a` vs `15 2a` 和 `4c 4d ff` vs `4c 4e 63`**

4. 我用 XML 的 cdnbigimgurl DER 直接下载：`start=0`（mars 接受）、QUIC 连接成功（连的是 CDN IP）、回调 `onC2CDownloadCompleted` errorCode=0、文件落盘——但**只有 ~4KB**（JPEG 头正常，是缩略图尺寸）。**推断：CDN 识别出 DER 无效/降级，返回缩略图规格**。
5. 微信缩略图下载用的 fileid 尾部规格码是 `15 2a`（运行时）——模板是 `15 0a`。
6. CdnManager 有静态工厂 `createC2CDownload(String,String,String,int,String)`、`createC2CDownload` 等；下载走 `OnJniStartC2CDownload(C2CDownloadRequest, DownloadCallback)`；request 字段：aeskey/fileid/fileKey/fileType/bizid/msgType/apptype/customHeader/supportFormats/savePath 等（微信原图下载 customHeader=source_format:2、缩略图 source_format:1 或空）。

## 问 Grok

1. **DER 结构逐字段解析**：`30 5f`（SEQUENCE）、`02 01 00`、`04 4b`（octet string 75 字节）、内嵌 `30 49 02 01 00 02 04 <IP> 02 03 <??> 02 04 <时间戳?> 04 24 <UUID> 02 04 05 <15 0a/15 2a> 02 02 01 00 04 0d 00 <4c 4d ff/4c 4e 63> 00...` ——请解释每个字段含义，特别是：
   - `02 03 2f 57 8b`（第三个 int，0x2f578b）是什么？
   - `02 04 6a76dd71` 是不是 unix 时间戳（hex）？换算成什么时间？
   - 尾部 `15 0a` vs `15 2a`：规格码？thumb/mid/big 分别是什么值？
   - `4c 4d ff` vs `4c 4e 63`：资源类型/版本标识？含义？
2. **微信运行时怎么生成这个 DER**：哪个类/方法负责（8.0.x 历史类名/混淆名家族）？Xposed 开源模块（微X、WechatHook、AstrBot 生态等）里有没有 DER/CDN fileid 生成的参考实现或公开逆向资料？生成逻辑是「换新 UUID + 更新时间戳」还是「整个重算」？
3. **能不能手动构造有效 DER**：把 XML 模板的 DER 改一下（新 UUID、当前时间戳、规格码 15 0a→15 2a）就能下载原图？还是必须 hook 微信的生成方法？
4. **「下载到缩略图」的机制**：CDN 收到模板 DER（15 0a）时返回缩略图规格——是因为规格码（15 0a=thumb）还是因为 UUID 无效？如果我把 XML 的 **cdnbigimgurl** DER 尾部改成 `15 2a` + 新 UUID + 当前时间戳，能否直接下到原图？
5. **时间戳格式**：`6a71f5bc` 是什么编码（unix seconds hex？毫秒？）——换算 2028-06 对吗？（如果它是 2028 年，那它不是「当前时间」而是「过期时间/有效期」？）

请分点回答，每条给「机制解释 + 构造方法 + 验证建议」。这是为了在 Xposed 里主动触发原图下载（不依赖用户点开大图）。
