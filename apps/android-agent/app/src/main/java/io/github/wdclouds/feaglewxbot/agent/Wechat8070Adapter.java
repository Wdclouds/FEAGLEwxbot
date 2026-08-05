package io.github.wdclouds.feaglewxbot.agent;

import java.lang.reflect.Method;

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
                // 值 THUMBNAIL_DIRPATH://th_<32hex>），走正式捕获。
                String imgPath = stringFieldOrMethods(
                        message,
                        "field_imgPath",
                        new String[]{"field_imgPath", "getImgPath", "imgPath"});
                WechatHook.captureImage(
                        "wechat-8.0.70/" + source,
                        imgPath,
                        talker,
                        content,
                        createTime,
                        msgId,
                        msgSvrId);
            }
        } catch (Throwable error) {
            WechatHook.logAdapterError("8.0.70 message capture failed", error);
        }
    }

    /** 打码 wxid 形式的标识（诊断日志用，保留其余内容）。 */
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
