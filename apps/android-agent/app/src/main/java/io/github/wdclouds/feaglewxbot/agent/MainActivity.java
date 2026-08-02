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
    private EditText pairingCodeInput;
    private Button startButton;
    private TextView statusView;
    private SharedPreferences prefs;

    private final Runnable refreshStatus = new Runnable() {
        @Override
        public void run() {
            String status = prefs.getString(
                    AgentProtocol.KEY_STATUS, "未启动 / stopped");
            String hook = prefs.getString(
                    AgentProtocol.KEY_HOOK_STATUS, "未连接 / disconnected");
            boolean isPaired = !prefs.getString(AgentProtocol.KEY_TOKEN, "").isEmpty();
            String paired = !isPaired
                    ? "未配对 / not paired"
                    : "已配对 / paired";
            if (isPaired && pairingCodeInput != null
                    && pairingCodeInput.length() > 0) {
                pairingCodeInput.setText("");
            }
            if (startButton != null) {
                startButton.setText(isPaired
                        ? "保存并重连 / Save & Reconnect"
                        : "配对并启动 / Pair & Start");
            }
            String notifications = notificationAccessEnabled()
                    ? "已开启 / enabled"
                    : "未开启 / disabled";
            statusView.setText(
                    "云端连接 / Cloud: " + status
                            + "\n设备配对 / Pairing: " + paired
                            + "\n消息通道 / Message channel: " + hook
                            + "\n通知兜底 / Notifications: " + notifications);
            handler.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(AgentProtocol.PREFS, MODE_PRIVATE);
        ensureDeviceId();
        setContentView(buildContent());
        applyIntentPrefill(getIntent());

        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 100);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        applyIntentPrefill(intent);
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
                "1. 在 LSPosed/Vector 中启用模块，作用域只选微信。\n"
                        + "2. 填写 Bridge 的 wss:// 地址和 8 位一次性配对码。\n"
                        + "3. 点击配对并启动；成功后配对码自动清除，无需保存长期 Token。\n"
                        + "4. 重启微信，确认消息通道和云端连接均显示已连接。\n\n"
                        + "1. Enable the module for WeChat only.\n"
                        + "2. Enter the Bridge endpoint and the 8-digit one-time code.\n"
                        + "3. Tap Pair & Start. The long-lived token is stored automatically.\n\n"
                        + "首期仅支持微信 8.0.70 私聊文本，不读取历史消息。");
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

        pairingCodeInput = new EditText(this);
        pairingCodeInput.setHint("8 位配对码 / 8-digit pairing code");
        pairingCodeInput.setSingleLine(true);
        pairingCodeInput.setInputType(InputType.TYPE_CLASS_NUMBER
                | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        body.addView(label("一次性配对 / One-time pairing"));
        body.addView(pairingCodeInput, fullWidth());

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        actions.setPadding(0, dp(16), 0, dp(12));

        startButton = new Button(this);
        startButton.setText("配对并启动 / Pair & Start");
        startButton.setOnClickListener(v -> startAgent());
        actions.addView(startButton, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        Button stop = new Button(this);
        stop.setText("停止 / Stop");
        stop.setOnClickListener(v -> stopAgent());
        actions.addView(stop, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        body.addView(actions);

        Button notificationAccess = new Button(this);
        notificationAccess.setText("通知兜底权限 / Notification fallback");
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

    private void applyIntentPrefill(Intent intent) {
        if (intent == null) return;
        String endpoint = intent.getStringExtra(AgentProtocol.EXTRA_ENDPOINT);
        String pairingCode = intent.getStringExtra(AgentProtocol.EXTRA_PAIRING_CODE);
        if (endpoint != null && !endpoint.trim().isEmpty()) {
            endpointInput.setText(endpoint.trim());
        }
        if (pairingCode != null && pairingCode.trim().matches("\\d{8}")) {
            pairingCodeInput.setText(pairingCode.trim());
        }
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
        String pairingCode = pairingCodeInput.getText().toString().trim();
        String existingToken = prefs.getString(AgentProtocol.KEY_TOKEN, "").trim();
        if (!pairingCode.isEmpty() && !pairingCode.matches("\\d{8}")) {
            pairingCodeInput.setError("请输入 8 位数字 / Enter 8 digits");
            return;
        }
        if (pairingCode.isEmpty() && existingToken.isEmpty()) {
            pairingCodeInput.setError("请先输入配对码 / Pairing code required");
            return;
        }
        SharedPreferences.Editor editor = prefs.edit()
                .putString(AgentProtocol.KEY_ENDPOINT, endpoint);
        if (!pairingCode.isEmpty()) {
            editor.putString(AgentProtocol.KEY_PAIRING_CODE, pairingCode)
                    .remove(AgentProtocol.KEY_TOKEN);
        }
        editor.apply();

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
