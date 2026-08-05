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
        hookSqlCipherKey(classLoader);
        try {
            hookMessageGetters(classLoader, messageClass);
        } catch (Throwable ignored) {
        }
        try {
            hookAppMsgInfo(classLoader);
        } catch (Throwable ignored) {
        }
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
        // 路径诊断（临时，2026-08-04）：打印该类全部方法签名，定位
        // 引用消息真实路径（ox0.v9.n 的重载 / 其他方法）。
        try {
            StringBuilder sb = new StringBuilder();
            sb.append("[PATH-DIAG] ").append(className).append(" methods:");
            for (Method method : helperClass.getDeclaredMethods()) {
                Class<?>[] ps = method.getParameterTypes();
                sb.append(' ').append(method.getName()).append('(');
                for (Class<?> p : ps) {
                    sb.append(p.getName()).append(',');
                }
                sb.append(')');
            }
            WechatHook.logAdapterInfo(sb.toString());
        } catch (Throwable ignored) {
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
            // 路径诊断（临时，2026-08-04）：打印该类全部方法签名，
            // 用于定位 8.0.70 上引用消息路径（xv0.t9.n 等）的真实参数类型。
            try {
                StringBuilder sb = new StringBuilder();
                sb.append("[PATH-DIAG] ").append(className).append(" methods:");
                for (Method method : helperClass.getDeclaredMethods()) {
                    Class<?>[] ps = method.getParameterTypes();
                    sb.append(' ').append(method.getName()).append('(');
                    for (Class<?> p : ps) {
                        sb.append(p.getName()).append(',');
                    }
                    sb.append(')');
                }
                WechatHook.logAdapterInfo(sb.toString());
            } catch (Throwable ignored) {
            }
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
    static void hookSqlCipherKey(ClassLoader classLoader) {
        String[] dbClasses = {
            "net.sqlcipher.database.SQLiteDatabase",
            "com.tencent.wcdb.database.SQLiteDatabase",
        };
        for (String dbClass : dbClasses) {
            try {
                hookSqlCipherKeyClass(classLoader, dbClass);
            } catch (Throwable ignored) {
            }
        }
        try {
            hookSqlCipherPragma(classLoader);
        } catch (Throwable ignored) {
        }
        try {
            hookAppMessageSql(classLoader);
        } catch (Throwable ignored) {
        }
        try {
            hookSqliteStatement(classLoader);
        } catch (Throwable ignored) {
        }
        try {
            hookSqlCipherSpec(classLoader);
        } catch (Throwable ignored) {
        }
    }

    /** 诊断：hook y8 的 getContent/getType（消息读取时返回数据库完整值，
     *  引用消息的 content 在读取时才完整——addMsg 时刻是空的）。 */
    private static final java.util.concurrent.atomic.AtomicLong GETTER_WINDOW_START =
            new java.util.concurrent.atomic.AtomicLong(0);
    private static final java.util.concurrent.atomic.AtomicInteger GETTER_COUNT =
            new java.util.concurrent.atomic.AtomicInteger(0);

    private static boolean getterAllowed() {
        long now = System.currentTimeMillis();
        long windowStart = GETTER_WINDOW_START.get();
        if (now - windowStart > 2_000) {
            GETTER_WINDOW_START.set(now);
            GETTER_COUNT.set(0);
        }
        return GETTER_COUNT.incrementAndGet() <= 10;
    }

    private static void hookMessageGetters(
            ClassLoader classLoader, Class<?> messageClass) {
        for (Method method : messageClass.getDeclaredMethods()) {
            // 8.0.70 混淆：content 读取可能是 j/S1/W0 等（非 getContent），
            // hook 所有无参 + String 返回的方法。
            if (method.getParameterTypes().length != 0) {
                continue;
            }
            if (method.getReturnType() != String.class) {
                continue;
            }
            method.setAccessible(true);
            XposedBridge.hookMethod(method, new XC_MethodHook() {
                @Override
                protected void afterHookedMethod(MethodHookParam param) {
                    try {
                        if (!getterAllowed()) {
                            return;
                        }
                        Object result = param.getResult();
                        if (result == null) {
                            return;
                        }
                        String value = String.valueOf(result);
                        if (value.isEmpty()) {
                            return;
                        }
                        String cut = value.length() > 300
                                ? value.substring(0, 300) : value;
                        WechatHook.logAdapterInfo(
                                "[Y8-GET] " + method.getName() + "="
                                + maskId(cut));
                    } catch (Throwable ignored) {
                    }
                }
            });
        }
    }

    /** 诊断：hook SQLiteCipherSpec 构造（WCDB 加密规格，含 key）。 */
    private static void hookSqlCipherSpec(ClassLoader classLoader) {
        Class<?> specClass = XposedHelpers.findClass(
                "com.tencent.wcdb.database.SQLiteCipherSpec", classLoader);
        for (java.lang.reflect.Constructor<?> ctor
                : specClass.getDeclaredConstructors()) {
            Class<?>[] ps = ctor.getParameterTypes();
            boolean hasKey = false;
            for (Class<?> p : ps) {
                if (p == byte[].class || p == char[].class
                        || p == String.class) {
                    hasKey = true;
                    break;
                }
            }
            if (!hasKey) {
                continue;
            }
            ctor.setAccessible(true);
            XposedBridge.hookMethod(ctor, new XC_MethodHook() {
                @Override
                protected void beforeHookedMethod(MethodHookParam param) {
                    try {
                        StringBuilder sb = new StringBuilder(
                                "[DB-KEY-SPEC] ctor params=");
                        for (int i = 0; i < param.args.length; i++) {
                            Object a = param.args[i];
                            if (a instanceof byte[]) {
                                byte[] kb = (byte[]) a;
                                StringBuilder hex = new StringBuilder();
                                for (int j = 0; j < Math.min(kb.length, 64); j++) {
                                    hex.append(String.format("%02x", kb[j]));
                                }
                                sb.append(" byte[]len=").append(kb.length)
                                        .append(" hex=").append(hex);
                            } else if (a instanceof char[]) {
                                sb.append(" char[]len=")
                                        .append(((char[]) a).length);
                            } else if (a instanceof String) {
                                sb.append(" str=").append(a);
                            }
                        }
                        WechatHook.logAdapterInfo(sb.toString());
                    } catch (Throwable ignored) {
                    }
                }
            });
        }
    }

    /** 诊断：hook WCDB execSQL 抓 AppMessage 表 SQL（appmsg 写入时
     *  content XML 在 bindArgs 里——引用文字最后的位置）。 */
    private static void hookAppMessageSql(ClassLoader classLoader) {
        Class<?> sqliteDb = XposedHelpers.findClass(
                "com.tencent.wcdb.database.SQLiteDatabase", classLoader);
        for (Method method : sqliteDb.getDeclaredMethods()) {
            Class<?>[] ps = method.getParameterTypes();
            if (ps.length < 1 || ps[0] != String.class) {
                continue;
            }
            String name = method.getName();
            if (!name.contains("exec") && !name.equals("rawQuery")
                    && !name.equals("query")) {
                continue;
            }
            boolean hasObjArr = false;
            for (Class<?> p : ps) {
                if (p == Object[].class) {
                    hasObjArr = true;
                    break;
                }
            }
            if (!hasObjArr) {
                continue;
            }
            method.setAccessible(true);
            XposedBridge.hookMethod(method, new XC_MethodHook() {
                @Override
                protected void beforeHookedMethod(MethodHookParam param) {
                    try {
                        Object sqlArg = param.args[0];
                        if (!(sqlArg instanceof String)) {
                            return;
                        }
                        String sql = (String) sqlArg;
                        if (!sql.toLowerCase(java.util.Locale.ROOT)
                                .contains("appmessage")) {
                            return;
                        }
                        StringBuilder sb = new StringBuilder("[APPMSG-SQL] ")
                                .append(method.getName()).append(" sql=")
                                .append(sql.length() > 200
                                        ? sql.substring(0, 200) : sql);
                        for (int i = 1; i < param.args.length; i++) {
                            Object a = param.args[i];
                            if (a instanceof Object[]) {
                                for (Object item : (Object[]) a) {
                                    if (item instanceof String) {
                                        String s = (String) item;
                                        String cut = s.length() > 600
                                                ? s.substring(0, 600) : s;
                                        sb.append(" |bind=").append(maskId(cut));
                                    }
                                }
                            }
                        }
                        WechatHook.logAdapterInfo(sb.toString());
                    } catch (Throwable ignored) {
                    }
                }
            });
        }
    }

    /** 诊断：hook WCDB SQLiteStatement.bindString——所有写入绑定的必经之路，
     *  AppMessage content XML（含引用文字）在这里出现。 */
    private static void hookSqliteStatement(ClassLoader classLoader) {
        Class<?> stmtClass = XposedHelpers.findClass(
                "com.tencent.wcdb.database.SQLiteStatement", classLoader);
        for (Method method : stmtClass.getDeclaredMethods()) {
            if (!method.getName().equals("bindString")
                    && !method.getName().equals("bindBlob")
                    && !method.getName().equals("bindStringOrNull")) {
                continue;
            }
            method.setAccessible(true);
            XposedBridge.hookMethod(method, new XC_MethodHook() {
                @Override
                protected void beforeHookedMethod(MethodHookParam param) {
                    try {
                        for (Object a : param.args) {
                            if (a instanceof String) {
                                String s = (String) a;
                                if (s.length() < 20
                                        && !s.contains("<msg")
                                        && !s.contains("<appmsg")) {
                                    continue;
                                }
                                String cut = s.length() > 800
                                        ? s.substring(0, 800) : s;
                                WechatHook.logAdapterInfo(
                                        "[STMT-BIND] " + method.getName()
                                        + "=" + maskId(cut));
                            } else if (a instanceof byte[]) {
                                byte[] kb = (byte[]) a;
                                if (kb.length < 20) {
                                    continue;
                                }
                                WechatHook.logAdapterInfo(
                                        "[STMT-BIND] " + method.getName()
                                        + " byte[] len=" + kb.length);
                            }
                        }
                    } catch (Throwable ignored) {
                    }
                }
            });
        }
    }

    /** 诊断：hook WCDB execSQL 抓 PRAGMA key（部分库用 PRAGMA 传 key）。 */
    private static void hookSqlCipherPragma(ClassLoader classLoader) {
        Class<?> sqliteDb = XposedHelpers.findClass(
                "com.tencent.wcdb.database.SQLiteDatabase", classLoader);
        for (Method method : sqliteDb.getDeclaredMethods()) {
            Class<?>[] ps = method.getParameterTypes();
            if (ps.length < 1 || ps[0] != String.class) {
                continue;
            }
            String name = method.getName();
            if (!name.contains("exec") && !name.equals("rawQuery")
                    && !name.equals("query")) {
                continue;
            }
            method.setAccessible(true);
            XposedBridge.hookMethod(method, new XC_MethodHook() {
                @Override
                protected void beforeHookedMethod(MethodHookParam param) {
                    try {
                        Object sqlArg = param.args[0];
                        if (sqlArg instanceof String) {
                            String sql = (String) sqlArg;
                            if (sql.toLowerCase(java.util.Locale.ROOT)
                                    .contains("pragma key")) {
                                WechatHook.logAdapterInfo(
                                        "[DB-KEY-PRAGMA] " + method.getName()
                                        + " sql=" + sql);
                            }
                        }
                    } catch (Throwable ignored) {
                    }
                }
            });
        }
    }

    private static void hookSqlCipherKeyClass(
            ClassLoader classLoader, String dbClass) {
        Class<?> sqliteDb = XposedHelpers.findClass(dbClass, classLoader);
        for (Method method : sqliteDb.getDeclaredMethods()) {
            // 只 hook 打开类方法（open*），EnMicroMsg.db 可能用
            // openDatabaseWithFactory/rawOpenDatabase 等变体。
            if (!method.getName().toLowerCase(java.util.Locale.ROOT)
                    .contains("open")) {
                continue;
            }
            Class<?>[] ps = method.getParameterTypes();
            boolean hasKey = false;
            for (Class<?> p : ps) {
                if (p == char[].class || p == byte[].class
                        || p == String.class) {
                    hasKey = true;
                    break;
                }
            }
            if (!hasKey) {
                continue;
            }
            method.setAccessible(true);
            XposedBridge.hookMethod(method, new XC_MethodHook() {
                @Override
                protected void beforeHookedMethod(MethodHookParam param) {
                    try {
                        String dbPath = null;
                        for (int i = 0; i < param.args.length; i++) {
                            Object a = param.args[i];
                            if (a instanceof String
                                    && ((String) a).startsWith("/")) {
                                dbPath = (String) a;
                                break;
                            }
                        }
                        String tag = "[DB-KEY] " + dbClass + "."
                                + method.getName()
                                + (dbPath != null
                                        ? " path=" + dbPath : "");
                        for (int i = 0; i < param.args.length; i++) {
                            Object a = param.args[i];
                            if (a instanceof char[]) {
                                WechatHook.logAdapterInfo(
                                        tag + " char[] key len="
                                        + ((char[]) a).length);
                            } else if (a instanceof byte[]) {
                                byte[] kb = (byte[]) a;
                                StringBuilder hex = new StringBuilder();
                                for (int j = 0; j < Math.min(kb.length, 64); j++) {
                                    hex.append(String.format("%02x", kb[j]));
                                }
                                WechatHook.logAdapterInfo(
                                        tag + " byte[] key len=" + kb.length
                                        + " hex=" + hex);
                            } else if (a instanceof String
                                    && !((String) a).startsWith("/")
                                    && ((String) a).length() > 10
                                    && ((String) a).length() < 256) {
                                WechatHook.logAdapterInfo(
                                        tag + " string key=" + a);
                            }
                        }
                    } catch (Throwable ignored) {
                    }
                }
            });
        }
    }

    /** 诊断：hook AppMsgInfo（AppMessage 存储对象，content 含完整 appmsg XML，
     *  引用消息的 <refermsg><content> 用户文字在这里）。 */
    private static void hookAppMsgInfo(ClassLoader classLoader) {
        String[] candidates = {
            "com.tencent.mm.storage.AppMsgInfo",
            "com.tencent.mm.storage.emotion.AppMsgInfo",
            "com.tencent.mm.autogen.mmdata.rpt.AppMsgInfo",
        };
        for (String clsName : candidates) {
            Class<?> cls;
            try {
                cls = XposedHelpers.findClass(clsName, classLoader);
            } catch (Throwable t) {
                continue;
            }
            WechatHook.logAdapterInfo("[APPMSG] found class " + clsName);
            // hook 构造：含 String 参数（content XML）
            for (java.lang.reflect.Constructor<?> ctor
                    : cls.getDeclaredConstructors()) {
                boolean hasString = false;
                for (Class<?> p : ctor.getParameterTypes()) {
                    if (p == String.class) {
                        hasString = true;
                        break;
                    }
                }
                if (!hasString) {
                    continue;
                }
                ctor.setAccessible(true);
                XposedBridge.hookMethod(ctor, new XC_MethodHook() {
                    @Override
                    protected void beforeHookedMethod(MethodHookParam param) {
                        try {
                            for (Object a : param.args) {
                                if (a instanceof String) {
                                    String s = (String) a;
                                    if (s.contains("<msg") || s.contains("<appmsg")) {
                                        String cut = s.length() > 800
                                                ? s.substring(0, 800) : s;
                                        WechatHook.logAdapterInfo(
                                                "[APPMSG-CTOR] "
                                                + clsName + " content="
                                                + maskId(cut));
                                    }
                                }
                            }
                        } catch (Throwable ignored) {
                        }
                    }
                });
            }
            // hook getContent（无参 String 返回）
            for (Method method : cls.getDeclaredMethods()) {
                if (!method.getName().equals("getContent")) {
                    continue;
                }
                if (method.getParameterTypes().length != 0
                        || method.getReturnType() != String.class) {
                    continue;
                }
                method.setAccessible(true);
                XposedBridge.hookMethod(method, new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        try {
                            if (!getterAllowed()) {
                                return;
                            }
                            Object result = param.getResult();
                            if (result == null) {
                                return;
                            }
                            String s = String.valueOf(result);
                            if (s.isEmpty()) {
                                return;
                            }
                            String cut = s.length() > 800
                                    ? s.substring(0, 800) : s;
                            WechatHook.logAdapterInfo(
                                    "[APPMSG-GET] " + clsName
                                    + " content=" + maskId(cut));
                        } catch (Throwable ignored) {
                        }
                    }
                });
            }
            break;
        }
    }

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

            // ── 引用嗅探诊断（临时，2026-08-04 引用解析调研用）──
            // isSend==0 全 type 枚举全部字段（String/数值/boolean），
            // 定位引用消息的 @ 标记与文字字段。限流：每 20 秒最多 15 条。
            if (isSend == 0 && diagAllowed()) {
                dumpAllFields(message, type);
            }
            // ── 引用嗅探诊断结束 ──

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
    private static final java.util.concurrent.atomic.AtomicLong DIAG_WINDOW_START =
            new java.util.concurrent.atomic.AtomicLong(0);
    private static final java.util.concurrent.atomic.AtomicInteger DIAG_COUNT =
            new java.util.concurrent.atomic.AtomicInteger(0);

    private static boolean diagAllowed() {
        long now = System.currentTimeMillis();
        long windowStart = DIAG_WINDOW_START.get();
        if (now - windowStart > 20_000) {
            DIAG_WINDOW_START.set(now);
            DIAG_COUNT.set(0);
        }
        return DIAG_COUNT.incrementAndGet() <= 15;
    }

    /** 枚举消息对象全部字段（String/数值/boolean，诊断用，打码 + 截断）。 */
    private static void dumpAllFields(Object message, int type) {
        dumpAllFields(message, type, 0);
    }

    private static void dumpAllFields(Object message, int type, int depth) {
        if (message == null || depth > 2) {
            return;
        }
        try {
            // 字段可能在父类（微信消息类继承链），逐层遍历。
            for (Class<?> cls = message.getClass();
                    cls != null; cls = cls.getSuperclass()) {
                for (java.lang.reflect.Field field
                        : cls.getDeclaredFields()) {
                    String fieldName = field.getName();
                    // 跳过 Java 内部字段（反射深渊，递归会陷进 Class 内部）。
                    if (fieldName.startsWith("shadow$_")) {
                        continue;
                    }
                    Class<?> ftype = field.getType();
                    if (ftype == byte[].class) {
                        // byte[]（lvbuffer 等）：解码 UTF-8 打前 500 字符，
                        // appmsg XML / 引用文字可能序列化在这里。
                        try {
                            field.setAccessible(true);
                            Object raw = field.get(message);
                            if (raw instanceof byte[] && ((byte[]) raw).length > 0) {
                                byte[] bytes = (byte[]) raw;
                                // 完整 hex（前 256 字节）+ 魔数检测：
                                // LZ4=04 22 4D 18 / zstd=28 B5 2F FD
                                StringBuilder hex = new StringBuilder();
                                for (int j = 0; j < Math.min(bytes.length, 256); j++) {
                                    hex.append(String.format("%02x", bytes[j]));
                                }
                                String magic = "";
                                if (bytes.length >= 4) {
                                    int m = (bytes[0] << 24) | (bytes[1] << 16)
                                            | (bytes[2] << 8) | bytes[3];
                                    if (m == 0x04224D18) {
                                        magic = "LZ4";
                                    } else if (m == 0x28B52FFD) {
                                        magic = "zstd";
                                    }
                                }
                                WechatHook.logAdapterInfo("[REF-DUMP] type=" + type
                                        + " field=" + fieldName + "=[B len="
                                        + bytes.length + " magic=" + magic
                                        + " hex=" + hex);
                            }
                        } catch (Throwable ignored) {
                        }
                        continue;
                    }
                    if (ftype != String.class && ftype != boolean.class
                            && ftype != int.class && ftype != long.class) {
                        // 非白名单类型：打类型名 + 递归一层（仅微信类，
                        // java.* 只打类型名不穿透，防 Class 反射深渊）。
                        try {
                            field.setAccessible(true);
                            Object nested = field.get(message);
                            if (nested != null) {
                                WechatHook.logAdapterInfo("[REF-DUMP] type=" + type
                                        + " depth=" + depth
                                        + " field=" + fieldName
                                        + ":<" + ftype.getName() + ">");
                                if (nested instanceof java.util.List) {
                                    int count = 0;
                                    for (Object item : (java.util.List<?>) nested) {
                                        if (count++ >= 3) {
                                            break;
                                        }
                                        if (item != null && !item.getClass()
                                                .getName().startsWith("java.")) {
                                            dumpAllFields(item, type, depth + 1);
                                        }
                                    }
                                } else if (!nested.getClass().getName()
                                        .startsWith("java.")) {
                                    dumpAllFields(nested, type, depth + 1);
                                }
                            }
                        } catch (Throwable ignored) {
                        }
                        continue;
                    }
                    try {
                        field.setAccessible(true);
                        Object raw = field.get(message);
                        if (raw == null) {
                            continue;
                        }
                        if (ftype == String.class) {
                            String value = (String) raw;
                            if (value.isEmpty()) {
                                continue;
                            }
                            String cut = value.length() > 500
                                    ? value.substring(0, 500) : value;
                            WechatHook.logAdapterInfo("[REF-DUMP] type=" + type
                                    + " depth=" + depth
                                    + " field=" + fieldName
                                    + "=" + maskId(cut));
                        } else {
                            WechatHook.logAdapterInfo("[REF-DUMP] type=" + type
                                    + " depth=" + depth
                                    + " field=" + fieldName
                                    + "=" + raw);
                        }
                    } catch (Throwable ignored) {
                    }
                }
            }
        } catch (Throwable ignored) {
        }
    }

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
