package io.github.wdclouds.feaglewxbot.agent;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.Parcelable;
import android.os.RemoteException;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * NotificationListenerService 入站消息适配器。
 *
 * 通过 Android 通知监听 API 捕获微信通知，提取消息信息，
 * 通过现有 Messenger/Binder 交给 BridgeForegroundService。
 *
 * 不 Hook、不 Frida、不读数据库、不解析 Protobuf。
 *
 * 启用步骤:
 *   设置 → 通知 → 通知读取权限 → 开启 FEAGLEwxbot Agent
 *
 * 数据流:
 *   onNotificationPosted(StatusBarNotification)
 *     → 提取通知消息字段
 *     → 过滤: 仅 com.tencent.mm, 私聊文本, 实时新消息
 *     → 去重: session LRU + SharedPreferences 持久化
 *     → Messenger → MSG_PRIVATE_TEXT → BridgeForegroundService
 *     → WSS → ECS Bridge → OneBot → AstrBot
 *
 * 场景覆盖:
 *   前台聊天: ❌ 微信可能不弹出通知，适配器不会触发
 *   后台聊天: ✅ 正常工作
 *   静音会话: ❌ 微信可能不弹出通知，适配器不会触发
 *   通知隐藏正文: ⚠️ 内容可能是占位文本
 */
public final class NotificationInboundAdapter extends NotificationListenerService {

    private static final String TAG = "FEAGLE-Notify";
    private static final String PREFS_SEEN = "notify_seen_v1";
    private static final String KEY_SEEN_KEYS = "seen_keys";
    private static final int MAX_SEEN_KEYS = 2048;
    private static final int MAX_SESSION_SEEN = 1024;
    private static final int MAX_PENDING_NOTIFICATIONS = 256;
    private static final int MAX_REPLY_TARGETS = 256;
    private static final int MAX_DIAGNOSTIC_EVENTS = 20;
    private static final long MAX_EVENT_AGE_MS = 2 * 60 * 1000L;

    // MessagingStyle extras keys (Android 28+)
    private static final String EXTRA_CONVERSATION_TITLE =
            "android.conversationTitle";
    private static final String EXTRA_IS_GROUP_CONVERSATION =
            "android.isGroupConversation";

    // 去重 LRU（session 级）
    private final LinkedHashSet<String> sessionSeenKeys =
            new LinkedHashSet<String>() {
                @Override
                public boolean add(String key) {
                    if (size() >= MAX_SESSION_SEEN) {
                        remove(iterator().next());
                    }
                    return super.add(key);
                }
            };

    private final LinkedHashMap<String, ParsedNotify> pendingNotifications =
            new LinkedHashMap<String, ParsedNotify>() {
                @Override
                protected boolean removeEldestEntry(
                        Map.Entry<String, ParsedNotify> eldest) {
                    return size() > MAX_PENDING_NOTIFICATIONS;
                }
            };

    private final LinkedHashMap<String, ReplyTarget> replyTargets =
            new LinkedHashMap<String, ReplyTarget>(16, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(
                        Map.Entry<String, ReplyTarget> eldest) {
                    return size() > MAX_REPLY_TARGETS;
                }
            };

    private Messenger agentMessenger;
    private boolean binding;
    private boolean agentBound;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private SharedPreferences seenPrefs;
    private int diagnosticEvents;
    private final Messenger replyMessenger = new Messenger(new ReplyHandler());
    private final Runnable rebindTask = () -> {
        binding = false;
        bindAgent();
    };

    // ---- 生命周期 ----

    @Override
    public void onCreate() {
        super.onCreate();
        seenPrefs = getSharedPreferences(PREFS_SEEN, MODE_PRIVATE);
    }

    @Override
    public void onListenerConnected() {
        log("listener connected");
        bindAgent();
        StatusBarNotification[] active = getActiveNotifications();
        if (active == null) return;
        for (StatusBarNotification notification : active) {
            onNotificationPosted(notification);
        }
    }

    @Override
    public void onListenerDisconnected() {
        log("listener disconnected");
    }

