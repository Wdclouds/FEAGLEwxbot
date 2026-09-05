package io.github.wdclouds.feaglewxbot.agent;

import java.lang.reflect.Method;
import java.util.concurrent.ConcurrentHashMap;

import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;

/**
 * Narrow WeChat 8.0.70 adapter.
 *
 * <p>This class deliberately supports one package version and one feature set:
 * inbound/outbound private text plus inbound/outbound group text. Group events
 * remain fail-closed unless WeChat exposes an explicit mention flag. It does not enumerate DEX
 * classes, read databases, persist chat content, or expose a broadcast/file
 * command channel.</p>
 */
final class Wechat8070Adapter {
    static final String TARGET_VERSION = "8.0.70";

    private static final String MESSAGE_CLASS = "com.tencent.mm.storage.y8";
    private static final String ADD_MSG_CLASS = "com.tencent.mm.modelbase.p0";
    private static final String INSERT_HELPER_CLASS = "ox0.v9";
    private static final String STORAGE_DISPATCHER_CLASS = "xv0.t9";
    private static final String MESSAGE_STORAGE_CLASS = "com.tencent.mm.storage.h8";
    private static final String[] STORAGE_INSERT_METHODS =
            new String[]{"U8", "W8", "na", "ta"};
    private static final String SEND_FACTORY_CLASS = "hz0.r1";

    private Wechat8070Adapter() {
    }

    static void installInbound(ClassLoader classLoader) throws Throwable {
        ADAPTER_CLASSLOADER = classLoader;
        Class<?> messageClass = XposedHelpers.findClass(MESSAGE_CLASS, classLoader);
        Class<?> addMsgClass = XposedHelpers.findClass(ADD_MSG_CLASS, classLoader);
        int installed = 0;
        installed += hookTwoArgMessagePath(
                classLoader,
                INSERT_HELPER_CLASS,
                "n",
                messageClass,
                addMsgClass,
                "storage-helper");
        installed += hookAdditionalStoragePaths(classLoader, messageClass);
        installed += hookTwoArgMessagePath(
                classLoader,
                STORAGE_DISPATCHER_CLASS,
                "n",
                messageClass,
                addMsgClass,
                "storage-dispatcher");
        installed += hookLegacyStoragePaths(classLoader, messageClass);
        installed += hookContactEntity(classLoader);
        installed += hookContactStorage(classLoader);
        installed += hookChatroomStorage(classLoader);
        if (installed == 0) {
            throw new NoSuchMethodException("No documented 8.0.70 inbound path found");
        }
        WechatHook.logAdapterInfo(
                "8.0.70 inbound paths installed=" + installed);
    }

    private static int hookTwoArgMessagePath(
            ClassLoader classLoader,
            String className,
            String methodName,
            Class<?> messageClass,
            Class<?> addMsgClass,
            String source) {
        Class<?> helperClass;
        try {
            helperClass = XposedHelpers.findClass(className, classLoader);
        } catch (Throwable ignored) {
            return 0;
        }
        Method target = null;
        for (Method method : helperClass.getDeclaredMethods()) {
            Class<?>[] parameters = method.getParameterTypes();
            if (!methodName.equals(method.getName()) || parameters.length != 2) {
                continue;
            }
            if (compatible(parameters[0], messageClass)
                    && compatible(parameters[1], addMsgClass)) {
                target = method;
                break;
            }
        }
        if (target == null) {
            return 0;
        }

        target.setAccessible(true);
        XposedBridge.hookMethod(target, new XC_MethodHook() {
            @Override
            protected void afterHookedMethod(MethodHookParam param) {
                // 8.0.70 上 n() 的参数顺序可能为 (p0, y8) 或 (y8, p0)，
                // 两个参数都尝试捕获，由 captureMessage 内部判别。
                for (int i = 0; i < param.args.length && i < 2; i++) {
                    if (param.args[i] != null) {
                        captureMessage(source + "/arg" + i, param.args[i]);
                    }
                }
            }
        });
        return 1;
    }

