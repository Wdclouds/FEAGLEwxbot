package io.github.wdclouds.feaglewxbot.agent;

import android.app.Application;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.RemoteException;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import de.robv.android.xposed.IXposedHookLoadPackage;
import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage;

public final class WechatHook implements IXposedHookLoadPackage {
    private static final String TAG = "FEAGLE-Hook";
    private static final int MAX_DEDUP = 1024;
    private static final AtomicBoolean initialized = new AtomicBoolean(false);
    private static final Map<String, Boolean> recentEvents =
            new LinkedHashMap<String, Boolean>(MAX_DEDUP + 1, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, Boolean> eldest) {
                    return size() > MAX_DEDUP;
                }
            };

    private static Context appContext;
    private static ClassLoader wechatClassLoader;
    private static boolean mainProcess;
    private static String currentProcess;
    private static Messenger agentMessenger;
    private static Handler mainHandler;
    private static Messenger hookMessenger;
    private static final Runnable rebindAgent = WechatHook::bindAgent;

    @Override
    public void handleLoadPackage(XC_LoadPackage.LoadPackageParam loadPackage)
            throws Throwable {
        if (!AgentProtocol.WECHAT_PACKAGE.equals(loadPackage.packageName)) {
            return;
        }
        boolean isMain = AgentProtocol.WECHAT_PACKAGE.equals(loadPackage.processName);
        boolean isPush = (AgentProtocol.WECHAT_PACKAGE + ":push")
                .equals(loadPackage.processName);
        if (!isMain && !isPush) {
            return;
        }

        XposedHelpers.findAndHookMethod(
                Application.class,
                "attach",
                Context.class,
                new XC_MethodHook() {
                    @Override
                    protected void afterHookedMethod(MethodHookParam param) {
                        if (!initialized.compareAndSet(false, true)) {
                            return;
                        }
                        appContext = ((Context) param.args[0]).getApplicationContext();
                        // WeChat applies Tinker patches after package load. Resolve
                        // targets from the attached runtime context so patched
                        // classes are visible to the documented 8.0.70 adapter.
                        wechatClassLoader = appContext.getClassLoader();
                        mainProcess = isMain;
                        currentProcess = loadPackage.processName;
                        mainHandler = new Handler(Looper.getMainLooper());
                        hookMessenger = new Messenger(new HookHandler());
                        String installedVersion = installedWechatVersion();
                        if (!Wechat8070Adapter.TARGET_VERSION.equals(installedVersion)) {
                            log("inactive: expected WeChat "
                                    + Wechat8070Adapter.TARGET_VERSION
                                    + " but found " + installedVersion);
                            return;
                        }
                        bindAgent();
                        try {
                            Wechat8070Adapter.installInbound(wechatClassLoader);
                            log("8.0.70 inbound adapter installed");
                        } catch (Throwable error) {
                            logAdapterError(
                                    "8.0.70 inbound adapter install failed", error);
                        }
                        log("active version=" + Wechat8070Adapter.TARGET_VERSION
                                + " process=" + currentProcess);
                    }
                });
    }

    static void captureTextFields(
            String source,
            int type,
            int isSend,
            String talkerValue,
            String contentValue,
            long createTime,
            long msgId,
            long msgSvrId,
            boolean mentioned) {
        String talker = talkerValue == null ? "" : talkerValue.trim();
        String content = contentValue == null ? "" : contentValue;
        if (type != 1 || isSend != 0 || content.isEmpty()) {
            return;
        }

        if (validGroupTalker(talker)) {
            GroupText parsed = parseGroupText(content);
            if (parsed == null) {
                return;
            }
            sendCapturedText(
                    source,
                    AgentProtocol.MSG_GROUP_TEXT,
                    eventId(talker, content, createTime, msgId, msgSvrId),
                    talker,
                    parsed.sender,
                    parsed.content,
                    createTime,
                    msgId,
                    msgSvrId,
                    mentioned);
            return;
        }

        if (!validPrivateTalker(talker)) {
            return;
        }
        sendCapturedText(
                source,
                AgentProtocol.MSG_PRIVATE_TEXT,
                eventId(talker, content, createTime, msgId, msgSvrId),
                talker,
                "",
                content,
                createTime,
                msgId,
                msgSvrId,
                false);
    }

    /**
     * 正式图片捕获（2026-08-04，字段名已实测确认）：
     * field_imgPath 值形如 "THUMBNAIL_DIRPATH://th_<32hex>"。
     * 后台线程：定位缩略图文件（带重试）→ 压缩 JPEG（Binder 传输限制
     * ~1MB，目标 <200KB）→ base64 → 协议 7/8 上报 BridgeForegroundService。
     */
    static void captureImage(
            String source,
            String imgPathValue,
            String talker,
            long createTime,
            long msgId,
            long msgSvrId) {
        if (imgPathValue == null || imgPathValue.isEmpty()) {
            return;
        }
        String eventId = eventId(
                talker, "image:" + imgPathValue, createTime, msgId, msgSvrId);
        synchronized (recentEvents) {
            if (recentEvents.containsKey(eventId)) {
                return;
            }
            recentEvents.put(eventId, Boolean.TRUE);
        }
        String thumbHash = parseThumbHash(imgPathValue);
        if (thumbHash == null) {
            log("image path parse failed val=" + preview(imgPathValue));
            return;
        }
        boolean group = talker != null
                && talker.toLowerCase(Locale.ROOT).endsWith("@chatroom");
        final int messageType = group
                ? AgentProtocol.MSG_GROUP_IMAGE : AgentProtocol.MSG_PRIVATE_IMAGE;
        log("image captured chat=" + (group ? "group" : "private")
                + " hash=" + thumbHash + " source=" + source);
        Thread worker = new Thread(() -> {
            try {
                java.io.File file = resolveThumbFile(thumbHash, 10_000);
                if (file == null) {
                    log("image file not found hash=" + thumbHash);
                    return;
                }
                byte[] jpeg = compressToJpeg(file, 1024, 72);
                if (jpeg == null || jpeg.length == 0) {
                    log("image compress failed hash=" + thumbHash);
                    return;
                }
                String b64 = android.util.Base64.encodeToString(
                        jpeg, android.util.Base64.NO_WRAP);
                sendImageToAgent(
                        messageType, eventId, talker, "", b64, "image/jpeg",
                        jpeg.length, createTime, msgId, msgSvrId);
                log("image forwarded type=" + messageType
                        + " bytes=" + jpeg.length + " b64len=" + b64.length());
            } catch (Throwable error) {
                logError("image capture worker failed", error);
            }
        }, "feagle-img");
        worker.setDaemon(true);
        worker.start();
    }

    private static String parseThumbHash(String imgPathValue) {
        int idx = imgPathValue.lastIndexOf("th_");
        if (idx < 0) {
            return null;
        }
        String hash = imgPathValue.substring(idx + 3).trim();
        return hash.matches("^[0-9a-fA-F]{32}$") ? hash : null;
    }

    /** 在 MicroMsg/<md5>/image2/<前2>/<次2>/ 下定位 th_<hash>，带轮询重试。 */
    private static java.io.File resolveThumbFile(String hash, long timeoutMs) {
        if (appContext == null) {
            return null;
        }
        java.io.File microMsg = new java.io.File(
                appContext.getFilesDir().getParentFile(), "MicroMsg");
        if (!microMsg.isDirectory()) {
            return null;
        }
        String dir1 = hash.substring(0, 2);
        String dir2 = hash.substring(2, 4);
        long deadline = System.currentTimeMillis() + timeoutMs;
        java.io.File[] userDirs = microMsg.listFiles();
        if (userDirs == null) {
            return null;
        }
        for (java.io.File userDir : userDirs) {
            if (!userDir.isDirectory()
                    || !userDir.getName().matches("^[0-9a-f]{32}$")) {
                continue;
            }
            java.io.File thumb = new java.io.File(
                    new java.io.File(new java.io.File(userDir, "image2"), dir1), dir2);
            java.io.File thumbFile = new java.io.File(thumb, "th_" + hash);
            if (tryWaitFile(thumbFile, deadline)) {
                return thumbFile;
            }
        }
        return null;
    }

    private static boolean tryWaitFile(java.io.File file, long deadline) {
        while (System.currentTimeMillis() < deadline) {
            if (file.isFile() && file.length() > 0) {
                return true;
            }
            try {
                Thread.sleep(400);
            } catch (InterruptedException ignored) {
                return false;
            }
        }
        return file.isFile() && file.length() > 0;
    }

    /** 解码 → 等比缩到最长边 ≤ maxEdge → JPEG 压缩（子线程调用，内存友好）。 */
    private static byte[] compressToJpeg(java.io.File file, int maxEdge, int quality) {
        android.graphics.BitmapFactory.Options opts =
                new android.graphics.BitmapFactory.Options();
        opts.inJustDecodeBounds = true;
        android.graphics.BitmapFactory.decodeFile(file.getAbsolutePath(), opts);
        if (opts.outWidth <= 0 || opts.outHeight <= 0) {
            return null;
        }
        int sample = 1;
        while (opts.outWidth / sample > maxEdge * 2
                || opts.outHeight / sample > maxEdge * 2) {
            sample *= 2;
        }
        opts.inJustDecodeBounds = false;
        opts.inSampleSize = sample;
        android.graphics.Bitmap bitmap =
                android.graphics.BitmapFactory.decodeFile(file.getAbsolutePath(), opts);
        if (bitmap == null) {
            return null;
        }
        try {
            int w = bitmap.getWidth();
            int h = bitmap.getHeight();
            if (Math.max(w, h) > maxEdge) {
                float scale = (float) maxEdge / Math.max(w, h);
                android.graphics.Bitmap scaled = android.graphics.Bitmap
                        .createScaledBitmap(bitmap,
                                Math.max(1, Math.round(w * scale)),
                                Math.max(1, Math.round(h * scale)), true);
                if (scaled != bitmap) {
                    bitmap.recycle();
                    bitmap = scaled;
                }
            }
            java.io.ByteArrayOutputStream bos =
                    new java.io.ByteArrayOutputStream();
            bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG,
                    quality, bos);
            return bos.toByteArray();
        } finally {
            if (!bitmap.isRecycled()) {
                bitmap.recycle();
            }
        }
    }

    private static void sendImageToAgent(
            int messageType, String eventId, String talker, String sender,
            String imageBase64, String mime, int size,
            long createTime, long msgId, long msgSvrId) {
        if (agentMessenger == null) {
            return;
        }
        try {
            Message outbound = Message.obtain(null, messageType);
            Bundle data = new Bundle();
            data.putString("event_id", eventId);
            data.putString("talker", talker);
            data.putString("sender", sender);
            data.putString("image_base64", imageBase64);
            data.putString("mime", mime);
            data.putInt("image_size", size);
            data.putLong("create_time", createTime);
            data.putLong("msg_id", msgId);
            data.putLong("msg_svr_id", msgSvrId);
            outbound.setData(data);
            sendToAgent(outbound);
        } catch (Throwable error) {
            logError("image send failed", error);
        }
    }

    private static String preview(String s) {
        if (s.length() <= 40) {
            return s;
        }
        return s.substring(0, 40) + "...";
    }

    private static void sendCapturedText(
            String source,
            int messageType,
            String eventId,
            String talker,
            String sender,
            String content,
            long createTime,
            long msgId,
            long msgSvrId,
            boolean mentioned) {
        synchronized (recentEvents) {
            if (recentEvents.containsKey(eventId)) {
                return;
            }
            recentEvents.put(eventId, Boolean.TRUE);
        }

        Message outbound = Message.obtain(null, messageType);
        Bundle data = new Bundle();
        data.putString("event_id", eventId);
        data.putString("talker", talker);
        data.putString("sender", sender);
        data.putString("content", content);
        data.putBoolean("mentioned", mentioned);
        data.putLong("create_time", createTime);
        data.putLong("msg_id", msgId);
        data.putLong("msg_svr_id", msgSvrId);
        outbound.setData(data);
        sendToAgent(outbound);

        // Never log message content or raw account/group identifiers.
        log((messageType == AgentProtocol.MSG_GROUP_TEXT ? "group" : "private")
                + " text captured source=" + source
                + " length=" + content.length());
    }

    private static String eventId(
            String talker, String content, long createTime, long msgId, long msgSvrId) {
        if (msgSvrId > 0) {
            return "wxsvr:" + msgSvrId;
        }
        if (msgId > 0) {
            return "wxlocal:" + msgId;
        }
        return "wxfallback:" + createTime + ":"
                + Integer.toHexString((talker + "\u0000" + content).hashCode());
    }

    private static GroupText parseGroupText(String rawContent) {
        String normalized = rawContent.replaceAll("(?i)<br\\s*/?>", "\n");
        int separator = normalized.indexOf(":\n");
        if (separator <= 0) {
            return null;
        }
        String sender = normalized.substring(0, separator).trim();
        String content = normalized.substring(separator + 2).trim();
        if (!validGroupSender(sender) || content.isEmpty()) {
            return null;
        }
        return new GroupText(sender, content);
    }

    private static final class GroupText {
        final String sender;
        final String content;

        GroupText(String sender, String content) {
            this.sender = sender;
            this.content = content;
        }
    }

    private static final class HookHandler extends Handler {
        HookHandler() {
            super(Looper.getMainLooper());
        }

        @Override
        public void handleMessage(Message message) {
            if (message.what != AgentProtocol.MSG_SEND_TEXT) {
                super.handleMessage(message);
                return;
            }
            Bundle data = message.getData();
            String commandId = data.getString("command_id", "");
            String talker = data.getString("talker", "").trim();
            String content = data.getString("content", "");
            String chatType = data.getString("chat_type", "private");
            boolean validTalker = "group".equals(chatType)
                    ? validGroupTalker(talker)
                    : validPrivateTalker(talker);
            if (!validTalker
                    || content.isEmpty() || content.length() > 2000) {
                sendCommandResult(commandId, false, "invalid_command");
                return;
            }
            sendWechatText(commandId, talker, content);
        }
    }

    private static void sendWechatText(String commandId, String talker, String content) {
        mainHandler.post(() -> {
            try {
                Wechat8070Adapter.sendText(wechatClassLoader, talker, content);
                sendCommandResult(commandId, true, "");
                log("send_text accepted command=" + commandId);
            } catch (Throwable error) {
                logError("send_text failed command=" + commandId, error);
                sendCommandResult(
                        commandId, false, error.getClass().getSimpleName());
            }
        });
    }

    private static void bindAgent() {
        Intent intent = new Intent();
        intent.setComponent(new ComponentName(
                AgentProtocol.AGENT_PACKAGE, AgentProtocol.SERVICE_CLASS));
        try {
            boolean bound = appContext.bindService(
                    intent, serviceConnection, Context.BIND_AUTO_CREATE);
            log("agent bind requested=" + bound);
            if (!bound) {
                scheduleRebind();
            }
        } catch (Throwable error) {
            logError("agent bind failed", error);
            scheduleRebind();
        }
    }

    private static final ServiceConnection serviceConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            agentMessenger = new Messenger(binder);
            Handler handler = mainHandler;
            if (handler != null) {
                handler.removeCallbacks(rebindAgent);
            }
            if (mainProcess) {
                Message register = Message.obtain(null, AgentProtocol.MSG_REGISTER_HOOK);
                register.replyTo = hookMessenger;
                sendToAgent(register);
                log("agent connected role=sender");
            } else {
                log("agent connected role=receiver");
            }
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            agentMessenger = null;
            log("agent disconnected");
            scheduleRebind();
        }

        @Override
        public void onNullBinding(ComponentName name) {
            agentMessenger = null;
            log("agent rejected binding");
            scheduleRebind();
        }
    };

    private static void scheduleRebind() {
        Handler handler = mainHandler;
        if (handler != null) {
            handler.removeCallbacks(rebindAgent);
            handler.postDelayed(rebindAgent, 5000);
        }
    }

    private static void sendCommandResult(String commandId, boolean ok, String error) {
        Message result = Message.obtain(null, AgentProtocol.MSG_COMMAND_RESULT);
        Bundle data = new Bundle();
        data.putString("command_id", commandId);
        data.putBoolean("ok", ok);
        data.putString("error", error);
        result.setData(data);
        sendToAgent(result);
    }

    private static void sendToAgent(Message message) {
        Messenger current = agentMessenger;
        if (current == null) {
            return;
        }
        try {
            current.send(message);
        } catch (RemoteException error) {
            agentMessenger = null;
            scheduleRebind();
        }
    }

    private static boolean validPrivateTalker(String talker) {
        String lower = talker.toLowerCase(Locale.ROOT);
        return !lower.isEmpty()
                && !lower.endsWith("@chatroom")
                && !lower.endsWith("@openim")
                && !lower.startsWith("gh_")
                && !lower.equals("filehelper")
                && !lower.equals("newsapp")
                && !lower.equals("fmessage")
                && !lower.equals("weixin")
                && lower.length() <= 256;
    }

    private static boolean validGroupTalker(String talker) {
        String lower = talker.toLowerCase(Locale.ROOT);
        return lower.endsWith("@chatroom")
                && !lower.contains(":")
                && lower.length() <= 256;
    }

    private static boolean validGroupSender(String sender) {
        String normalized = sender.trim();
        return !normalized.isEmpty()
                && !normalized.endsWith("@chatroom")
                && !normalized.contains(":")
                && normalized.length() <= 256;
    }

    private static String installedWechatVersion() {
        try {
            String version = appContext.getPackageManager()
                    .getPackageInfo(AgentProtocol.WECHAT_PACKAGE, 0)
                    .versionName;
            return version == null ? "" : version;
        } catch (Throwable error) {
            logAdapterError("unable to read WeChat version", error);
            return "";
        }
    }

    private static void log(String message) {
        XposedBridge.log(TAG + ": " + message);
    }

    static void logAdapterError(String message, Throwable error) {
        logError(message, error);
    }

    static void logAdapterInfo(String message) {
        log(message);
    }

    private static void logError(String message, Throwable error) {
        XposedBridge.log(TAG + ": " + message + " ("
                + error.getClass().getSimpleName() + ")");
        XposedBridge.log(error);
    }
}
