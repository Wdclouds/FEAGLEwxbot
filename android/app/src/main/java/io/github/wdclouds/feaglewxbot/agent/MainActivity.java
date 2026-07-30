package io.github.wdclouds.feaglewxbot.agent;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.UUID;

public final class MainActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private EditText endpointInput;
    private EditText tokenInput;
    private TextView statusView;
    private SharedPreferences prefs;

    private final Runnable refreshStatus = new Runnable() {
        @Override
        public void run() {
            String status = prefs.getString(AgentProtocol.KEY_STATUS, "未启动 / stopped");
            String hook = prefs.getString(AgentProtocol.KEY_HOOK_STATUS, "未连接 / disconnected");
            String notifications = notificationAccessEnabled()
                    ? "已开启 / enabled"
                    : "未开启 / disabled";
            statusView.setText(
                    "云端连接 / Cloud: " + status
                            + "\n通知读取 / Notifications: " + notifications
                            + "\n回复通道 / Reply channel: " + hook);
            handler.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(AgentProtocol.PREFS, MODE_PRIVATE);
        ensureDeviceId();
        setContentView(buildContent());

        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 100);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        handler.post(refreshStatus);
    }

    @Override
    protected void onPause() {
        handler.removeCallbacks(refreshStatus);
        super.onPause();
    }

    private ScrollView buildContent() {
        int pad = dp(20);
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("FEAGLEwxbot Android Agent");
        title.setTextSize(24);
        title.setTextColor(Color.rgb(20, 80, 150));
        title.setPadding(0, 0, 0, dp(12));
        body.addView(title);

        TextView hint = new TextView(this);
        hint.setText(
                "1. 开启通知读取权限，用于接收微信私聊文本。\n"
                        + "2. 填写 Bridge 的 wss:// 地址与设备 Token。\n"
                        + "3. 如需自动回复，再启用 Vector 发送模块并重启微信。\n\n"
                        + "首期仅处理私聊文本，不读取历史消息。");
        hint.setTextSize(15);
        hint.setPadding(0, 0, 0, dp(16));
        body.addView(hint);

        endpointInput = new EditText(this);
        endpointInput.setHint("wss://example.com/android");
        endpointInput.setSingleLine(true);
        endpointInput.setInputType(InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_VARIATION_URI);
        endpointInput.setText(prefs.getString(AgentProtocol.KEY_ENDPOINT, ""));
        body.addView(label("Bridge 地址 / Endpoint"));
        body.addView(endpointInput, fullWidth());

        tokenInput = new EditText(this);
        tokenInput.setHint("设备 Token / Device token");
        tokenInput.setSingleLine(true);
        tokenInput.setInputType(InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        tokenInput.setText(prefs.getString(AgentProtocol.KEY_TOKEN, ""));
        body.addView(label("鉴权 / Authentication"));
        body.addView(tokenInput, fullWidth());

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        actions.setPadding(0, dp(16), 0, dp(12));

        Button start = new Button(this);
        start.setText("保存并启动 / Start");
        start.setOnClickListener(v -> startAgent());
        actions.addView(start, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        Button stop = new Button(this);
        stop.setText("停止 / Stop");
        stop.setOnClickListener(v -> stopAgent());
        actions.addView(stop, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        body.addView(actions);

        Button notificationAccess = new Button(this);
        notificationAccess.setText("通知读取权限 / Notification access");
        notificationAccess.setOnClickListener(v -> {
            Intent settings = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
            startActivity(settings);
        });
        body.addView(notificationAccess, fullWidth());

        statusView = new TextView(this);
        statusView.setTextSize(16);
        statusView.setTextColor(Color.DKGRAY);
        statusView.setPadding(dp(12), dp(12), dp(12), dp(12));
        body.addView(statusView, fullWidth());

        TextView idView = new TextView(this);
        idView.setText("设备 ID / Device ID\n"
                + prefs.getString(AgentProtocol.KEY_DEVICE_ID, ""));
        idView.setTextSize(12);
        idView.setTextColor(Color.GRAY);
        idView.setPadding(0, dp(20), 0, 0);
        body.addView(idView);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(body);
        return scroll;
    }

    private TextView label(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(14);
        view.setPadding(0, dp(12), 0, 0);
        return view;
    }

    private LinearLayout.LayoutParams fullWidth() {
        return new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private void startAgent() {
        String endpoint = endpointInput.getText().toString().trim();
        String token = tokenInput.getText().toString().trim();
        prefs.edit()
                .putString(AgentProtocol.KEY_ENDPOINT, endpoint)
                .putString(AgentProtocol.KEY_TOKEN, token)
                .apply();

        Intent intent = new Intent(this, BridgeForegroundService.class)
                .setAction(AgentProtocol.ACTION_START);
        startForegroundService(intent);
    }

    private void stopAgent() {
        Intent intent = new Intent(this, BridgeForegroundService.class)
                .setAction(AgentProtocol.ACTION_STOP);
        startService(intent);
    }

    private void ensureDeviceId() {
        if (!prefs.contains(AgentProtocol.KEY_DEVICE_ID)) {
            prefs.edit().putString(
                    AgentProtocol.KEY_DEVICE_ID,
                    UUID.randomUUID().toString()).apply();
        }
    }

    private boolean notificationAccessEnabled() {
        String enabled = Settings.Secure.getString(
                getContentResolver(),
                "enabled_notification_listeners");
        return enabled != null && enabled.contains(getPackageName());
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
