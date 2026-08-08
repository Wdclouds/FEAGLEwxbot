package io.github.wdclouds.feaglewxbot.agent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Binder;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.RemoteException;
import android.util.Log;

import org.java_websocket.client.WebSocketClient;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.handshake.ServerHandshake;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.URI;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

public final class BridgeForegroundService extends Service {
    private static final String TAG = "FEAGLE-Agent";
    private static final String CHANNEL_ID = "feagle_bridge";
    private static final int NOTIFICATION_ID = 6190;
    private static final int MAX_TRANSIENT_QUEUE = 100;
    private static final int MAX_PENDING_EVENTS = 512;
    private static final int MAX_RECENT_EVENTS = 1024;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final ArrayDeque<String> transientQueue = new ArrayDeque<>();
    private final LinkedHashMap<String, String> pendingEvents = new LinkedHashMap<>();
    private final Map<String, Runnable> retryTasks = new HashMap<>();
    private final Map<String, Boolean> recentInboundEvents =
            new LinkedHashMap<String, Boolean>(MAX_RECENT_EVENTS + 1, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, Boolean> eldest) {
                    return size() > MAX_RECENT_EVENTS;
                }
            };
    private final Messenger inboundMessenger = new Messenger(new InboundHandler());

    private SharedPreferences prefs;
    private Messenger hookMessenger;
    private Messenger notificationMessenger;
    private WebSocketClient socket;
    private int reconnectAttempt;

    private final Runnable heartbeat = new Runnable() {
        @Override
        public void run() {
            if (!running.get()) return;
            if (socket != null && socket.isOpen()) {
                JSONObject event = baseEnvelope("heartbeat");
                put(event, "timestamp", System.currentTimeMillis());
                socket.send(event.toString());
            }
            mainHandler.postDelayed(this, 25_000);
        }
    };

    private final Runnable reconnect = this::connect;

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences(AgentProtocol.PREFS, MODE_PRIVATE);
        loadReliableState();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? AgentProtocol.ACTION_START : intent.getAction();
        if (AgentProtocol.ACTION_STOP.equals(action)) {
            stopAgent();
            return START_NOT_STICKY;
        }

        startForeground(NOTIFICATION_ID, notification("正在启动 / starting"));
        if (running.compareAndSet(false, true)) {
            Log.i(TAG, "onStartCommand first-run, connecting");
            setStatus("正在连接 / connecting");
            mainHandler.post(heartbeat);
            connect();
        } else {
            Log.i(TAG, "onStartCommand re-run, reconnecting");
            setStatus("正在重新连接 / reconnecting");
            mainHandler.removeCallbacks(reconnect);
            mainHandler.post(this::connect);
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        int uid = Binder.getCallingUid();
        if (!isAllowedUid(uid)) {
            Log.w(TAG, "Rejected binder client uid=" + uid);
            return null;
        }
        return inboundMessenger.getBinder();
    }

    @Override
    public void onDestroy() {
        persistReliableState();
        stopSocket();
        cancelRetryTasks();
        mainHandler.removeCallbacksAndMessages(null);
        running.set(false);
        super.onDestroy();
    }

    private final class InboundHandler extends Handler {
        InboundHandler() {
            super(Looper.getMainLooper());
        }

        @Override
        public void handleMessage(Message message) {
            if (!isAllowedUid(message.sendingUid)) {
                Log.w(TAG, "Rejected message uid=" + message.sendingUid);
                return;
            }
            switch (message.what) {
                case AgentProtocol.MSG_REGISTER_HOOK:
                    hookMessenger = message.replyTo;
                    prefs.edit().putString(
                            AgentProtocol.KEY_HOOK_STATUS,
                            "已连接 / connected").apply();
                    sendHookStatus();
                    break;
                case AgentProtocol.MSG_REGISTER_NOTIFICATION:
                    notificationMessenger = message.replyTo;
                    prefs.edit().putString(
                            AgentProtocol.KEY_HOOK_STATUS,
                            "通知回复已连接 / notification reply connected").apply();
                    sendHookStatus();
                    break;
                case AgentProtocol.MSG_PRIVATE_TEXT:
                    forwardPrivateText(message.getData());
                    break;
                case AgentProtocol.MSG_GROUP_TEXT:
                    forwardGroupText(message.getData());
                    break;
                case AgentProtocol.MSG_PRIVATE_IMAGE:
                    forwardPrivateImage(message.getData());
                    break;
                case AgentProtocol.MSG_GROUP_IMAGE:
                    forwardGroupImage(message.getData());
                    break;
                case AgentProtocol.MSG_SELF_AVATAR:
                    forwardSelfAvatar(message.getData());
                    break;
                case AgentProtocol.MSG_COMMAND_RESULT:
                    forwardCommandResult(message.getData());
                    break;
                default:
                    super.handleMessage(message);
            }
        }
    }

    private void forwardGroupImage(Bundle data) {
        String eventId = data.getString("event_id", "").trim();
        String talker = data.getString("talker", "").trim();
        String sender = data.getString("sender", "").trim();
        String imageBase64 = data.getString("image_base64", "");
        String imageFormat = data.getString("image_format", "");
        // 群聊图片的 sender 解析尚未实现（Hook 暂传空），先静默丢弃，
        // 待群聊图片策略确定后补齐（MENTION_ONLY / 白名单 / sender 提取）。
        if (sender.isEmpty()) {
            return;
        }
        if (eventId.isEmpty() || !validGroupTalker(talker)
                || !validGroupSender(sender)
                || imageBase64.isEmpty() || imageBase64.length() > 7 * 1024 * 1024) {
            return;
        }
        if (recentInboundEvents.containsKey(eventId)) return;

        JSONObject event = baseEnvelope("group_image");
        put(event, "eventId", eventId);
        put(event, "talker", talker);
        put(event, "sender", sender);
        put(event, "imageBase64", imageBase64);
        put(event, "mime", data.getString("mime", "image/jpeg"));
        if (!imageFormat.isEmpty()) {
            put(event, "imageFormat", imageFormat);
        }
        put(event, "imageSize", data.getInt("image_size", 0));
        put(event, "createTime", data.getLong("create_time", 0));
        put(event, "msgId", data.getLong("msg_id", 0));
        put(event, "msgSvrId", data.getLong("msg_svr_id", 0));
        recentInboundEvents.put(eventId, Boolean.TRUE);
        sendOrQueueTransient(event.toString());
    }

    private void forwardPrivateImage(Bundle data) {
        String eventId = data.getString("event_id", "").trim();
        String talker = data.getString("talker", "").trim();
        String displayName = data.getString("display_name", "").trim();
        String imageBase64 = data.getString("image_base64", "");
        String imageFormat = data.getString("image_format", "");
        if (eventId.isEmpty() || !validPrivateTalker(talker)
                || imageBase64.isEmpty() || imageBase64.length() > 7 * 1024 * 1024) {
            return;
        }
        if (recentInboundEvents.containsKey(eventId)) return;

        JSONObject event = baseEnvelope("private_image");
        put(event, "eventId", eventId);
        put(event, "talker", talker);
        put(event, "displayName", displayName);
        put(event, "imageBase64", imageBase64);
        put(event, "mime", data.getString("mime", "image/jpeg"));
        if (!imageFormat.isEmpty()) {
            put(event, "imageFormat", imageFormat);
        }
        put(event, "imageSize", data.getInt("image_size", 0));
        put(event, "createTime", data.getLong("create_time", 0));
        put(event, "msgId", data.getLong("msg_id", 0));
        put(event, "msgSvrId", data.getLong("msg_svr_id", 0));
        recentInboundEvents.put(eventId, Boolean.TRUE);
        sendOrQueueTransient(event.toString());
    }

    private void forwardPrivateText(Bundle data) {
        String eventId = data.getString("event_id", "").trim();
        String talker = data.getString("talker", "").trim();
        String displayName = data.getString("display_name", "").trim();
        String content = data.getString("content", "");
        if (eventId.isEmpty() || !validPrivateTalker(talker)
                || content.isEmpty() || content.length() > 2_000) {
            return;
        }

        String existing = pendingEvents.get(eventId);
        if (existing != null) {
            sendPendingPayload(existing);
            return;
        }
        if (recentInboundEvents.containsKey(eventId)) return;
        if (pendingEvents.size() >= MAX_PENDING_EVENTS) {
            Log.w(TAG, "Reliable event queue is full");
            setStatus("待发送队列已满 / pending queue full");
            return;
        }

        JSONObject event = baseEnvelope("private_text");
        put(event, "eventId", eventId);
        put(event, "talker", talker);
        put(event, "displayName", displayName);
        put(event, "content", content);
        put(event, "createTime", data.getLong("create_time", 0));
        put(event, "msgId", data.getLong("msg_id", 0));
        put(event, "msgSvrId", data.getLong("msg_svr_id", 0));

        String payload = event.toString();
        recentInboundEvents.put(eventId, Boolean.TRUE);
        pendingEvents.put(eventId, payload);
        persistReliableState();
        sendPendingPayload(payload);
    }

    private void forwardGroupText(Bundle data) {
        String eventId = data.getString("event_id", "").trim();
        String talker = data.getString("talker", "").trim();
        String sender = data.getString("sender", "").trim();
        String content = data.getString("content", "");
        String groupName = data.getString("group_name", "").trim();
        if (eventId.isEmpty() || !validGroupTalker(talker)
                || !validGroupSender(sender)
                || content.isEmpty() || content.length() > 2_000) {
            return;
        }

        String existing = pendingEvents.get(eventId);
        if (existing != null) {
            sendPendingPayload(existing);
            return;
        }
        if (recentInboundEvents.containsKey(eventId)) return;
        if (pendingEvents.size() >= MAX_PENDING_EVENTS) {
            Log.w(TAG, "Reliable event queue is full");
            setStatus("待发送队列已满 / pending queue full");
            return;
        }

        JSONObject event = baseEnvelope("group_text");
        put(event, "eventId", eventId);
        put(event, "talker", talker);
        put(event, "sender", sender);
        put(event, "content", content);
        if (!groupName.isEmpty()) {
            put(event, "groupName", groupName);
        }
        put(event, "mentioned", data.getBoolean("mentioned", false));
        put(event, "createTime", data.getLong("create_time", 0));
        put(event, "msgId", data.getLong("msg_id", 0));
        put(event, "msgSvrId", data.getLong("msg_svr_id", 0));
        put(event, "quoteSvrId", data.getLong("quote_svr_id", 0));

        String payload = event.toString();
        recentInboundEvents.put(eventId, Boolean.TRUE);
        pendingEvents.put(eventId, payload);
        persistReliableState();
        sendPendingPayload(payload);
    }

    private void forwardSelfAvatar(Bundle data) {
        String wxid = data.getString("wxid", "").trim();
        String nickname = data.getString("nickname", "").trim();
        String imageBase64 = data.getString("image_base64", "");
        if (wxid.isEmpty() || imageBase64.isEmpty()) {
            return;
        }
        JSONObject event = baseEnvelope("self_avatar");
        put(event, "wxid", wxid);
        put(event, "nickname", nickname);
        put(event, "avatarBase64", imageBase64);
        put(event, "avatarSize", data.getInt("image_size", 0));
        sendOrQueueTransient(event.toString());
    }

    private void forwardCommandResult(Bundle data) {
        JSONObject event = baseEnvelope("command_result");
        put(event, "commandId", data.getString("command_id", ""));
        put(event, "ok", data.getBoolean("ok", false));
        put(event, "error", data.getString("error", ""));
        sendOrQueueTransient(event.toString());
    }

    private void sendHookStatus() {
        JSONObject event = baseEnvelope("hook_status");
        put(event, "connected", senderAvailable());
        sendOrQueueTransient(event.toString());
    }

    private void sendPendingPayload(String payload) {
        if (socket == null || !socket.isOpen()) return;
        try {
            socket.send(payload);
        } catch (RuntimeException error) {
            Log.w(TAG, "Reliable event send failed: "
                    + error.getClass().getSimpleName());
        }
    }

    private void sendOrQueueTransient(String payload) {
        if (socket != null && socket.isOpen()) {
            socket.send(payload);
            return;
        }
        if (transientQueue.size() >= MAX_TRANSIENT_QUEUE) {
            transientQueue.removeFirst();
        }
        transientQueue.addLast(payload);
    }

    private void connect() {
        if (!running.get()) return;
        Log.i(TAG, "connect() endpoint="
                + prefs.getString(AgentProtocol.KEY_ENDPOINT, ""));
        String endpoint = prefs.getString(AgentProtocol.KEY_ENDPOINT, "").trim();
        if (!validEndpoint(endpoint)) {
            setStatus("地址无效 / invalid endpoint");
            scheduleReconnect();
            return;
        }

        stopSocket();
        try {
            Map<String, String> headers = new HashMap<>();
            String token = prefs.getString(AgentProtocol.KEY_TOKEN, "").trim();
            String pairingCode = prefs.getString(
                    AgentProtocol.KEY_PAIRING_CODE, "").trim();
            boolean pairingMode = token.isEmpty();
            if (pairingMode && !pairingCode.matches("\\d{8}")) {
                setStatus("请输入 8 位配对码 / pairing code required");
                return;
            }
            if (!pairingMode) {
                headers.put("Authorization", "Bearer " + token);
            }
            socket = new WebSocketClient(
                    URI.create(pairingMode ? pairingEndpoint(endpoint) : endpoint),
                    new Draft_6455(), headers, 20_000) {
                @Override
                public void onOpen(ServerHandshake handshake) {
                    Log.i(TAG, "WebSocket onOpen");
                    mainHandler.post(() -> {
                        if (BridgeForegroundService.this.socket != this) return;
                        reconnectAttempt = 0;
                        if (pairingMode) {
                            setStatus("正在配对 / pairing");
                            JSONObject request = baseEnvelope("pair_request");
                            put(request, "pairingCode", pairingCode);
                            send(request.toString());
                            return;
                        }
                        setStatus("已连接 / connected");
                        JSONObject hello = baseEnvelope("hello");
                        put(hello, "wechatVersion", installedWechatVersion());
                        put(hello, "hookConnected", senderAvailable());
                        send(hello.toString());
                        for (String payload : pendingEvents.values()) {
                            if (!isOpen()) break;
                            send(payload);
                        }
                        while (!transientQueue.isEmpty() && isOpen()) {
                            send(transientQueue.removeFirst());
                        }
                    });
                }

                @Override
                public void onMessage(String payload) {
                    mainHandler.post(() -> {
                        if (BridgeForegroundService.this.socket == this) {
                            handleCloudMessage(payload);
                        }
                    });
                }

                @Override
                public void onClose(int code, String reason, boolean remote) {
                    Log.w(TAG, "WebSocket onClose code=" + code
                            + " reason=" + reason);
                    mainHandler.post(() -> {
                        if (BridgeForegroundService.this.socket != this) return;
                        BridgeForegroundService.this.socket = null;
                        setStatus("已断开 / disconnected (" + code + ")");
                        scheduleReconnect();
                    });
                }

                @Override
                public void onError(Exception error) {
                    if (BridgeForegroundService.this.socket != this) return;
                    Log.w(TAG, "WebSocket error: "
                            + error.getClass().getSimpleName());
                }
            };
            setStatus("正在连接 / connecting");
            socket.connect();
        } catch (RuntimeException error) {
            Log.w(TAG, "Connect setup failed", error);
            setStatus("连接失败 / connect failed");
            scheduleReconnect();
        }
    }

    private void handleCloudMessage(String payload) {
        try {
            JSONObject message = new JSONObject(payload);
            String type = message.optString("type");
            if ("pair_ack".equals(type)) {
                handlePairAck(message);
                return;
            }
            if ("pair_rejected".equals(type)) {
                handlePairRejected(message);
                return;
            }
            if ("pong".equals(type) || "hello_ack".equals(type)) return;
            if ("event_ack".equals(type)) {
                acknowledgeEvent(message.optString("eventId"));
                return;
            }
            if ("event_nack".equals(type)) {
                retryEvent(
                        message.optString("eventId"),
                        message.optLong("retryAfterMs", 3_000));
                return;
            }
            if ("send_text".equals(type)) {
                handleSendText(message);
                return;
            }
            sendCommandError(message.optString("commandId"), "unsupported_command");
        } catch (JSONException error) {
            sendCommandError("", "invalid_json");
        }
    }

    private void handlePairAck(JSONObject message) {
        String expectedDeviceId = prefs.getString(
                AgentProtocol.KEY_DEVICE_ID, "").trim();
        String deviceId = message.optString("deviceId").trim();
        String token = message.optString("token").trim();
        if (!expectedDeviceId.equals(deviceId) || token.length() < 32) {
            handlePairRejected(null);
            return;
        }
        boolean saved = prefs.edit()
                .putString(AgentProtocol.KEY_TOKEN, token)
                .remove(AgentProtocol.KEY_PAIRING_CODE)
                .commit();
        if (!saved) {
            setStatus("配对信息保存失败 / pairing save failed");
            stopSocket();
            return;
        }
        setStatus("配对成功，正在连接 / paired, connecting");
        stopSocket();
        mainHandler.postDelayed(reconnect, 250);
    }

    private void handlePairRejected(JSONObject message) {
        String reason = message == null
                ? "invalid_response"
                : message.optString("reason", "rejected");
        prefs.edit().remove(AgentProtocol.KEY_PAIRING_CODE).apply();
        setStatus("配对失败 / pairing failed (" + reason + ")");
        stopSocket();
    }

    private void acknowledgeEvent(String eventIdValue) {
        String eventId = eventIdValue == null ? "" : eventIdValue.trim();
        if (eventId.isEmpty() || pendingEvents.remove(eventId) == null) return;
        Runnable retry = retryTasks.remove(eventId);
        if (retry != null) mainHandler.removeCallbacks(retry);
        persistReliableState();
    }

    private void retryEvent(String eventIdValue, long requestedDelayMs) {
        String eventId = eventIdValue == null ? "" : eventIdValue.trim();
        if (!pendingEvents.containsKey(eventId)) return;
        Runnable previous = retryTasks.remove(eventId);
        if (previous != null) mainHandler.removeCallbacks(previous);
        long delayMs = Math.max(1_000, Math.min(requestedDelayMs, 60_000));
        Runnable task = () -> {
            retryTasks.remove(eventId);
            String payload = pendingEvents.get(eventId);
            if (payload != null) sendPendingPayload(payload);
        };
        retryTasks.put(eventId, task);
        mainHandler.postDelayed(task, delayMs);
    }

    private void handleSendText(JSONObject command) {
        String commandId = command.optString("commandId");
        String talker = command.optString("talker").trim();
        String content = command.optString("content");
        boolean group = "group".equals(command.optString("chatType"));
        boolean validTalker = group
                ? validGroupTalker(talker)
                : validPrivateTalker(talker);
        if (commandId.isEmpty() || !validTalker
                || content.isEmpty() || content.length() > 2_000) {
            sendCommandError(commandId, "invalid_command");
            return;
        }
        Messenger sender = !group && talker.startsWith("notify:")
                ? notificationMessenger
                : hookMessenger;
        if (sender == null) {
            sendCommandError(commandId, "sender_not_connected");
            return;
        }

        Message message = Message.obtain(null, AgentProtocol.MSG_SEND_TEXT);
        Bundle data = new Bundle();
        data.putString("command_id", commandId);
        data.putString("talker", talker);
        data.putString("content", content);
        data.putString("chat_type", group ? "group" : "private");
        message.setData(data);
        try {
            sender.send(message);
        } catch (RemoteException error) {
            if (sender == notificationMessenger) {
                notificationMessenger = null;
            } else {
                hookMessenger = null;
            }
            prefs.edit().putString(
                    AgentProtocol.KEY_HOOK_STATUS,
                    "已断开 / disconnected").apply();
            sendCommandError(commandId, "sender_disconnected");
        }
    }

    private void sendCommandError(String commandId, String error) {
        JSONObject event = baseEnvelope("command_result");
        put(event, "commandId", commandId);
        put(event, "ok", false);
        put(event, "error", error);
        sendOrQueueTransient(event.toString());
    }

    private JSONObject baseEnvelope(String type) {
        JSONObject event = new JSONObject();
        put(event, "type", type);
        put(event, "protocol", "feagle.android.v1");
        put(event, "deviceId", prefs.getString(AgentProtocol.KEY_DEVICE_ID, ""));
        return event;
    }

    private void scheduleReconnect() {
        if (!running.get()) return;
        mainHandler.removeCallbacks(reconnect);
        long delay = Math.min(60_000L, 1_000L << Math.min(reconnectAttempt, 6));
        reconnectAttempt++;
        mainHandler.postDelayed(reconnect, delay);
    }

    private void stopAgent() {
        running.set(false);
        persistReliableState();
        cancelRetryTasks();
        mainHandler.removeCallbacksAndMessages(null);
        stopSocket();
        hookMessenger = null;
        notificationMessenger = null;
        prefs.edit()
                .putString(AgentProtocol.KEY_STATUS, "已停止 / stopped")
                .putString(AgentProtocol.KEY_HOOK_STATUS, "未连接 / disconnected")
                .apply();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void stopSocket() {
        WebSocketClient current = socket;
        socket = null;
        if (current != null) {
            try {
                current.close();
            } catch (RuntimeException ignored) {
                // Best-effort cleanup.
            }
        }
    }

    private void cancelRetryTasks() {
        for (Runnable task : retryTasks.values()) {
            mainHandler.removeCallbacks(task);
        }
        retryTasks.clear();
    }

    private void loadReliableState() {
        pendingEvents.clear();
        recentInboundEvents.clear();
        try {
            JSONArray pending = new JSONArray(
                    prefs.getString(AgentProtocol.KEY_PENDING_EVENTS, "[]"));
            for (int i = 0; i < pending.length() && i < MAX_PENDING_EVENTS; i++) {
                JSONObject item = pending.optJSONObject(i);
                if (item == null) continue;
                String eventId = item.optString("eventId").trim();
                String payload = item.optString("payload");
                if (!eventId.isEmpty() && !payload.isEmpty()) {
                    pendingEvents.put(eventId, payload);
                    recentInboundEvents.put(eventId, Boolean.TRUE);
                }
            }
            JSONArray recent = new JSONArray(
                    prefs.getString(AgentProtocol.KEY_RECENT_EVENTS, "[]"));
            int first = Math.max(0, recent.length() - MAX_RECENT_EVENTS);
            for (int i = first; i < recent.length(); i++) {
                String eventId = recent.optString(i).trim();
                if (!eventId.isEmpty()) recentInboundEvents.put(eventId, Boolean.TRUE);
            }
        } catch (JSONException error) {
            Log.w(TAG, "Reliable state was invalid; starting empty");
            pendingEvents.clear();
            recentInboundEvents.clear();
        }
    }

    private void persistReliableState() {
        JSONArray pending = new JSONArray();
        for (Map.Entry<String, String> entry : pendingEvents.entrySet()) {
            JSONObject item = new JSONObject();
            put(item, "eventId", entry.getKey());
            put(item, "payload", entry.getValue());
            pending.put(item);
        }
        JSONArray recent = new JSONArray();
        for (String eventId : recentInboundEvents.keySet()) recent.put(eventId);
        boolean saved = prefs.edit()
                .putString(AgentProtocol.KEY_PENDING_EVENTS, pending.toString())
                .putString(AgentProtocol.KEY_RECENT_EVENTS, recent.toString())
                .commit();
        if (!saved) Log.w(TAG, "Reliable state commit failed");
    }

    private void setStatus(String status) {
        prefs.edit().putString(AgentProtocol.KEY_STATUS, status).apply();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.notify(NOTIFICATION_ID, notification(status));
    }

    private Notification notification(String status) {
        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("FEAGLEwxbot Agent")
                .setContentText(status)
                .setOngoing(true)
                .build();
    }

    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "FEAGLEwxbot Bridge",
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Android Hook bridge connection status");
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private boolean isAllowedUid(int uid) {
        if (uid == getApplicationInfo().uid) return true;
        String[] packages = getPackageManager().getPackagesForUid(uid);
        if (packages == null) return false;
        for (String packageName : packages) {
            if (AgentProtocol.WECHAT_PACKAGE.equals(packageName)) return true;
        }
        return false;
    }

    private String installedWechatVersion() {
        try {
            return getPackageManager().getPackageInfo(
                    AgentProtocol.WECHAT_PACKAGE, 0).versionName;
        } catch (PackageManager.NameNotFoundException error) {
            return "not_installed";
        }
    }

    private boolean validEndpoint(String endpoint) {
        try {
            URI uri = URI.create(endpoint.trim());
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (scheme == null || host == null) return false;
            if ("wss".equalsIgnoreCase(scheme)) return true;
            if (!"ws".equalsIgnoreCase(scheme)) return false;

            String lowerHost = host.toLowerCase(Locale.ROOT);
            // 2026-08-08：放宽——endpoint 来自本地配置（prefs），
            // 允许任意主机（公网 IP / 域名 / Tailscale IP / localhost）。
            return !lowerHost.isEmpty();
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    private String pairingEndpoint(String endpoint) {
        return endpoint + (endpoint.contains("?") ? "&" : "?") + "mode=pair";
    }

    private boolean isTailscaleIpv4(String host) {
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return false;
        try {
            int first = Integer.parseInt(parts[0]);
            int second = Integer.parseInt(parts[1]);
            for (String part : parts) {
                int value = Integer.parseInt(part);
                if (value < 0 || value > 255) return false;
            }
            return first == 100 && second >= 64 && second <= 127;
        } catch (NumberFormatException error) {
            return false;
        }
    }

    private boolean validPrivateTalker(String talker) {
        String lower = talker.toLowerCase(Locale.ROOT);
        return !lower.isEmpty()
                && !lower.endsWith("@chatroom")
                && !lower.endsWith("@openim")
                && !lower.startsWith("gh_")
                && !lower.equals("filehelper")
                && !lower.equals("newsapp")
                && !lower.equals("fmessage")
                && !lower.equals("weixin")
                && (!lower.contains(":")
                        || lower.matches("notify:[0-9a-f]{32}"))
                && lower.length() <= 256;
    }

    private boolean validGroupTalker(String talker) {
        String lower = talker.toLowerCase(Locale.ROOT);
        return lower.endsWith("@chatroom")
                && !lower.contains(":")
                && lower.length() <= 256;
    }

    private boolean validGroupSender(String sender) {
        String normalized = sender.trim();
        return !normalized.isEmpty()
                && !normalized.endsWith("@chatroom")
                && !normalized.contains(":")
                && normalized.length() <= 256;
    }

    private boolean senderAvailable() {
        return notificationMessenger != null || hookMessenger != null;
    }

    private static void put(JSONObject object, String key, Object value) {
        try {
            object.put(key, value);
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}