    @Override
    public void onDestroy() {
        unbindAgent();
        super.onDestroy();
    }

    // ---- 通知处理 ----

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        // 仅处理微信通知
        if (!AgentProtocol.WECHAT_PACKAGE.equals(sbn.getPackageName())) return;

        // 提取消息字段
        ParsedNotify parsed = parseNotification(sbn);
        if (parsed == null) {
            diagnosticDrop("parse");
            return;
        }

        // 过滤: 仅入站私聊文本
        if (parsed.chatType != ChatType.PRIVATE) {
            diagnosticDrop("not-private-" + parsed.chatReason);
            return;
        }
        if (parsed.messageType != MessageType.TEXT) {
            diagnosticDrop("not-text");
            return;
        }
        if (parsed.isSend != 0) {
            diagnosticDrop("outbound");
            return;
        }
        if (parsed.content == null || parsed.content.isEmpty()) {
            diagnosticDrop("empty");
            return;
        }
        if (!isFresh(parsed.createTime)) {
            diagnosticDrop("stale");
            return;
        }
        if (parsed.replyTarget != null) {
            synchronized (replyTargets) {
                replyTargets.put(parsed.talker, parsed.replyTarget);
            }
        }
        if (alreadySeen(parsed.eventId)) {
            diagnosticDrop("duplicate");
            return;
        }

