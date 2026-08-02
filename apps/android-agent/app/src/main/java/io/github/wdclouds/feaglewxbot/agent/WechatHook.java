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
