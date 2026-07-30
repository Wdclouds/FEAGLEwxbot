package io.github.wdclouds.feaglewxbot.agent;

import java.lang.reflect.Method;

import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;

/**
 * Narrow WeChat 8.0.70 adapter.
 *
 * <p>This class deliberately supports one package version and one feature set:
 * inbound private text plus outbound private text. It does not enumerate DEX
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
                captureMessage(source, param.args[0]);
            }
        });
        return 1;
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

            WechatHook.capturePrivateTextFields(
                    "wechat-8.0.70/" + source,
                    type,
                    isSend,
                    talker,
                    content,
                    createTime,
                    msgId,
                    msgSvrId);
        } catch (Throwable error) {
            WechatHook.logAdapterError("8.0.70 message capture failed", error);
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