    /** 诊断（临时，2026-08-04）：Hook SQLCipher/WCDB openDatabase 拿 DB key，
     *  用于本地解密 EnMicroMsg.db 直查消息完整内容（引用文字定位）。 */
    private static int hookAdditionalStoragePaths(
            ClassLoader classLoader, Class<?> messageClass) {
        Class<?> helperClass;
        try {
            helperClass = XposedHelpers.findClass(INSERT_HELPER_CLASS, classLoader);
        } catch (Throwable ignored) {
            return 0;
        }
        int installed = 0;
        for (Method method : helperClass.getDeclaredMethods()) {
            if ("n".equals(method.getName())) {
                continue; // 已有专路
            }
            Class<?>[] ps = method.getParameterTypes();
            if (ps.length == 0) {
                continue;
            }
            boolean relevant = false;
            for (Class<?> p : ps) {
                if (p == messageClass || p == java.util.List.class) {
                    relevant = true;
                    break;
                }
            }
            if (!relevant) {
                continue;
            }
            try {
                method.setAccessible(true);
                XposedBridge.hookMethod(method, new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        Object first = param.args[0];
                        if (first instanceof java.util.List) {
                            for (Object item : (java.util.List<?>) first) {
                                if (item != null && item.getClass().getName()
                                        .equals(MESSAGE_CLASS)) {
                                    captureMessage(
                                            "wechat-8.0.70/extra-list-"
                                                    + method.getName(), item);
                                }
                            }
                        } else if (first != null && first.getClass().getName()
                                .equals(MESSAGE_CLASS)) {
                            captureMessage(
                                    "wechat-8.0.70/extra-"
                                            + method.getName(), first);
                        }
                    }
                });
                installed++;
            } catch (Throwable ignored) {
            }
        }
        return installed;
    }

    private static int hookLegacyStoragePaths(
            ClassLoader classLoader, Class<?> messageClass) {
        Class<?> storageClass;
        try {
            storageClass = XposedHelpers.findClass(
                    MESSAGE_STORAGE_CLASS, classLoader);
        } catch (Throwable ignored) {
            return 0;
        }

        int installed = 0;
        for (Method method : storageClass.getDeclaredMethods()) {
            if (!matchesStorageMethod(method.getName())
                    || method.getParameterTypes().length == 0
                    || !compatible(
                            method.getParameterTypes()[0], messageClass)) {
                continue;
            }
            method.setAccessible(true);
            XposedBridge.hookMethod(method, new XC_MethodHook() {
                @Override
                protected void afterHookedMethod(MethodHookParam param) {
                    captureMessage("message-storage", param.args[0]);
                }
            });
            installed++;
        }
        return installed;
    }

    private static boolean matchesStorageMethod(String name) {
        for (String candidate : STORAGE_INSERT_METHODS) {
            if (candidate.equals(name)) {
                return true;
            }
        }
        return false;
    }

    private static boolean compatible(Class<?> actual, Class<?> expected) {
        return actual.isAssignableFrom(expected)
                || expected.isAssignableFrom(actual);
    }

    private static boolean isGroupTalker(String talker) {
        return talker != null
                && talker.toLowerCase(java.util.Locale.ROOT).endsWith("@chatroom");
    }

    static void sendText(ClassLoader classLoader, String talker, String content)
            throws Throwable {
        Class<?> factory = XposedHelpers.findClass(SEND_FACTORY_CLASS, classLoader);
        Object request = XposedHelpers.callStaticMethod(factory, "a", talker);
        if (request == null) {
            throw new IllegalStateException("8.0.70 send request was null");
        }
        XposedHelpers.callMethod(request, "g", talker);
        XposedHelpers.callMethod(request, "e", content);
        XposedHelpers.callMethod(request, "h", 1);
        XposedHelpers.callMethod(request, "b");
    }

    private static void captureMessage(String source, Object message) {
        if (message == null) {
            return;
        }
        try {
            // 提前装 CdnManager hook（原图抓取用；不依赖 fetchOriginalImage，
            // CdnManager 类未加载时 forName 静默失败，下条消息再试）
            ensureCdnHookEarly(message);
            int type = intFieldOrMethod(message, "field_type", "getType", -1);
            int isSend = intFieldOrMethod(message, "field_isSend", null, -1);
            String talker = stringFieldOrMethods(
                    message,
                    "field_talker",
                    new String[]{"P0", "getTalker", "E0", "L0"});
            String content = stringFieldOrMethods(
                    message,
                    "field_content",
                    new String[]{"j", "getContent", "S1", "W0"});
            long createTime = longFieldOrMethod(
                    message, "field_createTime", "getCreateTime", 0L);
            long msgId = longFieldOrMethod(
                    message, "field_msgId", "getMsgId", 0L);
            long msgSvrId = longFieldOrMethod(
                    message, "field_msgSvrId", null, 0L);
            boolean mentioned = booleanFieldOrMethod(
                    message, "field_isAt", "isAt", false);
            // 8.0.70 混淆后 field_isAt/isAt 常读不到。群聊被 @ 时 content
            // 形如 "发送者wxid:\n@昵称 内容"，冒号后的正文以 '@' 开头即视为被 @。
            if (!mentioned && isGroupTalker(talker) && content != null) {
                String body = content;
                int sep = body.indexOf(":\n");
                if (sep >= 0) {
                    body = body.substring(sep + 2);
                }
                body = body.trim();
                mentioned = body.startsWith("@");
            }

            WechatHook.captureTextFields(
                    "wechat-8.0.70/" + source,
                    type,
                    isSend,
                    talker,
                    content,
                    createTime,
                    msgId,
                    msgSvrId,
                    mentioned,
                    0L);
            // ── 引用消息解析（2026-08-05 实测定案）──
            // type=822083633（0x31000031，低字节 49=appmsg），content =
            // "发送者wxid:\n<?xml...<appmsg><title>用户文字</title>...
            // <refermsg><svrid>被引用图msgSvrId</svrid>...</refermsg>"
            // 用户文字在 <title>，被引用图在 <refermsg><svrid>。
            if ((type & 0xFF) == 49 && content != null
                    && content.contains("<refermsg>")) {
                String title = extractXmlTag(content, "title");
                if (title != null && !title.isEmpty()) {
                    boolean quoteMentioned = title.trim().startsWith("@");
                    long quoteSvrIdLong = 0L;
                    try {
                        String svridStr = extractXmlTag(content, "svrid");
                        if (svridStr != null && !svridStr.isEmpty()) {
                            quoteSvrIdLong = Long.parseLong(svridStr);
                        }
                    } catch (Throwable ignored) {
                    }
                    // 群聊：captureTextFields 的 parseGroupText 要求
                    // "发送者:\n正文" 格式——从 content 前缀提取发送者拼回。
                    String quoteContent = title;
                    if (isGroupTalker(talker)) {
                        String qSender = quoteSender(content);
                        if (qSender != null && !qSender.isEmpty()) {
                            quoteContent = qSender + ":\n" + title;
                        }
                    }
                    WechatHook.captureTextFields(
                            "wechat-8.0.70/" + source + "/quote",
                            1,
                            isSend,
                            talker,
                            quoteContent,
                            createTime,
                            msgId,
                            msgSvrId,
                            quoteMentioned,
                            quoteSvrIdLong);
                    WechatHook.logAdapterInfo(
                            "[QUOTE] title=" + maskId(title)
                            + " mentioned=" + quoteMentioned
                            + " svrid=" + quoteSvrIdLong);
                }
            }
            if (type == 3) {
                // 图片消息：8.0.70 字段名已实测确认（field_imgPath，
                // 值 THUMBNAIL_DIRPATH://th_<32hex>）。
                // 原图链路（2026-08-08 v2）：后台线程尝试 CDN 原图下载
                // （微信构造照抄：adownimg fileKey + fileType=2 +
                //  customHeader 带 msgid），成功用原图，失败退回缩略图。
                String imgPath = stringFieldOrMethods(
                        message,
                        "field_imgPath",
                        new String[]{"field_imgPath", "getImgPath", "imgPath"});
                final Object msgRef = message;
                final String srcTag = "wechat-8.0.70/" + source;
                final String tRef = talker;
                final String cRef = content;
                final long ctRef = createTime;
                final long miRef = msgId;
                final long msRef = msgSvrId;
                final String thumbRef = imgPath;
                Thread origThread = new Thread(() -> {
                    try {
                        java.io.File original = fetchOriginalImage(
                                msgRef, 8_000, "", msRef, cRef);
                        if (original != null && original.isFile()
                                && original.length() > 0) {
                            // wxgf = 微信 HEVC 私有格式（文件头 wxgf），
                            // 微信进程内解码+压缩不可靠（WXGF JNI 破坏 native
                            // 状态，compress/getPixels 实测随机挂起）——
                            // 新链路：读字节 → Agent → 服务器 ffmpeg 解码
                            // （微信进程零像素操作，根治挂起）
                            boolean isWxgf = false;
                            try {
                                byte[] head = new byte[4];
                                java.io.FileInputStream fis =
                                        new java.io.FileInputStream(original);
                                int hr = fis.read(head);
                                fis.close();
                                isWxgf = hr == 4
                                        && head[0] == 'w' && head[1] == 'x'
                                        && head[2] == 'g' && head[3] == 'f';
                            } catch (Throwable ignored) {
                            }
                            if (isWxgf) {
                                WechatHook.logAdapterInfo(
                                        "[ORIG] wxgf detected, server decode");
                                boolean grp = tRef != null
                                        && tRef.toLowerCase(
                                                java.util.Locale.ROOT)
                                                .endsWith("@chatroom");
                                WechatHook.sendWxgfToAgent(
                                        grp ? AgentProtocol.MSG_GROUP_IMAGE
                                                : AgentProtocol.MSG_PRIVATE_IMAGE,
                                        "wxgf:" + msRef, tRef, cRef,
                                        original, ctRef, miRef, msRef);
                                return;
                            }
                            // 非 wxgf（异常情况）——旧链路压缩兜底
                            WechatHook.logAdapterInfo("[ORIG] original ok size="
                                    + original.length());
                            WechatHook.captureImageFromFile(
                                    srcTag, original, tRef, cRef,
                                    ctRef, miRef, msRef);
                        } else {
                            WechatHook.captureImage(
                                    srcTag, thumbRef, tRef, cRef,
                                    ctRef, miRef, msRef);
                        }
                    } catch (Throwable error) {
                        WechatHook.logAdapterError(
                                "[ORIG] fetch thread failed", error);
                        WechatHook.captureImage(
                                srcTag, thumbRef, tRef, cRef,
                                ctRef, miRef, msRef);
                    }
                }, "feagle-orig");
                // 非 daemon（2026-08-08 实测：daemon 线程在低内存平板被饿死，
                // 同步压缩不执行；非 daemon 保证调度——微信进程长驻无碍）
                origThread.setDaemon(false);
                origThread.start();
            }
        } catch (Throwable error) {
            WechatHook.logAdapterError("8.0.70 message capture failed", error);
        }
    }

    /** 手动构造有效 CDN fileid（DER）：以 XML 模板 DER 为基，改
     *  时间戳→当前 Unix 秒、规格码 150a→152a（微信运行时实测值）、
     *  尾部 4c4dff→4c4e63。UUID 保留（本图资源 ID）。
     *  （2026-08-08 实测：微信下载时 DER 与模板仅差这几个字段；
     *   模板时间戳=消息生成时，运行时=下载瞬间——CDN 校验新鲜度） */
    private static String buildFileId(String derHex) {
        if (derHex == null || derHex.length() != 194) {
            return derHex;
        }
        try {
            StringBuilder sb = new StringBuilder(derHex);
            sb.replace(62, 70, String.format("%08x",
                    System.currentTimeMillis() / 1000));
            if (sb.substring(152, 156).equals("150a")) {
                sb.replace(152, 156, "152a");
            }
            if (sb.substring(170, 176).equals("4c4dff")) {
                sb.replace(170, 176, "4c4e63");
            }
            return sb.toString();
        } catch (Throwable ignored) {
            return derHex;
        }
    }

    /** 提取 XML 标签属性值（img 标签的 cdnthumbwidth 等）。 */
    private static String extractXmlAttr(String tag, String attr) {
        if (tag == null || attr == null) {
            return "0";
        }
        try {
            int ai = tag.indexOf(attr + "=\"");
            if (ai >= 0) {
                int aEnd = tag.indexOf('"', ai + attr.length() + 2);
                if (aEnd > ai) {
                    String val = tag.substring(ai + attr.length() + 2, aEnd);
                    if (!val.isEmpty()) {
                        return val;
                    }
                }
            }
        } catch (Throwable ignored) {
        }
        return "0";
    }

    /** 原图落盘路径（学微信）：MicroMsg/<用户32hex>/image2/<前2>/<次2>/<md5>。 */
    private static java.io.File originalTargetFile(String md5) {
        try {
            java.io.File microMsg = new java.io.File(
                    WechatHook.appContext().getFilesDir().getParentFile(),
                    "MicroMsg");
            java.io.File[] userDirs = microMsg.listFiles();
            if (userDirs != null) {
                for (java.io.File userDir : userDirs) {
                    if (userDir.isDirectory()
                            && userDir.getName().matches("^[0-9a-f]{32}$")) {
                        java.io.File d1 = new java.io.File(
                                new java.io.File(userDir, "image2"),
                                md5.substring(0, 2));
                        java.io.File d2 = new java.io.File(
                                d1, md5.substring(2, 4));
                        java.io.File target = new java.io.File(d2, md5);
                        d2.mkdirs();
                        return target;
                    }
                }
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    /** 原图下载（正式实现，2026-08-08）：
     *  b05.c.a(消息对象) → fx4.a ImageInfo（aeskey/URL/md5）
     *  → 构造 CdnManager$C2CDownloadRequest（照抄微信构造）
     *  → OnJniStartC2CDownload 启动 mars::cdn 下载
     *  → 轮询 savePath 落盘文件 → 返回原图文件。
     *  任何一步失败返回 null（调用方退回缩略图）。后台线程执行。 */
    private static java.io.File fetchOriginalImage(
            Object message, long timeoutMs, String senderWxid, long msgSvrId,
            String contentValue) {
        try {
            ClassLoader cl = message.getClass().getClassLoader();
            Class<?> b05c = Class.forName("b05.c", false, cl);
            java.lang.reflect.Method factory = null;
            for (java.lang.reflect.Method m2 : b05c.getDeclaredMethods()) {
                if (m2.getName().equals("a") && m2.getParameterCount() == 1
                        && m2.getReturnType().getName().contains("fx4")) {
                    factory = m2;
                    break;
                }
            }
            if (factory == null) {
                WechatHook.logAdapterInfo("[ORIG] b05.c.a not found");
                return null;
            }
            factory.setAccessible(true);
            Object info = factory.invoke(null, message);
            if (info == null) {
                WechatHook.logAdapterInfo("[ORIG] factory null");
                return null;
            }
            String aeskey = stringGetter(info, "j");
            String bigUrl = stringGetter(info, "q");
            String md5 = stringGetter(info, "x");
            long length = longGetter(info, "getLength");
            if (aeskey == null || bigUrl == null || aeskey.isEmpty()
                    || bigUrl.isEmpty()) {
                WechatHook.logAdapterInfo("[ORIG] missing aeskey/url");
                return null;
            }
            // 去重：同一 md5 在途下载只跑一个（两个 hook 路径各起线程）
            if (md5 != null && !md5.isEmpty()
                    && ORIG_IN_FLIGHT.containsKey(md5)) {
                WechatHook.logAdapterInfo("[ORIG] skip duplicate md5=" + md5);
                return null;
            }
            String[] der = parseDerUrl(bigUrl);
            // 构造下载请求（照抄微信 OnJniStartC2CDownload 的 request 构造，
            // 实测 dump：fileid=DER hex 整体、fileKey=文件名描述符
            // （含 cdnthumbwidth/height 宽高）、savePath=image2 下、
            // host/url 留空（mars 从 fileid 解析 CDN））
            String thumbW = "0";
            String thumbH = "0";
            try {
                if (contentValue != null) {
                    String imgTag2 = "";
                    int imgStart = contentValue.indexOf("<img");
                    int imgEnd = imgStart >= 0
                            ? contentValue.indexOf('>', imgStart) : -1;
                    if (imgEnd > imgStart) {
                        imgTag2 = contentValue.substring(imgStart, imgEnd);
                    }
                    thumbW = extractXmlAttr(imgTag2, "cdnthumbwidth");
                    thumbH = extractXmlAttr(imgTag2, "cdnthumbheight");
                }
            } catch (Throwable ignored) {
            }
            Class<?> cdn = Class.forName(
                    "com.tencent.mars.cdn.CdnManager", false, cl);
            Class<?> reqCls = Class.forName(
                    "com.tencent.mars.cdn.CdnManager$C2CDownloadRequest",
                    false, cl);
            // 优先用微信官方静态工厂 createC2CDownload 构造（自动初始化
            // supportFormats 等默认值），失败退回 new + 手填
            Object req = null;
            // 微信原图下载构造（2026-08-08 实测 dump）：fileKey=adownimg_<hash>_<ts>_<seq>_hevc、
            // fileType=2、customHeader=source_format:1+msgid+source_filesize；
            // 关键：hash 固定 = cf8f8e41a49c1185（两次不同图相同=CDN 会话标识，
            // 随机 hash 会导致 CDN 只返回部分数据 8-80KB，固定 hash 才是完整原图）
            String hash8 = "cf8f8e41a49c1185";
            String fileKey = "adownimg_" + hash8 + "_"
                    + (System.currentTimeMillis() / 1000) + "_1_hevc";
            // savePath 学微信：image2/<前2>/<次2>/<md5>（原图命名，无 th_ 前缀）
            java.io.File target = originalTargetFile(md5);
            String targetPath = target == null ? "" : target.getAbsolutePath();
            // fileid 手动构造：XML 模板 DER + 新时间戳 + 152a 规格码
            String fileid = buildFileId(bigUrl);
            try {
                java.lang.reflect.Method createReq = null;
                for (java.lang.reflect.Method cm : cdn.getDeclaredMethods()) {
                    if (cm.getName().equals("createC2CDownload")
                            && cm.getParameterCount() == 5
                            && java.lang.reflect.Modifier.isStatic(
                                    cm.getModifiers())) {
                        createReq = cm;
                        break;
                    }
                }
                if (createReq != null) {
                    createReq.setAccessible(true);
                    Object created = createReq.invoke(
                            null, bigUrl, fileKey, targetPath, 3, "");
                    if (created != null) {
                        req = created;
                        WechatHook.logAdapterInfo(
                                "[ORIG] req via createC2CDownload factory");
                    }
                }
            } catch (Throwable ignored) {
            }
            if (req == null) {
                req = reqCls.newInstance();
            }
            setStringField(req, "aeskey", aeskey);
            setStringField(req, "fileid", fileid);
            setStringField(req, "fileKey", fileKey);
            setIntField(req, "fileType", 2);
            setIntField(req, "bizid", 1);
            setIntField(req, "certificateVerifyPolicy", 1);
            setIntField(req, "msgType", 1);
            setIntField(req, "requestVideoFormat", 1);
            // 对照微信原图下载 dump：apptype=0 + customHeader 带 msgid
            setIntField(req, "apptype", 0);
            setStringField(req, "customHeader",
                    "source_format:1\r\nmsgid:" + msgSvrId
                            + "\r\nsource_filesize:0");
            // 微信 supportFormats=int[1,2]（实测 dump #1），照抄
            setIntArrayField(req, "supportFormats", new int[]{1, 2});
            if (target != null) {
                setStringField(req, "savePath", targetPath);
            }
            WechatHook.logAdapterInfo("[ORIG] req fileid-len=" + bigUrl.length()
                    + " fileKey=" + fileKey + " savePath="
                    + (target == null ? "null" : target.getAbsolutePath()));
            // 回调：动态代理（接口方法签名未知，拦截打日志 + dump 结果对象）
            ensureCdnHook(cdn);
            Class<?> cbCls = Class.forName(
                    "com.tencent.mars.cdn.CdnManager$DownloadCallback",
                    false, cl);
            Object callback = java.lang.reflect.Proxy.newProxyInstance(
                    cl, new Class<?>[]{cbCls},
                    (proxy, method, args) -> {
                        StringBuilder cbLog = new StringBuilder(
                                "[ORIG-CB] ").append(method.getName()).append('(');
                        if (args != null) {
                            for (int i = 0; i < args.length; i++) {
                                if (i > 0) {
                                    cbLog.append(',');
                                }
                                cbLog.append(args[i] == null ? "null"
                                        : args[i].getClass().getSimpleName());
                            }
                        }
                        cbLog.append(')');
                        WechatHook.logAdapterInfo(cbLog.toString());
                        // 回调结果写文件（C2DownloadResult.fileSize 确认原图）
                        if (args != null) {
                            for (Object arg : args) {
                                if (arg != null) {
                                    try {
                                        writeDumpFile("RESULT "
                                                + method.getName() + ": "
                                                + dumpRequestFields(arg) + "\n");
                                    } catch (Throwable ignored) {
                                    }
                                }
                            }
                        }
                        Class<?> rt = method.getReturnType();
                        if (rt == boolean.class) {
                            return false;
                        }
                        if (rt == int.class) {
                            return 0;
                        }
                        if (rt == long.class) {
                            return 0L;
                        }
                        return null;
                    });
            // 启动下载
            java.lang.reflect.Method start = null;
            for (java.lang.reflect.Method m3 : cdn.getDeclaredMethods()) {
                if (m3.getName().equals("OnJniStartC2CDownload")) {
                    start = m3;
                    break;
                }
            }
            if (start == null) {
                WechatHook.logAdapterInfo("[ORIG] start method not found");
                return null;
            }
            // OnJniStartC2CDownload 是实例方法：反射拿 CdnManager 实例。
            // 1) hook 缓存优先；2) 主动初始化（OnJniCreateCdnManagerFromContext
            // 静态调用）；3) 等微信下载捕获（最多 5s）；4) 静态字段；5) 工厂。
            Object cdnInstance = CDN_INSTANCE;
            if (cdnInstance == null) {
                try {
                    // 静态初始化：微信启动时调用过，若静态可直接再调
                    java.lang.reflect.Method create = null;
                    for (java.lang.reflect.Method cm : cdn.getDeclaredMethods()) {
                        if (cm.getName().equals(
                                "OnJniCreateCdnManagerFromContext")
                                && java.lang.reflect.Modifier.isStatic(
                                        cm.getModifiers())) {
                            create = cm;
                            break;
                        }
                    }
                    if (create != null) {
                        create.setAccessible(true);
                        create.invoke(null,
                                WechatHook.appContext());
                    }
                } catch (Throwable ignored) {
                }
                long instDeadline = System.currentTimeMillis() + 5000;
                while (cdnInstance == null
                        && System.currentTimeMillis() < instDeadline) {
                    try {
                        Thread.sleep(200);
                    } catch (InterruptedException e) {
                        break;
                    }
                    cdnInstance = CDN_INSTANCE;
                }
            }
            if (cdnInstance == null) {
                try {
                    for (java.lang.reflect.Field sf : cdn.getDeclaredFields()) {
                        if (java.lang.reflect.Modifier.isStatic(
                                sf.getModifiers())
                                && cdn.isAssignableFrom(sf.getType())) {
                            sf.setAccessible(true);
                            Object candidate = sf.get(null);
                            if (candidate != null) {
                                cdnInstance = candidate;
                                CDN_INSTANCE = candidate;
                                break;
                            }
                        }
                    }
                } catch (Throwable ignored) {
                }
            }
            if (cdnInstance == null) {
                try {
                    for (java.lang.reflect.Method fm : cdn.getDeclaredMethods()) {
                        if (java.lang.reflect.Modifier.isStatic(
                                fm.getModifiers())
                                && fm.getParameterCount() == 0
                                && cdn.isAssignableFrom(fm.getReturnType())) {
                            fm.setAccessible(true);
                            Object candidate = fm.invoke(null);
                            if (candidate != null) {
                                cdnInstance = candidate;
                                CDN_INSTANCE = candidate;
                                break;
                            }
                        }
                    }
                } catch (Throwable ignored) {
                }
            }
            if (cdnInstance == null) {
                // 单例未找到：dump 静态字段/方法线索（hook 已由 ensureCdnHook 装）
                try {
                    StringBuilder sd = new StringBuilder("[ORIG] static fields:");
                    for (java.lang.reflect.Field sf2 : cdn.getDeclaredFields()) {
                        if (java.lang.reflect.Modifier.isStatic(
                                sf2.getModifiers())) {
                            sd.append(' ').append(sf2.getName()).append(':')
                              .append(sf2.getType().getSimpleName());
                        }
                    }
                    WechatHook.logAdapterInfo(sd.toString());
                    StringBuilder md = new StringBuilder("[ORIG] static methods:");
                    for (java.lang.reflect.Method m4 : cdn.getDeclaredMethods()) {
                        if (java.lang.reflect.Modifier.isStatic(
                                m4.getModifiers())) {
                            md.append(' ').append(m4.getName());
                        }
                    }
                    WechatHook.logAdapterInfo(md.toString());
                } catch (Throwable ignored) {
                }
                return null;
            }
            start.setAccessible(true);
            dumpLog("[ORIG] our req: ", dumpRequestFields(req));
            int startResult = (Integer) start.invoke(
                    cdnInstance, req, callback);
            WechatHook.logAdapterInfo("[ORIG] start=" + startResult
                    + " md5=" + md5 + " len=" + length);
            if (startResult != 0) {
                WechatHook.logAdapterInfo("[ORIG] start failed rc=" + startResult);
                return null;
            }
            if (md5 != null && !md5.isEmpty()) {
                ORIG_IN_FLIGHT.put(md5, System.currentTimeMillis());
            }
            // 轮询落盘：savePath 文件出现且大小接近 expectFileSize 才算完成
            // （mars 边写边落盘，500ms 快照可能抓到半成品——4822 字节教训）
            java.io.File result = pollOriginalFile(target, timeoutMs, length);
            if (md5 != null) {
                ORIG_IN_FLIGHT.remove(md5);
            }
            return result;
        } catch (Throwable error) {
            WechatHook.logAdapterError("[ORIG] fetch failed", error);
            return null;
        }
    }

    /** 请求对象字段值 dump（截断 120 字符/字符串字段，用于对照微信构造）。 */
    private static String dumpRequestFields(Object req) {
        StringBuilder rd = new StringBuilder(8000);
        try {
            for (Class<?> rc = req.getClass();
                    rc != null && rc != Object.class;
                    rc = rc.getSuperclass()) {
                for (java.lang.reflect.Field rf :
                        rc.getDeclaredFields()) {
                    try {
                        rf.setAccessible(true);
                        Object v = rf.get(req);
                        if (v == null) {
                            rd.append(' ').append(rf.getName()).append("=null");
                        } else if (v instanceof byte[]) {
                            rd.append(' ').append(rf.getName())
                              .append("=byte[").append(((byte[]) v).length)
                              .append(']');
                        } else if (v instanceof int[]) {
                            int[] arr = (int[]) v;
                            StringBuilder ab = new StringBuilder("int[");
                            for (int j = 0; j < Math.min(arr.length, 20);
                                    j++) {
                                if (j > 0) {
                                    ab.append(',');
                                }
                                ab.append(arr[j]);
                            }
                            ab.append(']');
                            rd.append(' ').append(rf.getName()).append('=')
                              .append(ab);
                        } else if (v instanceof String) {
                            String s = (String) v;
                            rd.append(' ').append(rf.getName()).append('=').append(
                                    s.length() > 400
                                            ? s.substring(0, 400) + "..."
                                            : s);
                        } else {
                            rd.append(' ').append(rf.getName()).append('=')
                              .append(String.valueOf(v));
                        }
                    } catch (Throwable ignored) {
                    }
                }
            }
        } catch (Throwable ignored) {
        }
        return rd.toString();
    }

    /** 分段打印长 dump（绕 logcat ~4KB 单行截断）。 */
    private static void dumpLog(String tag, String dump) {
        if (dump == null || dump.isEmpty()) {
            return;
        }
        int chunk = 1400;
        if (dump.length() <= chunk) {
            WechatHook.logAdapterInfo(tag + dump);
            return;
        }
        for (int i = 0; i < dump.length(); i += chunk) {
            WechatHook.logAdapterInfo(tag + "[" + i + "]: "
                    + dump.substring(i, Math.min(i + chunk, dump.length())));
        }
    }

    /** 用微信 WXGF 解码器（MMWXGFJNI buffer API）把 wxgf 数据解码成 Bitmap。
     *  wxgf=微信 HEVC 私有图片格式（文件头 wxgf），BitmapFactory 无法解码；
     *  流程照抄微信：nativeInitWxAMDecoder -> nativeDecodeBufferHeader ->
     *  nativeGetOption(宽高) -> nativeDecodeBufferFrame -> nativeUninit。
     *  Codex 建议：MMWXGFJNI 底层可能有全局状态（HEVC context/硬解器），
     *  handle 独立不等于可重入——整个会话串行化（双 hook 并发解码是竞态源）。 */
    private static final Object WXGF_DECODER_LOCK = new Object();

    private static android.graphics.Bitmap decodeWxgfToBitmap(
            java.io.File wxgf) {
        synchronized (WXGF_DECODER_LOCK) {
            return decodeWxgfLocked(wxgf);
        }
    }

    private static android.graphics.Bitmap decodeWxgfLocked(
            java.io.File wxgf) {
        try {
            Class<?> jni = Class.forName(
                    "com.tencent.mm.plugin.gif.MMWXGFJNI", false,
                    WechatHook.appContext().getClassLoader());
            byte[] data = new byte[(int) wxgf.length()];
            java.io.FileInputStream fis =
                    new java.io.FileInputStream(wxgf);
            int off = 0;
            while (off < data.length) {
                int r = fis.read(data, off, data.length - off);
                if (r < 0) {
                    break;
                }
                off += r;
            }
            fis.close();
            java.lang.reflect.Method init = findMethod(jni,
                    "nativeInitWxAMDecoder");
            long handle = (Long) init.invoke(null);
            if (handle == 0) {
                WechatHook.logAdapterInfo("[ORIG] wxgf init=0");
                return null;
            }
            try {
                java.lang.reflect.Method decHeader = findMethod(jni,
                        "nativeDecodeBufferHeader", long.class,
                        byte[].class, int.class);
                int rc1 = (Integer) decHeader.invoke(null,
                        handle, data, data.length);
                java.lang.reflect.Method getOpt = findMethod(jni,
                        "nativeGetOption", long.class,
                        byte[].class, int.class, int[].class);
                int[] opts = new int[16];
                int rc2 = (Integer) getOpt.invoke(null,
                        handle, data, data.length, opts);
                // log opts 全数组（Grok 建议：确认宽高下标位置）
                StringBuilder ob = new StringBuilder(
                        "[ORIG] wxgf opts rc=" + rc2 + ":");
                for (int v : opts) {
                    ob.append(' ').append(v);
                }
                WechatHook.logAdapterInfo(ob.toString());
                // Codex 建议：rc1/rc2 必须为 0，失败即关闭（不再继续）
                if (rc1 != 0 || rc2 != 0) {
                    WechatHook.logAdapterInfo(
                            "[ORIG] wxgf header/opt rc=" + rc1 + "/" + rc2);
                    return null;
                }
                // 实测 opts: [0]=1(格式标志) [1]=宽 [2]=高（2026-08-08 实测
                // 2744x1280）；旧取 opts[0]/[1] 导致 1px 宽 Bitmap + native 卡死
                int w = opts[1];
                int h = opts[2];
                // Codex 建议：宽高异常直接失败关闭（猜尺寸 fallback 不安全，
                // 真实帧更大时按真实 stride 写入小分配会越界）
                if (w <= 0 || h <= 0 || w > 8000 || h > 8000) {
                    WechatHook.logAdapterInfo(
                            "[ORIG] wxgf opts 宽高异常 w=" + w + " h=" + h);
                    return null;
                }
                android.graphics.Bitmap bmp = android.graphics.Bitmap
                        .createBitmap(w, h,
                                android.graphics.Bitmap.Config.ARGB_8888);
                java.lang.reflect.Method decFrame = findMethod(jni,
                        "nativeDecodeBufferFrame", long.class,
                        byte[].class, int.class,
                        android.graphics.Bitmap.class, int[].class);
                int[] outInfo = new int[4];
                int rc3 = (Integer) decFrame.invoke(null,
                        handle, data, data.length, bmp, outInfo);
                WechatHook.logAdapterInfo(
                        "[ORIG] wxgf frame rc=" + rc3 + " out="
                                + outInfo[0] + "," + outInfo[1] + ","
                                + outInfo[2] + "," + outInfo[3]
                                + " bmp=" + w + "x" + h);
                if (rc3 != 0) {
                    return null;
                }
                // 宽高用 opts 值（nativeGetOption 返回），全程不访问 bitmap
                // 方法——2026-08-08 实测 copy 后 getWidth 偶发挂起（微信 native
                // 引用竞争），读取一律用 w/h（opts[1]/opts[2]）
                WXGF_W = w;
                WXGF_H = h;
                // nativeUninit 会释放 Bitmap 的 native 像素（实测坏引用），
                // 必须先 copy 到 Java 内存再返回（2026-08-08 实测修复）
                android.graphics.Bitmap safe = bmp.copy(
                        android.graphics.Bitmap.Config.ARGB_8888, false);
                // 不主动 recycle 原图：实测 recycle 后 safe 的 native 引用
                // 连带释放（isRecycled 误报 → 压缩静默跳过）；靠 GC 回收
                WechatHook.logAdapterInfo(
                        "[ORIG] wxgf copy " + (safe == null ? "null"
                                : w + "x" + h));
                return safe;
            } finally {
                try {
                    findMethod(jni, "nativeUninit", long.class)
                            .invoke(null, handle);
                } catch (Throwable ignored) {
                }
            }
        } catch (Throwable error) {
            WechatHook.logAdapterError(
                    "[ORIG] wxgf decode error", error);
            return null;
        }
    }

    /** 按名字+参数找方法（避免 getMethod 因 private 失败）。 */
    private static java.lang.reflect.Method findMethod(
            Class<?> cls, String name, Class<?>... params) {
        try {
            java.lang.reflect.Method m = cls.getDeclaredMethod(
                    name, params);
            m.setAccessible(true);
            return m;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 读 request 单字段字符串（private 也可）。 */
    private static String dumpFieldString(Object target, String name) {
        java.lang.reflect.Field f = findField(target, name);
        if (f == null) {
            return null;
        }
        try {
            Object v = f.get(target);
            return v == null ? null : String.valueOf(v);
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static volatile int WXGF_W;
    private static volatile int WXGF_H;

    /** 提前装 CdnManager hook（消息入库时尝试，类未加载则等下条消息）。 */
    private static void ensureCdnHookEarly(Object message) {
        if (CDN_HOOK_TRIED) {
            return;
        }
        try {
            Class<?> cdn = Class.forName(
                    "com.tencent.mars.cdn.CdnManager", false,
                    message.getClass().getClassLoader());
            ensureCdnHook(cdn);
        } catch (Throwable ignored) {
        }
        // WXGF 解码器签名 dump（wxgf=微信 HEVC 私有格式，
        // nativeWxam2PicBuf JNI 解码；写文件避免截断）
        try {
            Class<?> wxgfJni = Class.forName(
                    "com.tencent.mm.plugin.gif.MMWXGFJNI", false,
                    message.getClass().getClassLoader());
            StringBuilder wb = new StringBuilder("WXGFJNI ");
            for (java.lang.reflect.Method m :
                    wxgfJni.getDeclaredMethods()) {
                wb.append('\n').append(
                        java.lang.reflect.Modifier.toString(
                                m.getModifiers())).append(' ')
                  .append(m.getName()).append('(');
                Class<?>[] pts = m.getParameterTypes();
                for (int i = 0; i < pts.length; i++) {
                    if (i > 0) {
                        wb.append(", ");
                    }
                    wb.append(pts[i].getName());
                }
                wb.append(") -> ").append(
                        m.getReturnType().getName());
            }
            writeDumpFile(wb.append('\n').toString());
            WechatHook.logAdapterInfo(
                    "[ORIG] wxgf jni dumped");
        } catch (Throwable ignored) {
            WechatHook.logAdapterInfo(
                    "[ORIG] wxgf jni not found");
        }
    }

    /** 写 dump 文件（logcat 有 ~4KB 截断，Grok 建议写文件抓完整 request）。 */
    private static void writeDumpFile(String content) {
        try {
            java.io.File f = new java.io.File(
                    WechatHook.appContext().getCacheDir(), "wx_orig_dump.txt");
            java.io.FileWriter w = new java.io.FileWriter(f, true);
            w.write(content);
            w.close();
        } catch (Throwable ignored) {
        }
    }

    /** 一次性安装 CdnManager 实例捕获 hook（所有实例方法，微信任何下载
     *  都触发捕获；OnJniStartC2CDownload 额外 dump 微信 request 构造一次）。 */
    private static void ensureCdnHook(Class<?> cdn) {
        if (CDN_HOOK_TRIED) {
            return;
        }
        synchronized (Wechat8070Adapter.class) {
            if (CDN_HOOK_TRIED) {
                return;
            }
            CDN_HOOK_TRIED = true;
            int hooked = 0;
            for (java.lang.reflect.Method hm : cdn.getDeclaredMethods()) {
                if (java.lang.reflect.Modifier.isStatic(hm.getModifiers())) {
                    continue;
                }
                try {
                    XposedBridge.hookMethod(hm, new XC_MethodHook() {
                        @Override
                        protected void beforeHookedMethod(
                                MethodHookParam param) {
                            if (param.thisObject != null) {
                                CDN_INSTANCE = param.thisObject;
                            }                            // dump 微信自己的下载请求：写文件（绕 logcat 截断），
                            // 判定原图请求（fileKey 含 downimgbig 或
                            // customHeader 含 source_format:2）优先完整记录
                            if (!"OnJniStartC2CDownload".equals(
                                    param.method.getName())
                                    || "feagle-orig".equals(
                                            Thread.currentThread().getName())
                                    || param.args == null
                                    || param.args.length == 0) {
                                return;
                            }
                            try {
                                Object req = param.args[0];
                                String fk = dumpFieldString(req, "fileKey");
                                String ch = dumpFieldString(req, "customHeader");
                                // 原图请求判定（实测：微信原图下载 fileKey=
                                // adownimg_... 或 customHeader 含 msgid:）
                                boolean isOrig = (fk != null
                                        && fk.contains("adownimg"))
                                        || (ch != null
                                        && ch.contains("msgid:"));
                                if (isOrig || CDN_REQ_DUMP_COUNT < 3) {
                                    CDN_REQ_DUMP_COUNT++;
                                    StringBuilder rd = new StringBuilder(
                                            "=== ").append(isOrig
                                                    ? "ORIG" : "OTHER")
                                              .append(" #")
                                              .append(CDN_REQ_DUMP_COUNT)
                                              .append(' ').append(
                                                      System.currentTimeMillis())
                                              .append(" ===\n");
                                    rd.append(dumpRequestFields(req))
                                      .append('\n');
                                    // 调用栈（定位微信原图下载入口方法）
                                    if (isOrig) {
                                        StackTraceElement[] st =
                                                Thread.currentThread()
                                                        .getStackTrace();
                                        rd.append("STACK:\n");
                                        for (int i = 3;
                                                i < Math.min(st.length, 20);
                                                i++) {
                                            rd.append("  ").append(st[i])
                                              .append('\n');
                                        }
                                    }
                                    writeDumpFile(rd.toString());
                                    WechatHook.logAdapterInfo(
                                            "[ORIG] wx req #" + CDN_REQ_DUMP_COUNT
                                                    + (isOrig ? " ORIG" : "")
                                                    + " -> file");
                                }
                            } catch (Throwable ignored) {
                            }
                        }
                    });
                    hooked++;
                } catch (Throwable ignored) {
                }
            }
            WechatHook.logAdapterInfo("[ORIG] cdn hooks installed=" + hooked);
            // hook 微信 CDN request 构造（modelcdntran.l1.t，调用栈实测），
            // after 拿微信生成的完整 request（fileKey 含真实 adownimg hash）
            try {
                Class<?> l1 = Class.forName(
                        "com.tencent.mm.modelcdntran.l1", false,
                        WechatHook.appContext().getClassLoader());
                XposedBridge.hookAllMethods(l1, "t", new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(
                            MethodHookParam param) {
                        try {
                            StringBuilder rb = new StringBuilder("L1T ");
                            if (param.args != null) {
                                for (Object a : param.args) {
                                    if (a != null) {
                                        rb.append('[').append(
                                                a.getClass().getSimpleName())
                                          .append("] ");
                                    }
                                }
                            }
                            if (param.getResult() != null) {
                                rb.append("=> ")
                                  .append(param.getResult()
                                          .getClass().getSimpleName())
                                  .append(' ')
                                  .append(param.getResult());
                            }
                            writeDumpFile(rb.append('\n').toString());
                            WechatHook.logAdapterInfo("[ORIG] l1.t -> file");
                        } catch (Throwable ignored) {
                        }
                    }
                });
                WechatHook.logAdapterInfo("[ORIG] l1.t hooked");
            } catch (Throwable ignored) {
                WechatHook.logAdapterInfo("[ORIG] l1.t hook failed");
            }
        }
    }

    private static java.io.File pollOriginalFile(
            java.io.File target, long timeoutMs, long expectSize) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        // 阈值：≥10% 或 ≥15KB 尽快返回；超时后只要有 >10KB 文件就用
        // （实测 CDN 对大图只给 59-75KB wxgf，10% 阈值对大图太苛刻；
        //  wxgf 是 HEVC 压缩，解码后分辨率由内容决定）
        long threshold = Math.max(expectSize / 10L, 15_000L);
        while (System.currentTimeMillis() < deadline) {
            if (target.isFile() && target.length() >= threshold) {
                return target;
            }
            try {
                Thread.sleep(500);
            } catch (InterruptedException ignored) {
                return null;
            }
        }
        if (target.isFile() && target.length() > 10_000) {
            return target;
        }
        return null;
    }

    /** 在 image2/<前2>/<次2>/ 下找 <md5> 命名的文件（无 th_ 前缀=原图/中图）。 */
    private static java.io.File findMd5File(
            java.io.File microMsg, String md5) {
        if (microMsg == null || !microMsg.isDirectory() || md5 == null
                || md5.length() != 32) {
            return null;
        }
        java.io.File[] userDirs = microMsg.listFiles();
        if (userDirs == null) {
            return null;
        }
        for (java.io.File userDir : userDirs) {
            if (!userDir.isDirectory()
                    || !userDir.getName().matches("^[0-9a-f]{32}$")) {
                continue;
            }
            java.io.File image2 = new java.io.File(userDir, "image2");
            java.io.File[] d1 = image2.listFiles();
            if (d1 == null) {
                continue;
            }
            for (java.io.File f1 : d1) {
                if (!f1.isDirectory() || f1.getName().startsWith(".")) {
                    continue;
                }
                java.io.File[] d2 = f1.listFiles();
                if (d2 == null) {
                    continue;
                }
                for (java.io.File f2 : d2) {
                    if (!f2.isDirectory()) {
                        continue;
                    }
                    java.io.File cand = new java.io.File(f2, md5);
                    if (cand.isFile() && cand.length() > 0) {
                        return cand;
                    }
                }
            }
        }
        return null;
    }

    private static final java.util.regex.Pattern DER_UUID =
            java.util.regex.Pattern.compile(
                    "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
                            + "[0-9a-f]{4}-[0-9a-f]{12}");

    /** CdnManager 实例缓存：优先用 hook 捕获（微信下载时必调实例方法）。 */
    private static volatile Object CDN_INSTANCE;
    private static volatile boolean CDN_HOOK_TRIED;
    private static volatile int CDN_REQ_DUMP_COUNT;

    /** 在途原图下载去重（md5 → 开始时间戳；两个 hook 路径会各起一个线程）。 */
    private static final java.util.Map<String, Long> ORIG_IN_FLIGHT =
            new ConcurrentHashMap<>();

    /** 解析 DER hex 里的 UUID + IPv4（微信 CDN 定位信息）。 */
    private static String[] parseDerUrl(String derHex) {
        String[] result = new String[]{"", ""};
        try {
            byte[] raw = hexDecode(derHex);
            String latin = new String(raw,
                    java.nio.charset.StandardCharsets.ISO_8859_1);
            java.util.regex.Matcher m = DER_UUID.matcher(latin);
            if (m.find()) {
                result[0] = m.group();
            }
            for (int i = 0; i + 5 < raw.length; i++) {
                if (raw[i] == 0x02 && raw[i + 1] == 0x04) {
                    result[1] = (raw[i + 2] & 0xFF) + "."
                            + (raw[i + 3] & 0xFF) + "."
                            + (raw[i + 4] & 0xFF) + "."
                            + (raw[i + 5] & 0xFF);
                    break;
                }
            }
        } catch (Throwable ignored) {
        }
        return result;
    }

    private static byte[] hexDecode(String hex) {
        int len = hex.length();
        byte[] out = new byte[len / 2];
        for (int i = 0; i < len; i += 2) {
            out[i / 2] = (byte) Integer.parseInt(
                    hex.substring(i, i + 2), 16);
        }
        return out;
    }

    private static String stringGetter(Object target, String name) {
        try {
            java.lang.reflect.Method m = target.getClass().getMethod(name);
            Object v = m.invoke(target);
            return v == null ? null : String.valueOf(v);
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static long longGetter(Object target, String name) {
        try {
            java.lang.reflect.Method m = target.getClass().getMethod(name);
            Object v = m.invoke(target);
            return v instanceof Number ? ((Number) v).longValue() : 0L;
        } catch (Throwable ignored) {
            return 0L;
        }
    }

    /** 设置字段（private 也可：declared 遍历 + setAccessible）。
     *  实测：savePath 等字段非 public，getField 会静默失败（-20003 根因之一）。 */
    private static void setStringField(Object target, String name, String value) {
        java.lang.reflect.Field f = findField(target, name);
        if (f == null) {
            return;
        }
        try {
            f.set(target, value);
        } catch (Throwable ignored) {
        }
    }

    private static void setLongField(Object target, String name, long value) {
        java.lang.reflect.Field f = findField(target, name);
        if (f == null) {
            return;
        }
        try {
            f.set(target, value);
        } catch (Throwable ignored) {
        }
    }

    private static void setIntField(Object target, String name, int value) {
        java.lang.reflect.Field f = findField(target, name);
        if (f == null) {
            return;
        }
        try {
            f.set(target, value);
        } catch (Throwable ignored) {
        }
    }

    private static void setIntArrayField(
            Object target, String name, int[] value) {
        java.lang.reflect.Field f = findField(target, name);
        if (f == null) {
            return;
        }
        try {
            f.set(target, value);
        } catch (Throwable ignored) {
        }
    }

    /** 沿继承链找字段（declared），setAccessible 后返回。 */
    private static java.lang.reflect.Field findField(Object target, String name) {
        for (Class<?> c = target.getClass(); c != null && c != Object.class;
                c = c.getSuperclass()) {
            try {
                java.lang.reflect.Field f = c.getDeclaredField(name);
                f.setAccessible(true);
                return f;
            } catch (NoSuchFieldException ignored) {
            } catch (Throwable ignored) {
            }
        }
        return null;
    }

    /** 回调结果对象 dump（截断 80 字符/字段，防日志爆炸）。 */
    private static String previewFieldDump(Object target) {
        StringBuilder sb = new StringBuilder(400);
        sb.append(target.getClass().getSimpleName()).append('{');
        try {
            for (java.lang.reflect.Field f :
                    target.getClass().getDeclaredFields()) {
                try {
                    f.setAccessible(true);
                    Object v = f.get(target);
                    sb.append(f.getName()).append('=');
                    if (v == null) {
                        sb.append("null");
                    } else if (v instanceof byte[]) {
                        sb.append("byte[").append(((byte[]) v).length).append(']');
                    } else {
                        String s = String.valueOf(v);
                        sb.append(s.length() > 80
                                ? s.substring(0, 80) + "..." : s);
                    }
                    sb.append(' ');
                } catch (Throwable ignored) {
                }
            }
        } catch (Throwable ignored) {
        }
        return sb.append('}').toString();
    }

    /** 群名缓存（talker → field_nickname），由 Contact getter hook 填充。 */
    private static final java.util.Map<String, String> GROUP_NAME_CACHE =
            new ConcurrentHashMap<>();

    /** 查询群名（未缓存返回 null，Bridge 侧 fallback 占位名）。 */
    static String groupNameFor(String talker) {
        if (talker == null) {
            return null;
        }
        return GROUP_NAME_CACHE.get(talker);
    }

    /** Hook Contact 实体（pl.f2 = rcontact 表）的 getter 方法：微信渲染会话列表
     *  必然调用，捕获实例缓存群名（field_nickname）与全量联系人（快照用）。 */
    private static int hookContactEntity(ClassLoader classLoader) {
        try {
            Class<?> contactClass = XposedHelpers.findClass("pl.f2", classLoader);
            XC_MethodHook cacheHook = new XC_MethodHook() {
                @Override
                protected void afterHookedMethod(MethodHookParam param) {
                    try {
                        Object contact = param.thisObject;
                        String username = (String) XposedHelpers
                                .getObjectField(contact, "field_username");
                        if (username == null || username.isEmpty()) {
                            return;
                        }
                        Object nickname = XposedHelpers.getObjectField(
                                contact, "field_nickname");
                        String nicknameValue = nickname instanceof String
                                ? (String) nickname : "";
                        if (username.toLowerCase(java.util.Locale.ROOT)
                                .endsWith("@chatroom")
                                && !nicknameValue.isEmpty()) {
                            GROUP_NAME_CACHE.put(username, nicknameValue);
                        }
                        Object conRemark = XposedHelpers.getObjectField(
                                contact, "field_conRemark");
                        cacheContact(username, nicknameValue,
                                conRemark instanceof String
                                        ? (String) conRemark : "");
                    } catch (Throwable ignored) {
                    }
                }
            };
            int hooked = 0;
            for (Method method : contactClass.getDeclaredMethods()) {
                if (method.getParameterTypes().length == 0
                        && method.getReturnType() == String.class) {
                    try {
                        method.setAccessible(true);
                        XposedBridge.hookMethod(method, cacheHook);
                        hooked++;
                    } catch (Throwable ignored) {
                    }
                }
            }
            try {
                XposedBridge.hookAllConstructors(contactClass, cacheHook);
            } catch (Throwable ignored) {
            }
            WechatHook.logAdapterInfo(
                    "8.0.70 contact entity hook installed getters=" + hooked);
            return hooked > 0 ? 1 : 0;
        } catch (Throwable ignored) {
            return 0;
        }
    }

    /** 联系人快照缓存条目（Hook 观测到的 Contact 实体快照）。 */
    static final class ContactEntry {
        String nickname;
        String conRemark;
        long lastSeenAt;
    }

    /** 全量联系人缓存（talker → 观测快照）。由 pl.f2 getter hook 填充，
     *  只包含微信实际渲染过的联系人——快照语义为「Hook 观测集」，非数据库枚举。 */
    private static final java.util.Map<String, ContactEntry> CONTACT_CACHE =
            new ConcurrentHashMap<>();
    private static final int CONTACT_CACHE_MAX = 2000;
    private static volatile int contactCachePuts;

    private static void cacheContact(String talker, String nickname, String conRemark) {
        ContactEntry entry = new ContactEntry();
        entry.nickname = nickname == null ? "" : nickname;
        entry.conRemark = conRemark == null ? "" : conRemark;
        entry.lastSeenAt = System.currentTimeMillis();
        CONTACT_CACHE.put(talker, entry);
        if (++contactCachePuts % 50 == 0) {
            trimContactCache();
        }
    }

    /** 缓存超限时按最近渲染时间淘汰最旧条目（观察集有界，防泄漏）。 */
    private static void trimContactCache() {
        if (CONTACT_CACHE.size() <= CONTACT_CACHE_MAX) {
            return;
        }
        java.util.List<java.util.Map.Entry<String, ContactEntry>> entries =
                new java.util.ArrayList<>(CONTACT_CACHE.entrySet());
        entries.sort(java.util.Comparator.comparingLong(
                (java.util.Map.Entry<String, ContactEntry> e) -> e.getValue().lastSeenAt));
        int excess = entries.size() - CONTACT_CACHE_MAX;
        for (int i = 0; i < excess; i++) {
            CONTACT_CACHE.remove(entries.get(i).getKey());
        }
    }

    /** 私聊快照合法性：过滤公众号/系统账号/文件传输助手/无效 talker/机器人自己。 */
    private static boolean validSnapshotPrivate(String talker, String ownWxid) {
        if (talker == null) {
            return false;
        }
        String lower = talker.toLowerCase(java.util.Locale.ROOT);
        if (lower.isEmpty() || lower.length() > 256) {
            return false;
        }
        if (lower.endsWith("@chatroom") || lower.endsWith("@openim")) {
            return false;
        }
        if (lower.startsWith("gh_")) {
            return false; // 公众号
        }
        if (lower.equals("filehelper") || lower.equals("newsapp")
                || lower.equals("fmessage") || lower.equals("weixin")) {
            return false; // 系统账号/文件传输助手
        }
        if (lower.contains(":")) {
            return false; // 无效 talker（notify:/群 ID 冒号等）
        }
        if (ownWxid != null && !ownWxid.isEmpty()
                && lower.equals(ownWxid.toLowerCase(java.util.Locale.ROOT))) {
            return false; // 机器人自己
        }
        return true;
    }

    private static boolean validSnapshotGroup(String talker) {
        if (talker == null) {
            return false;
        }
        String lower = talker.toLowerCase(java.util.Locale.ROOT);
        return lower.endsWith("@chatroom")
                && !lower.contains(":")
                && lower.length() <= 256;
    }

    private static String limitedName(String value, String fallback) {
        String normalized = value == null ? "" : value.replaceAll("\\s+", " ").trim();
        if (normalized.isEmpty()) {
            normalized = fallback;
        }
        return normalized.length() > 80 ? normalized.substring(0, 80) : normalized;
    }

    /** 快照构建结果：JSON 载荷 + 完整性标记（full）。 */
    static final class SnapshotBuildResult {
        final String json;
        final boolean full;

        SnapshotBuildResult(String json, boolean full) {
            this.json = json;
            this.full = full;
        }
    }

    /** 枚举结果行（rcontact 快照）。 */
    private static final class ContactRow {
        String talker;
        String nickname;
        String conRemark;
    }

    /** Adapter 运行时的微信 ClassLoader（installInbound 时记录）。 */
    private static volatile ClassLoader ADAPTER_CLASSLOADER;

    /** 联系人存储单例（com.tencent.mm.storage.d4），hook 捕获或服务定位获取。 */
    private static volatile Object CONTACT_STORAGE;

    /** Hook ContactStorage（com.tencent.mm.storage.d4）全部方法捕获实例：
     *  微信渲染会话/消息时必然查询联系人，捕获后 refresh 可直接主动枚举。 */
    private static int hookContactStorage(ClassLoader classLoader) {
        try {
            Class<?> storageClass = XposedHelpers.findClass(
                    "com.tencent.mm.storage.d4", classLoader);
            XC_MethodHook capture = new XC_MethodHook() {
                @Override
                protected void afterHookedMethod(MethodHookParam param) {
                    if (param.thisObject != null) {
                        CONTACT_STORAGE = param.thisObject;
                    }
                }
            };
            int hooked = 0;
            for (Method method : storageClass.getDeclaredMethods()) {
                try {
                    method.setAccessible(true);
                    XposedBridge.hookMethod(method, capture);
                    hooked++;
                } catch (Throwable ignored) {
                }
            }
            WechatHook.logAdapterInfo(
                    "8.0.70 contact storage hook installed methods=" + hooked);
            return hooked > 0 ? 1 : 0;
        } catch (Throwable ignored) {
            return 0;
        }
    }

    /** ChatroomStorage（com.tencent.mm.storage.u2，classes9.dex）——群成员关系
     *  权威存储（chatroom 表）。hook 捕获实例：构造需 f35/i0 DAO 注入（无法无参
     *  new），微信渲染群资料/处理群消息时必然查询 chatroom 表。 */
    private static volatile Object CHATROOM_STORAGE;

    /** Hook ChatroomStorage 全部方法捕获实例（与 hookContactStorage 同模式）。 */
    private static int hookChatroomStorage(ClassLoader classLoader) {
        try {
            Class<?> storageClass = XposedHelpers.findClass(
                    "com.tencent.mm.storage.u2", classLoader);
            XC_MethodHook capture = new XC_MethodHook() {
                @Override
                protected void afterHookedMethod(MethodHookParam param) {
                    if (param.thisObject != null) {
                        CHATROOM_STORAGE = param.thisObject;
                    }
                }
            };
            int hooked = 0;
            for (Method method : storageClass.getDeclaredMethods()) {
                try {
                    method.setAccessible(true);
                    XposedBridge.hookMethod(method, capture);
                    hooked++;
                } catch (Throwable ignored) {
                }
            }
            WechatHook.logAdapterInfo(
                    "8.0.70 chatroom storage hook installed methods=" + hooked);
            return hooked > 0 ? 1 : 0;
        } catch (Throwable ignored) {
            return 0;
        }
    }

    /** ChatroomStorage 实例（hook 捕获；无 DAO 无法自行构造）。 */
    private static Object resolveChatroomStorage() {
        return CHATROOM_STORAGE;
    }

    /** 服务定位：yj0.j1.s(sc3.x3) → h2 → Tg() → ContactStorage（d4）。
     *  优先用 hook 捕获的实例（微信启动后必然查询联系人）。 */
    private static Object resolveContactStorage() {
        Object cached = CONTACT_STORAGE;
        if (cached != null) {
            return cached;
        }
        ClassLoader cl = ADAPTER_CLASSLOADER;
        if (cl == null) {
            return null;
        }
        try {
            Class<?> locator = XposedHelpers.findClass("yj0.j1", cl);
            Class<?> key = XposedHelpers.findClass("sc3.x3", cl);
            Method s = null;
            for (Method m : locator.getDeclaredMethods()) {
                if ("s".equals(m.getName())
                        && m.getParameterTypes().length == 1
                        && m.getParameterTypes()[0] == Class.class) {
                    s = m;
                    break;
                }
            }
            if (s == null) {
                return null;
            }
            s.setAccessible(true);
            Object service = s.invoke(null, key);
            if (service == null) {
                return null;
            }
            Object storage = XposedHelpers.callMethod(service, "Tg");
            if (storage != null) {
                CONTACT_STORAGE = storage;
            }
            return storage;
        } catch (Throwable ignored) {
            return null;
        }
    }

    /** 静默联系人快照 v3（2026-08-13）：主动枚举微信通讯录。
     *  数据源 = ContactStorage（com.tencent.mm.storage.d4）两条权威查询：
     *  群聊 d4.r()：SELECT ... FROM rcontact WHERE type & 8=0 AND username LIKE '%@chatroom'
     *  私聊 d4.J(1,false)：SELECT ... WHERE (type & 1!=0) AND type & 32=0 AND type >= 1
     *  deleteFlag!=0 的软删除行跳过——这是「当前有效联系人」。
     *  ⚠️ rcontact 行 ≠ 「仍在群内」：真机实测已退群群（58483015293@chatroom）
     *  type=2 deleteFlag=0 chatroomFlag=0 仍存在于 rcontact。群必须再过权威判据：
     *  chatroom 表行存在（ChatroomStorage.u2.i1 非 null）且 memberlist 含自己 wxid
     *  （u2.o1 成员列表）——退群时微信调 u2.h1（delete from chatroom where
     *  chatroomname=?）删除本地行。判定失败/实例不可得 → full=false（不冒险删数据）。
     *  不发送消息、不切界面、不重连。 */
    static SnapshotBuildResult buildContactsSnapshot(
            boolean includeAvatars, String ownWxid) {
        final int avatarBudget = 600_000; // Binder ~1MB 限制内留余量
        java.util.List<ContactRow> enumerated = new java.util.ArrayList<>();
        java.util.List<ContactRow> groupRows = new java.util.ArrayList<>();
        boolean storageOk = false;
        boolean groupsComplete = false;
        boolean privatesComplete = false;
        boolean membershipVerified = false;
        try {
            Object storage = resolveContactStorage();
            if (storage != null) {
                storageOk = true;
                // 群聊（type & 8=0 AND username LIKE '%@chatroom'）
                groupsComplete = fillFromCursor(
                        (android.database.Cursor) XposedHelpers.callMethod(
                                storage, "r"),
                        groupRows, true);
                // 私聊通讯录（type & 1!=0 AND type & 32=0 AND type >= 1）
                privatesComplete = fillFromCursor(
                        (android.database.Cursor) XposedHelpers.callMethod(
                                storage, "J", 1, false),
                        enumerated, false);
                // 权威群成员判据：chatroom 行存在 + memberlist 含自己
                Object chatroomStorage = resolveChatroomStorage();
                if (chatroomStorage != null) {
                    membershipVerified = filterActiveGroups(
                            chatroomStorage, groupRows, ownWxid);
                } else {
                    WechatHook.logAdapterInfo(
                            "contacts membership check unavailable"
                                    + " — chatroom storage not captured, full=false");
                }
                enumerated.addAll(groupRows);
            }
        } catch (Throwable error) {
            enumerated.clear();
            storageOk = false;
            groupsComplete = false;
            privatesComplete = false;
            membershipVerified = false;
            WechatHook.logAdapterError("contacts enumeration failed", error);
        }
        boolean complete = storageOk && groupsComplete && privatesComplete
                && membershipVerified;
        // 完整性保护：两条枚举都成功但结果为空、观测缓存却非空 → 可疑空结果，full=false
        if (complete && enumerated.isEmpty() && !CONTACT_CACHE.isEmpty()) {
            complete = false;
            WechatHook.logAdapterInfo(
                    "contacts enumeration empty but observed cache populated — full=false");
        }
        if (!complete) {
            WechatHook.logAdapterInfo(
                    "contacts snapshot incomplete full=false groups=" + groupsComplete
                            + " privates=" + privatesComplete
                            + " membership=" + membershipVerified);
        }
        return buildSnapshotJson(
                complete ? enumerated : null,
                includeAvatars, ownWxid, complete, avatarBudget);
    }

    /** 权威群成员过滤（rcontact 群 ∩ chatroom 表权威记录）：
     *  仅保留 chatroom 行存在且 memberlist 含自己 wxid 的群。
     *  任一群判定异常 → 整体判定失败（抛错，调用方置 full=false，
     *  绝不以未验证的过滤规则上报完整快照）。 */
    private static boolean filterActiveGroups(
            Object chatroomStorage,
            java.util.List<ContactRow> groupRows, String ownWxid) {
        java.util.List<ContactRow> active = new java.util.ArrayList<>();
        for (ContactRow row : groupRows) {
            if (isActiveChatroomMember(chatroomStorage, row.talker, ownWxid)) {
                active.add(row);
            }
        }
        groupRows.clear();
        groupRows.addAll(active);
        return true;
    }

    /** 权威群成员判据（8.0.70 逆向定案，dexdump 静态定位）：
     *  ① u2.i1(talker) → Chatroom 实体，chatroom 表无行返回 null；
     *  ② u2.o1(talker) → memberlist（";" 分隔 wxid）拆分的成员列表，必须含自己。
     *  只调用只读查询（i1/o1 内部 select，无副作用）；h1(删除)/n1(更新)/O1(写)
     *  绝不调用。 */
    private static boolean isActiveChatroomMember(
            Object storage, String talker, String ownWxid) {
        boolean exists;
        boolean hasSelf = false;
        try {
            Object chatroom = XposedHelpers.callMethod(storage, "i1", talker);
            exists = chatroom != null;
            if (exists && ownWxid != null && !ownWxid.isEmpty()) {
                Object members = XposedHelpers.callMethod(storage, "o1", talker);
                if (members instanceof java.util.List) {
                    hasSelf = ((java.util.List<?>) members).contains(ownWxid);
                }
            }
        } catch (Throwable error) {
            throw error instanceof RuntimeException
                    ? (RuntimeException) error : new IllegalStateException(error);
        }
        return exists && hasSelf;
    }

    /** 遍历游标收集联系人行（deleteFlag!=0 跳过）；游标非空且完整遍历 → true。
     *  onlyGroups=true 只收 @chatroom 群行，false 只收个人行（群行交给权威判据）。 */
    private static boolean fillFromCursor(
            android.database.Cursor cursor,
            java.util.List<ContactRow> out,
            boolean onlyGroups) {
        if (cursor == null) {
            return false;
        }
        try {
            int usernameIdx = cursor.getColumnIndex("username");
            int nicknameIdx = cursor.getColumnIndex("nickname");
            int conRemarkIdx = cursor.getColumnIndex("conRemark");
            int deleteFlagIdx = cursor.getColumnIndex("deleteFlag");
            if (usernameIdx < 0) {
                return false;
            }
            if (cursor.moveToFirst()) {
                do {
                    if (deleteFlagIdx >= 0
                            && cursor.getInt(deleteFlagIdx) != 0) {
                        continue; // 已删除/已退群（软删除行）
                    }
                    String username = cursor.getString(usernameIdx);
                    if (username == null || username.trim().isEmpty()) {
                        continue;
                    }
                    String trimmed = username.trim();
                    boolean isGroup = trimmed.endsWith("@chatroom");
                    if (isGroup != onlyGroups) {
                        continue;
                    }
                    ContactRow row = new ContactRow();
                    row.talker = trimmed;
                    row.nickname = nicknameIdx >= 0
                            ? cursor.getString(nicknameIdx) : null;
                    row.conRemark = conRemarkIdx >= 0
                            ? cursor.getString(conRemarkIdx) : null;
                    if (row.nickname == null) {
                        row.nickname = "";
                    }
                    if (row.conRemark == null) {
                        row.conRemark = "";
                    }
                    out.add(row);
                } while (cursor.moveToNext());
            }
            return true;
        } catch (Throwable error) {
            WechatHook.logAdapterError("contacts cursor read failed", error);
            return false;
        } finally {
            try {
                cursor.close();
            } catch (Throwable ignored) {
            }
        }
    }

    private static SnapshotBuildResult buildSnapshotJson(
            java.util.List<ContactRow> rows,
            boolean includeAvatars,
            String ownWxid,
            boolean full,
            int avatarBudget) {
        org.json.JSONArray groups = new org.json.JSONArray();
        org.json.JSONArray privates = new org.json.JSONArray();
        java.util.Set<String> seen = new java.util.HashSet<>();
        if (rows != null) {
            for (ContactRow row : rows) {
                appendSnapshotRow(groups, privates, seen, row, ownWxid);
            }
        } else {
            // 兜底：Hook 观测缓存（不保证完整，full=false）
            for (java.util.Map.Entry<String, ContactEntry> entry
                    : CONTACT_CACHE.entrySet()) {
                ContactRow row = new ContactRow();
                row.talker = entry.getKey();
                ContactEntry contact = entry.getValue();
                row.nickname = contact == null ? "" : contact.nickname;
                row.conRemark = contact == null ? "" : contact.conRemark;
                appendSnapshotRow(groups, privates, seen, row, ownWxid);
            }
        }
        if (includeAvatars) {
            long used = fillAvatars(groups, avatarBudget);
            fillAvatars(privates, avatarBudget - Math.min(used, avatarBudget));
        }
        String json = snapshotJson(groups, privates);
        // Binder 兜底：带头像超阈值（~900KB）则整体降级为无头像快照，
        // 保证联系人数据永远完整可达（头像只是增强信息）。
        if (json.length() > 900_000) {
            for (int i = 0; i < groups.length(); i++) {
                org.json.JSONObject group = groups.optJSONObject(i);
                if (group != null) {
                    putJson(group, "avatarBase64", "");
                }
            }
            for (int i = 0; i < privates.length(); i++) {
                org.json.JSONObject priv = privates.optJSONObject(i);
                if (priv != null) {
                    putJson(priv, "avatarBase64", "");
                }
            }
            json = snapshotJson(groups, privates);
        }
        WechatHook.logAdapterInfo("contacts snapshot built full=" + full
                + " groups=" + groups.length() + " privates=" + privates.length()
                + " bytes=" + json.length());
        return new SnapshotBuildResult(json, full);
    }

    private static void appendSnapshotRow(
            org.json.JSONArray groups,
            org.json.JSONArray privates,
            java.util.Set<String> seen,
            ContactRow row,
            String ownWxid) {
        String talker = row.talker;
        if (talker == null || talker.isEmpty() || !seen.add(talker)) {
            return;
        }
        if (validSnapshotGroup(talker)) {
            org.json.JSONObject group = new org.json.JSONObject();
            putJson(group, "talker", talker);
            putJson(group, "name", limitedName(row.nickname, "微信群"));
            putJson(group, "avatarBase64", "");
            putJson(group, "memberCount", 0);
            groups.put(group);
        } else if (validSnapshotPrivate(talker, ownWxid)) {
            org.json.JSONObject priv = new org.json.JSONObject();
            putJson(priv, "talker", talker);
            String name = !row.conRemark.isEmpty() ? row.conRemark : row.nickname;
            putJson(priv, "name", limitedName(name, "联系人"));
            putJson(priv, "avatarBase64", "");
            privates.put(priv);
        }
    }

    private static String snapshotJson(
            org.json.JSONArray groups, org.json.JSONArray privates) {
        org.json.JSONObject snapshot = new org.json.JSONObject();
        putJson(snapshot, "generatedAt",
                java.time.Instant.now().toString());
        putJson(snapshot, "groups", groups);
        // 通讯录定义：rcontact 中 deleteFlag=0 的个人联系人（不混入最近会话）
        putJson(snapshot, "privateContacts", privates);
        return snapshot.toString();
    }

    /** 尽力填充头像（base64）；累计超预算即停止填充剩余头像（联系人条目保留）。
     *  单头像读取/压缩失败 → 空字符串，不影响同步。 */
    private static long fillAvatars(org.json.JSONArray entries, long budget) {
        long used = 0;
        for (int i = 0; i < entries.length(); i++) {
            org.json.JSONObject entry = entries.optJSONObject(i);
            if (entry == null) {
                continue;
            }
            String b64 = readAvatarBase64(entry.optString("talker", ""));
            if (b64.isEmpty()) {
                continue;
            }
            if (used + b64.length() > budget) {
                return budget + 1; // 预算耗尽，剩余头像全部留空
            }
            used += b64.length();
            putJson(entry, "avatarBase64", b64);
        }
        return used;
    }

    /** 头像本地文件 → 小尺寸 JPEG → base64。任何失败返回空串（不得拖垮同步）。 */
    private static String readAvatarBase64(String talker) {
        if (talker == null || talker.isEmpty()) {
            return "";
        }
        try {
            String md5 = WechatHook.md5Hex(talker);
            if (md5.length() != 32) {
                return "";
            }
            String p1 = md5.substring(0, 2);
            String p2 = md5.substring(2, 4);
            java.io.File microMsg = new java.io.File(
                    "/data/data/com.tencent.mm/MicroMsg");
            java.io.File[] userDirs = microMsg.listFiles();
            if (userDirs == null) {
                return "";
            }
            java.io.File avatarFile = null;
            for (java.io.File dir : userDirs) {
                if (!dir.isDirectory() || dir.getName().length() != 32) {
                    continue;
                }
                java.io.File base = new java.io.File(
                        new java.io.File(new java.io.File(dir, "avatar"), p1), p2);
                java.io.File normal = new java.io.File(base, "user_" + md5 + ".png");
                java.io.File hd = new java.io.File(base, "user_hd_" + md5 + ".png");
                if (normal.isFile() && normal.length() > 0) {
                    avatarFile = normal;
                    break;
                }
                if (hd.isFile() && hd.length() > 0) {
                    avatarFile = hd;
                    break;
                }
            }
            if (avatarFile == null) {
                return "";
            }
            byte[] jpeg = WechatHook.compressToJpeg(avatarFile, 64, 50);
            if (jpeg == null || jpeg.length == 0) {
                return "";
            }
            return android.util.Base64.encodeToString(
                    jpeg, android.util.Base64.NO_WRAP);
        } catch (Throwable ignored) {
            return "";
        }
    }

    private static void putJson(
            org.json.JSONObject object, String key, Object value) {
        try {
            object.put(key, value);
        } catch (org.json.JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    /** 从 XML 字符串中提取指定标签的文本（单行标签，如 <title>xxx</title>）。 */
    private static String extractXmlTag(String xml, String tag) {
        if (xml == null || tag == null) {
            return null;
        }
        String open = "<" + tag + ">";
        String close = "</" + tag + ">";
        int start = xml.indexOf(open);
        if (start < 0) {
            return null;
        }
        start += open.length();
        int end = xml.indexOf(close, start);
        if (end < 0) {
            return null;
        }
        String value = xml.substring(start, end);
        return value.replaceAll("\\s+", " ").trim();
    }

    /** 从群聊 content 前缀提取发送者（"发送者wxid:" 冒号前截取）。 */
    private static String quoteSender(String content) {
        if (content == null || content.isEmpty()) {
            return "";
        }
        String normalized = content.replaceAll("(?i)<br\\s*/?>", "\n");
        int sep = normalized.indexOf(':');
        if (sep <= 0) {
            return "";
        }
        String sender = normalized.substring(0, sep).trim();
        if (sender.isEmpty() || sender.length() > 256) {
            return "";
        }
        return sender;
    }

    /** 打码 wxid 形式的标识（诊断日志用，保留其余内容）。 */
    private static String maskId(String value) {
        if (value == null || value.isEmpty()) {
            return value;
        }
        return value.replaceAll("wxid_[0-9a-zA-Z]{4,}", "wxid_***");
    }

    /** 诊断限流：每 20 秒窗口最多 15 条 dump，防日志刷屏拖慢微信。 */
    private static String stringFieldOrMethods(
            Object target, String fieldName, String[] methodNames) {
        Object fieldValue = value(target, fieldName, null);
        if (fieldValue != null) {
            String result = String.valueOf(fieldValue);
            if (!result.isEmpty()) {
                return result;
            }
        }
        for (String methodName : methodNames) {
            try {
                Object methodValue = XposedHelpers.callMethod(target, methodName);
                if (methodValue != null) {
                    String result = String.valueOf(methodValue);
                    if (!result.isEmpty()) {
                        return result;
                    }
                }
            } catch (Throwable ignored) {
            }
        }
        return "";
    }

    private static int intFieldOrMethod(
            Object target, String fieldName, String methodName, int fallback) {
        Object value = value(target, fieldName, methodName);
        return value instanceof Number ? ((Number) value).intValue() : fallback;
    }

    private static long longFieldOrMethod(
            Object target, String fieldName, String methodName, long fallback) {
        Object value = value(target, fieldName, methodName);
        return value instanceof Number ? ((Number) value).longValue() : fallback;
    }

    private static boolean booleanFieldOrMethod(
            Object target, String fieldName, String methodName, boolean fallback) {
        Object value = value(target, fieldName, methodName);
        if (value instanceof Boolean) {
            return (Boolean) value;
        }
        if (value instanceof Number) {
            return ((Number) value).intValue() != 0;
        }
        return fallback;
    }

    private static Object value(Object target, String fieldName, String methodName) {
        try {
            return XposedHelpers.getObjectField(target, fieldName);
        } catch (Throwable ignored) {
            if (methodName == null || methodName.isEmpty()) {
                return null;
            }
            try {
                return XposedHelpers.callMethod(target, methodName);
            } catch (Throwable ignoredMethod) {
                return null;
            }
        }
    }
}