        // 只有 Binder 确认接收后才标记已处理；未连接时保留在内存队列。
        if (forwardToBridge(parsed)) {
            markSeen(parsed.eventId);
        } else {
            synchronized (pendingNotifications) {
                pendingNotifications.put(parsed.eventId, parsed);
            }
            bindAgent();
        }
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        if (!AgentProtocol.WECHAT_PACKAGE.equals(sbn.getPackageName())) return;
        String talker = conversationId(sbn.getKey());
        synchronized (replyTargets) {
            replyTargets.remove(talker);
        }
    }

    // ---- 通知解析 ----

    private enum ChatType { PRIVATE, GROUP, UNKNOWN }
    private enum MessageType { TEXT, IMAGE, VOICE, VIDEO, OTHER, UNKNOWN }

    private static final class ParsedNotify {
        String eventId;
        String talker;          // 隐私安全的稳定通知会话 ID
        String displayName;
        ChatType chatType;
        MessageType messageType;
        String content;
        String chatReason;
        long createTime;
        long msgId;
        int isSend;
        ReplyTarget replyTarget;

        ParsedNotify() {
            chatType = ChatType.UNKNOWN;
            messageType = MessageType.UNKNOWN;
            isSend = 0;
            msgId = 0;
        }
    }

    private static final class LatestMessage {
        String sender = "";
        String text = "";
    }

    private static final class ReplyTarget {
        final PendingIntent actionIntent;
        final RemoteInput remoteInput;

        ReplyTarget(PendingIntent actionIntent, RemoteInput remoteInput) {
            this.actionIntent = actionIntent;
            this.remoteInput = remoteInput;
        }
    }

    private ParsedNotify parseNotification(StatusBarNotification sbn) {
        try {
            Notification n = sbn.getNotification();
            Bundle extras = n.extras;
            if (extras == null) return null;

            String title = textValue(extras, Notification.EXTRA_TITLE);
            String text = textValue(extras, Notification.EXTRA_TEXT);
            String bigText = textValue(extras, Notification.EXTRA_BIG_TEXT);
            String convTitle = textValue(extras, EXTRA_CONVERSATION_TITLE);
            LatestMessage latest = latestMessage(extras);

            if (title.isEmpty() && text.isEmpty() && latest.text.isEmpty()) {
                return null;
            }

            ParsedNotify pn = new ParsedNotify();
            pn.createTime = sbn.getPostTime();
            pn.chatReason = detectGroupReason(
                    extras, convTitle, latest.sender);
            pn.chatType = pn.chatReason == null
                    ? ChatType.PRIVATE
                    : ChatType.GROUP;
            String structuredText = latest.text;
            pn.messageType = detectMessageType(
                    structuredText.isEmpty() ? text : structuredText,
                    bigText);

            // 提取 talker 和 content
            if (pn.chatType == ChatType.GROUP) {
                pn.displayName = !convTitle.isEmpty() ? convTitle : title;
                pn.content = !structuredText.isEmpty()
                        ? structuredText
                        : extractPrefixedContent(text);
            } else {
                pn.displayName = !latest.sender.isEmpty()
                        ? latest.sender
                        : (!convTitle.isEmpty() ? convTitle : title);
                pn.content = !structuredText.isEmpty()
                        ? structuredText
                        : (!bigText.isEmpty()
                                ? extractPrefixedContent(bigText)
                                : extractPrefixedContent(text));
            }
            pn.talker = conversationId(sbn.getKey());
            pn.replyTarget = findReplyTarget(n);

            // 占位内容检测: 如果只有占位符，丢弃
            if (isPlaceholder(pn.content)) return null;

            // 不把可能包含会话标识的通知键发送到服务器。
            pn.eventId = "notify:" + fingerprint(sbn.getKey(), sbn.getPostTime());

            return pn;

        } catch (Exception e) {
            log("parse error: " + e.getClass().getSimpleName());
            return null;
        }
    }

    private static LatestMessage latestMessage(Bundle extras) {
        LatestMessage result = new LatestMessage();
        Parcelable[] bundles = extras.getParcelableArray(Notification.EXTRA_MESSAGES);
        if (bundles == null || bundles.length == 0) return result;
        List<Notification.MessagingStyle.Message> messages =
                Notification.MessagingStyle.Message
                        .getMessagesFromBundleArray(bundles);
        if (messages == null || messages.isEmpty()) return result;
        Notification.MessagingStyle.Message latest =
                messages.get(messages.size() - 1);
        CharSequence body = latest.getText();
        CharSequence sender = latest.getSender();
        result.text = body == null ? "" : body.toString().trim();
        result.sender = sender == null ? "" : sender.toString().trim();
        return result;
    }

    private static String textValue(Bundle extras, String key) {
        CharSequence value = extras.getCharSequence(key);
        return value == null ? "" : value.toString().trim();
    }

    private static boolean isFresh(long createTime) {
        long age = System.currentTimeMillis() - createTime;
        return createTime > 0 && age >= -5_000L && age <= MAX_EVENT_AGE_MS;
    }

    private boolean alreadySeen(String eventId) {
        synchronized (sessionSeenKeys) {
            if (sessionSeenKeys.contains(eventId)) return true;
        }
        Set<String> persisted = seenPrefs.getStringSet(KEY_SEEN_KEYS, null);
        return persisted != null && persisted.contains(eventId);
    }

    private static String fingerprint(String notificationKey, long postTime) {
        String source = String.valueOf(notificationKey) + '\u0000' + postTime;
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(source.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(32);
            for (int i = 0; i < 16; i++) {
                hex.append(String.format(Locale.ROOT, "%02x", digest[i] & 0xff));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException impossible) {
            return Integer.toHexString(source.hashCode())
                    + Long.toHexString(postTime);
        }
    }

    private static String conversationId(String notificationKey) {
        return "notify:" + fingerprint(notificationKey, 0);
    }

    private static ReplyTarget findReplyTarget(Notification notification) {
        Notification.Action[] actions = notification.actions;
        if (actions == null) return null;
        for (Notification.Action action : actions) {
            if (action == null || action.actionIntent == null) continue;
            RemoteInput[] inputs = action.getRemoteInputs();
            if (inputs == null) continue;
            for (RemoteInput input : inputs) {
                if (input != null && input.getAllowFreeFormInput()) {
                    return new ReplyTarget(action.actionIntent, input);
                }
            }
        }
        return null;
    }

    // ---- 聊天类型检测 ----

    private String detectGroupReason(
            Bundle extras, String convTitle, String sender) {

        // 通过 isGroupConversation 判断
        if (extras.getBoolean(EXTRA_IS_GROUP_CONVERSATION, false)) {
            return "group-flag";
        }

        // MessagingStyle 中群名与最新消息发送者不同。
        if (!convTitle.isEmpty() && !sender.isEmpty()
                && !convTitle.equals(sender)) {
            return "conversation-sender";
        }

        return null;
    }

    // ---- 消息类型检测 ----

    private MessageType detectMessageType(String text, String bigText) {
        String display = !bigText.isEmpty() ? bigText : text;
        if (display == null || display.isEmpty()) {
            return MessageType.UNKNOWN;
        }
        String lower = display.toLowerCase(Locale.ROOT);

        if (lower.contains("[图片]") || lower.contains("[图片]")
                || lower.contains("<img>")) {
            return MessageType.IMAGE;
        }
        if (lower.contains("[语音]") || lower.contains("[语音]")
                || lower.contains("<voice>")) {
            return MessageType.VOICE;
        }
        if (lower.contains("[视频]") || lower.contains("[视频]")) {
            return MessageType.VIDEO;
        }
        return MessageType.TEXT;
    }

    // ---- 通知前缀提取 ----

    private String extractPrefixedContent(String text) {
        if (text == null) return "";
        String[] parts = text.split("[:：]", 2);
        if (parts.length == 2 && parts[0].length() <= 20) {
            return parts[1].trim();
        }
        return text;
    }

    // ---- 占位内容检测 ----

    private boolean isPlaceholder(String content) {
        if (content == null || content.isEmpty()) return true;
        String lower = content.toLowerCase(Locale.ROOT);
        return lower.contains("发来一条消息")
                || lower.contains("new message")
                || lower.contains("you have a")
                || lower.contains("新消息")
                || lower.matches("\\d+\\s*条消息")
                || lower.matches("\\d+ messages");
    }

    // ---- 去重 ----

    private void markSeen(String key) {
        synchronized (sessionSeenKeys) {
            sessionSeenKeys.add(key);
        }
        Set<String> persisted = new LinkedHashSet<String>() {
            @Override
            public boolean add(String s) {
                if (size() >= MAX_SEEN_KEYS) {
                    remove(iterator().next());
                }
                return super.add(s);
            }
        };
        Set<String> existing = seenPrefs.getStringSet(KEY_SEEN_KEYS, null);
        if (existing != null) {
            persisted.addAll(existing);
        }
        persisted.add(key);
        seenPrefs.edit().putStringSet(KEY_SEEN_KEYS, persisted).apply();
    }

    // ---- 转发到 BridgeForegroundService ----

    private boolean forwardToBridge(ParsedNotify pn) {
        Messenger destination = agentMessenger;
        if (destination == null) return false;

        Message msg = Message.obtain(null, AgentProtocol.MSG_PRIVATE_TEXT);
        Bundle data = new Bundle();
        data.putString("event_id", pn.eventId);
        data.putString("talker", pn.talker);
        data.putString("display_name", pn.displayName);
        data.putString("content", pn.content);
        data.putLong("create_time", pn.createTime);
        data.putLong("msg_id", pn.msgId);
        data.putLong("msg_svr_id", 0);
        msg.setData(data);

        try {
            destination.send(msg);
            diagnostic("forwarded length=" + pn.content.length());
            return true;
        } catch (RemoteException e) {
            agentMessenger = null;
            diagnostic("forward failed, rebinding");
            return false;
        }
    }

    private void flushPendingNotifications() {
        List<ParsedNotify> snapshot;
        synchronized (pendingNotifications) {
            snapshot = new ArrayList<>(pendingNotifications.values());
        }
        for (ParsedNotify pending : snapshot) {
            if (!forwardToBridge(pending)) {
                scheduleRebind();
                return;
            }
            markSeen(pending.eventId);
            synchronized (pendingNotifications) {
                pendingNotifications.remove(pending.eventId);
            }
        }
    }

    private final class ReplyHandler extends Handler {
        ReplyHandler() {
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
            if (!talker.startsWith("notify:")
                    || content.isEmpty() || content.length() > 2_000) {
                sendCommandResult(commandId, false, "invalid_command");
                return;
            }
            ReplyTarget target;
            synchronized (replyTargets) {
                target = replyTargets.get(talker);
            }
            if (target == null) {
                sendCommandResult(commandId, false, "reply_target_unavailable");
                return;
            }
            Intent fillIn = new Intent();
            Bundle results = new Bundle();
            results.putCharSequence(target.remoteInput.getResultKey(), content);
            RemoteInput.addResultsToIntent(
                    new RemoteInput[]{target.remoteInput},
                    fillIn,
                    results);
            try {
                target.actionIntent.send(
                        NotificationInboundAdapter.this,
                        0,
                        fillIn);
                sendCommandResult(commandId, true, "");
            } catch (PendingIntent.CanceledException error) {
                synchronized (replyTargets) {
                    replyTargets.remove(talker);
                }
                sendCommandResult(commandId, false, "reply_target_expired");
            } catch (RuntimeException error) {
                sendCommandResult(commandId, false, "reply_failed");
            }
        }
    }

    private void sendCommandResult(String commandId, boolean ok, String error) {
        Messenger destination = agentMessenger;
        if (destination == null) return;
        Message result = Message.obtain(null, AgentProtocol.MSG_COMMAND_RESULT);
        Bundle data = new Bundle();
        data.putString("command_id", commandId);
        data.putBoolean("ok", ok);
        data.putString("error", error);
        result.setData(data);
        try {
            destination.send(result);
        } catch (RemoteException ignored) {
            agentMessenger = null;
            scheduleRebind();
        }
    }

    // ---- BridgeForegroundService 绑定 ----

    private void bindAgent() {
        if (binding) return;
        binding = true;

        Intent intent = new Intent();
        intent.setComponent(new ComponentName(
                AgentProtocol.AGENT_PACKAGE,
                AgentProtocol.SERVICE_CLASS));

        try {
            boolean bound = bindService(intent, serviceConnection,
                    Context.BIND_AUTO_CREATE);
            if (!bound) {
                binding = false;
                scheduleRebind();
            } else {
                agentBound = true;
            }
        } catch (SecurityException e) {
            binding = false;
            scheduleRebind();
        }
    }

    private void unbindAgent() {
        mainHandler.removeCallbacks(rebindTask);
        binding = false;
        agentMessenger = null;
        if (!agentBound) return;
        try {
            unbindService(serviceConnection);
        } catch (Exception ignored) {
        } finally {
            agentBound = false;
        }
    }

    private final ServiceConnection serviceConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            agentMessenger = new Messenger(binder);
            binding = false;
            log("bridge connected");
            Message register = Message.obtain(
                    null,
                    AgentProtocol.MSG_REGISTER_NOTIFICATION);
            register.replyTo = replyMessenger;
            try {
                agentMessenger.send(register);
            } catch (RemoteException error) {
                agentMessenger = null;
                scheduleRebind();
                return;
            }
            flushPendingNotifications();
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            agentMessenger = null;
            binding = false;
            // The binding is still active; Android will call onServiceConnected
            // again when the service process returns.
        }

        @Override
        public void onBindingDied(ComponentName name) {
            agentMessenger = null;
            binding = false;
            releaseDeadBinding();
            scheduleRebind();
        }

        @Override
        public void onNullBinding(ComponentName name) {
            agentMessenger = null;
            binding = false;
            releaseDeadBinding();
            scheduleRebind();
        }
    };

    private void releaseDeadBinding() {
        if (!agentBound) return;
        try {
            unbindService(serviceConnection);
        } catch (Exception ignored) {
        } finally {
            agentBound = false;
        }
    }

    private void scheduleRebind() {
        mainHandler.removeCallbacks(rebindTask);
        mainHandler.postDelayed(rebindTask, 5000);
    }

    // ---- 日志 ----

    private static void log(String message) {
        android.util.Log.i(TAG, message);
    }

    private static void diagnostic(String message) {
        android.util.Log.d(TAG, message);
    }

    private void diagnosticDrop(String reason) {
        if (diagnosticEvents >= MAX_DIAGNOSTIC_EVENTS) return;
        diagnosticEvents += 1;
        diagnostic("ignored reason=" + reason);
    }
}
