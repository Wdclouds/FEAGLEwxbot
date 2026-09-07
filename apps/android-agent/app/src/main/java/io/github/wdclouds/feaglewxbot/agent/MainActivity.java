package io.github.wdclouds.feaglewxbot.agent;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.util.UUID;

public final class MainActivity extends Activity {
    private static final String TAG = "FEAGLE-Main";
    private static final int REQUEST_QR_SCAN = 300;

    // Design Palette (Modern Slate & Royal Indigo)
    private static final int COLOR_BG = 0xFF0F172A;          // Slate 900
    private static final int COLOR_CARD = 0xFF1E293B;        // Slate 800
    private static final int COLOR_CARD_BORDER = 0xFF334155; // Slate 700
    private static final int COLOR_TEXT_PRIMARY = 0xFFF8FAFC;// Slate 50
    private static final int COLOR_TEXT_SECONDARY = 0xFF94A3B8;// Slate 400
    private static final int COLOR_TEXT_MUTED = 0xFF64748B;  // Slate 500

    private static final int COLOR_PRIMARY = 0xFF2563EB;     // Blue 600
    private static final int COLOR_PRIMARY_PRESSED = 0xFF1D4ED8; // Blue 700
    private static final int COLOR_SUCCESS = 0xFF10B981;     // Emerald 500
    private static final int COLOR_SUCCESS_BG = 0x1A10B981;  // Emerald 10%
    private static final int COLOR_SUCCESS_BORDER = 0x4D10B981; // Emerald 30%

    private static final int COLOR_WARNING = 0xFFF59E0B;     // Amber 500
    private static final int COLOR_WARNING_BG = 0x1AF59E0B;
    private static final int COLOR_WARNING_BORDER = 0x4DF59E0B;

    private static final int COLOR_DANGER = 0xFFEF4444;      // Red 500
    private static final int COLOR_DANGER_BG = 0x1AEF4444;
    private static final int COLOR_DANGER_BORDER = 0x4DEF4444;

    private static final int COLOR_INFO = 0xFF38BDF8;        // Sky 400
    private static final int COLOR_INFO_BG = 0x1A38BDF8;
    private static final int COLOR_INFO_BORDER = 0x4D38BDF8;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;

    // Dynamic UI Elements
    private TextView badgeCloud;
    private TextView badgeHook;
    private TextView badgePairing;
    private TextView badgeNotify;
    private TextView deviceIdView;
    private Button startButton;

    // Manual setup views
    private LinearLayout manualContainer;
    private TextView manualToggleText;
    private EditText endpointInput;
    private EditText pairingCodeInput;

    private final Runnable refreshStatus = new Runnable() {
        @Override
        public void run() {
            if (isFinishing() || isDestroyed()) return;

            String status = prefs.getString(AgentProtocol.KEY_STATUS, "未启动 / stopped");
            String hook = prefs.getString(AgentProtocol.KEY_HOOK_STATUS, "未连接 / disconnected");
            boolean isPaired = !prefs.getString(AgentProtocol.KEY_TOKEN, "").isEmpty();
            boolean notifyEnabled = notificationAccessEnabled();

            // 1. Update Cloud Badge
            if (status.contains("已连接") || status.toLowerCase().contains("online") || status.toLowerCase().contains("connected")) {
                updateBadge(badgeCloud, "● 云端已连接", COLOR_SUCCESS, COLOR_SUCCESS_BG, COLOR_SUCCESS_BORDER);
            } else if (status.contains("连接中") || status.toLowerCase().contains("connecting") || status.toLowerCase().contains("wait")) {
                updateBadge(badgeCloud, "● 云端握手中", COLOR_WARNING, COLOR_WARNING_BG, COLOR_WARNING_BORDER);
            } else {
                updateBadge(badgeCloud, "○ 云端未连接", COLOR_TEXT_MUTED, 0x1A64748B, COLOR_CARD_BORDER);
            }

            // 2. Update Hook Badge
            if (hook.contains("已连接") || hook.toLowerCase().contains("online") || hook.toLowerCase().contains("connected")) {
                updateBadge(badgeHook, "● 微信已注入", COLOR_SUCCESS, COLOR_SUCCESS_BG, COLOR_SUCCESS_BORDER);
            } else {
                updateBadge(badgeHook, "○ 等待微信 Hook", COLOR_WARNING, COLOR_WARNING_BG, COLOR_WARNING_BORDER);
            }

            // 3. Update Pairing Badge
            if (isPaired) {
                updateBadge(badgePairing, "● 凭证已鉴权", COLOR_SUCCESS, COLOR_SUCCESS_BG, COLOR_SUCCESS_BORDER);
            } else {
                updateBadge(badgePairing, "○ 尚未配对", COLOR_DANGER, COLOR_DANGER_BG, COLOR_DANGER_BORDER);
            }

            // 4. Update Notification Badge
            if (notifyEnabled) {
                updateBadge(badgeNotify, "● 通知监听就绪", COLOR_INFO, COLOR_INFO_BG, COLOR_INFO_BORDER);
            } else {
                updateBadge(badgeNotify, "○ 通知监听未开", COLOR_TEXT_MUTED, 0x1A64748B, COLOR_CARD_BORDER);
            }

            // 5. Update Start Button Text
            if (startButton != null) {
                startButton.setText(isPaired ? "保存配置并重连 (Reconnect)" : "配对并启动服务 (Pair & Start)");
            }

            // 6. Clear pairing input if already paired
            if (isPaired && pairingCodeInput != null && pairingCodeInput.length() > 0) {
                pairingCodeInput.setText("");
            }

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

    private View buildContent() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(COLOR_BG);
        scroll.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16), dp(20), dp(16), dp(28));

        // 1. Header Card (App Icon, Title, Version Badge, Slogan)
        root.addView(buildHeaderView());

        // 2. Live System Status Dashboard Card
        root.addView(buildStatusDashboardCard());

        // 3. Hero Quick Action Card: QR Pairing (Recommended)
        root.addView(buildHeroScanCard());

        // 4. v0.7.0 Feature & Onboarding Guide Card
        root.addView(buildOnboardingGuideCard());

        // 5. Operational Control Actions Card
        root.addView(buildControlActionsCard());

        // 6. Collapsible Advanced Manual Configuration Card
        root.addView(buildManualConfigCard());

        // 7. Footer Info
        root.addView(buildFooterView());

        scroll.addView(root);
        return scroll;
    }

    private View buildHeaderView() {
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.VERTICAL);
        header.setPadding(dp(4), dp(4), dp(4), dp(16));

        LinearLayout topRow = new LinearLayout(this);
        topRow.setOrientation(LinearLayout.HORIZONTAL);
        topRow.setGravity(Gravity.CENTER_VERTICAL);

        android.widget.ImageView iconView = new android.widget.ImageView(this);
        iconView.setImageResource(R.drawable.ic_feagle);
        LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(dp(32), dp(32));
        iconParams.setMargins(0, 0, dp(10), 0);
        topRow.addView(iconView, iconParams);

        TextView title = new TextView(this);
        title.setText("FEAGLE Agent");
        title.setTextSize(22);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextColor(COLOR_TEXT_PRIMARY);
        topRow.addView(title);

        TextView versionBadge = new TextView(this);
        versionBadge.setText("v0.7.0");
        versionBadge.setTextSize(11);
        versionBadge.setTypeface(Typeface.DEFAULT_BOLD);
        versionBadge.setTextColor(COLOR_INFO);
        versionBadge.setBackground(createPillDrawable(COLOR_INFO_BG, COLOR_INFO_BORDER, dp(10)));
        versionBadge.setPadding(dp(8), dp(2), dp(8), dp(2));
        LinearLayout.LayoutParams vParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        vParams.setMargins(dp(10), 0, 0, 0);
        topRow.addView(versionBadge, vParams);

        header.addView(topRow);

        TextView subtitle = new TextView(this);
        subtitle.setText("微信 8.0.70 Native Hook 传输桥接与多模态智能体中枢");
        subtitle.setTextSize(13);
        subtitle.setTextColor(COLOR_TEXT_SECONDARY);
        subtitle.setPadding(0, dp(6), 0, 0);
        header.addView(subtitle);

        return header;
    }

    private View buildStatusDashboardCard() {
        LinearLayout card = createCardContainer();

        TextView title = createSectionTitle("● 实时运行大盘 / SYSTEM STATUS");
        card.addView(title);

        // 2x2 Grid for status badges
        LinearLayout row1 = new LinearLayout(this);
        row1.setOrientation(LinearLayout.HORIZONTAL);
        row1.setPadding(0, dp(8), 0, dp(4));

        badgeCloud = createBadgeView("○ 云端连接检测中");
        badgeHook = createBadgeView("○ 微信通道检测中");
        row1.addView(badgeCloud, halfWidthParams(4));
        row1.addView(badgeHook, halfWidthParams(0));
        card.addView(row1);

        LinearLayout row2 = new LinearLayout(this);
        row2.setOrientation(LinearLayout.HORIZONTAL);
        row2.setPadding(0, dp(4), 0, dp(12));

        badgePairing = createBadgeView("○ 配对状态检测中");
        badgeNotify = createBadgeView("○ 通知权限检测中");
        row2.addView(badgePairing, halfWidthParams(4));
        row2.addView(badgeNotify, halfWidthParams(0));
        card.addView(row2);

        // Capabilities info pill
        TextView capabilitiesView = new TextView(this);
        capabilitiesView.setText("🛡️ 核心能力：私聊文本/群聊@回复/引用图片多模态/Root在线升级");
        capabilitiesView.setTextSize(12);
        capabilitiesView.setTextColor(COLOR_TEXT_SECONDARY);
        capabilitiesView.setBackground(createPillDrawable(0x220F172A, COLOR_CARD_BORDER, dp(8)));
        capabilitiesView.setPadding(dp(10), dp(7), dp(10), dp(7));
        card.addView(capabilitiesView);

        // Device ID with click-to-copy
        String deviceId = prefs.getString(AgentProtocol.KEY_DEVICE_ID, "");
        deviceIdView = new TextView(this);
        deviceIdView.setText("设备标识 (Device ID): " + maskDeviceId(deviceId) + "  [点击复制]");
        deviceIdView.setTextSize(11);
        deviceIdView.setTextColor(COLOR_TEXT_MUTED);
        deviceIdView.setPadding(0, dp(10), 0, 0);
        deviceIdView.setOnClickListener(v -> {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) {
                cm.setPrimaryClip(ClipData.newPlainText("Device ID", deviceId));
                Toast.makeText(MainActivity.this, "已复制完整设备 ID 到剪贴板", Toast.LENGTH_SHORT).show();
            }
        });
        card.addView(deviceIdView);

        return card;
    }

    private View buildHeroScanCard() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(18), dp(18), dp(18), dp(18));

        // Electric Blue Gradient
        GradientDrawable gradient = new GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                new int[]{0xFF1D4ED8, 0xFF2563EB, 0xFF3B82F6}
        );
        gradient.setCornerRadius(dp(14));
        card.setBackground(gradient);

        LinearLayout.LayoutParams params = fullWidthParams();
        params.setMargins(0, 0, 0, dp(14));
        card.setLayoutParams(params);

        LinearLayout titleRow = new LinearLayout(this);
        titleRow.setOrientation(LinearLayout.HORIZONTAL);
        titleRow.setGravity(Gravity.CENTER_VERTICAL);

        TextView icon = new TextView(this);
        icon.setText("📷");
        icon.setTextSize(24);
        titleRow.addView(icon);

        LinearLayout textCol = new LinearLayout(this);
        textCol.setOrientation(LinearLayout.VERTICAL);
        textCol.setPadding(dp(10), 0, 0, 0);

        TextView title = new TextView(this);
        title.setText("扫码一键连接 (强烈推荐)");
        title.setTextSize(17);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextColor(Color.WHITE);
        textCol.addView(title);

        TextView desc = new TextView(this);
        desc.setText("扫描电脑桌面端或 Web 控制台配对码，一秒完成鉴权");
        desc.setTextSize(12);
        desc.setTextColor(0xCCFFFFFF);
        textCol.addView(desc);

        titleRow.addView(textCol);
        card.addView(titleRow);

        card.setOnClickListener(v -> {
            Intent scanIntent = new Intent(MainActivity.this, QrScanActivity.class);
            startActivityForResult(scanIntent, REQUEST_QR_SCAN);
        });

        return card;
    }

    private View buildOnboardingGuideCard() {
        LinearLayout card = createCardContainer();

        TextView title = createSectionTitle("💡 新版本极简接入指引 / QUICK GUIDE");
        card.addView(title);

        card.addView(createGuideStep(
                "1",
                "激活 LSPosed 微信作用域",
                "在 LSPosed/Vector 模块管理器中启用 FEAGLE Agent，将作用域勾选【微信】(com.tencent.mm)，并重启微信生效。"
        ));

        card.addView(createGuideStep(
                "2",
                "扫码一键鉴权与配对",
                "在电脑端控制台（http://<IP>:6190）或桌面客户端点击「连接设备」，使用上方按钮扫码，自动完成接入。"
        ));

        card.addView(createGuideStep(
                "3",
                "全天候后台智能守护",
                "支持好友私聊、微信群聊 @AI 响应、引用图片识别及 wxgf 格式转码；系统服务常驻，支持 Root 无感在线迭代。"
        ));

        return card;
    }

    private View createGuideStep(String stepNum, String stepTitle, String stepDetail) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, dp(8), 0, dp(8));

        TextView stepBadge = new TextView(this);
        stepBadge.setText(stepNum);
        stepBadge.setTextSize(12);
        stepBadge.setTypeface(Typeface.DEFAULT_BOLD);
        stepBadge.setTextColor(COLOR_INFO);
        stepBadge.setGravity(Gravity.CENTER);
        stepBadge.setBackground(createPillDrawable(COLOR_INFO_BG, COLOR_INFO_BORDER, dp(12)));
        LinearLayout.LayoutParams bParams = new LinearLayout.LayoutParams(dp(24), dp(24));
        bParams.setMargins(0, dp(2), dp(10), 0);
        row.addView(stepBadge, bParams);

        LinearLayout contentCol = new LinearLayout(this);
        contentCol.setOrientation(LinearLayout.VERTICAL);

        TextView tView = new TextView(this);
        tView.setText(stepTitle);
        tView.setTextSize(14);
        tView.setTypeface(Typeface.DEFAULT_BOLD);
        tView.setTextColor(COLOR_TEXT_PRIMARY);
        contentCol.addView(tView);

        TextView dView = new TextView(this);
        dView.setText(stepDetail);
        dView.setTextSize(12);
        dView.setTextColor(COLOR_TEXT_SECONDARY);
        dView.setPadding(0, dp(3), 0, 0);
        contentCol.addView(dView);

        row.addView(contentCol, fullWidthParams());
        return row;
    }

    private View buildControlActionsCard() {
        LinearLayout card = createCardContainer();

        TextView title = createSectionTitle("⚡ 运行控制与诊断 / ACTIONS");
        card.addView(title);

        // Row 1: Start & Stop buttons
        LinearLayout row1 = new LinearLayout(this);
        row1.setOrientation(LinearLayout.HORIZONTAL);
        row1.setPadding(0, dp(8), 0, dp(4));

        startButton = createButton("启动服务 (Start)", COLOR_PRIMARY, COLOR_PRIMARY_PRESSED, Color.WHITE);
        startButton.setOnClickListener(v -> startAgent());
        row1.addView(startButton, halfWidthParams(4));

        Button stopButton = createButton("停止服务 (Stop)", 0xFF334155, 0xFF1E293B, COLOR_DANGER);
        stopButton.setOnClickListener(v -> stopAgent());
        row1.addView(stopButton, halfWidthParams(0));
        card.addView(row1);

        // Row 2: OTA check & Notification settings
        LinearLayout row2 = new LinearLayout(this);
        row2.setOrientation(LinearLayout.HORIZONTAL);
        row2.setPadding(0, dp(4), 0, dp(4));

        Button otaButton = createButton("🔄 检查 OTA 更新", 0xFF1E293B, 0xFF0F172A, COLOR_INFO);
        otaButton.setOnClickListener(v -> triggerManualOtaCheck());
        row2.addView(otaButton, halfWidthParams(4));

        Button notifyButton = createButton("🔔 通知监听权限", 0xFF1E293B, 0xFF0F172A, COLOR_TEXT_SECONDARY);
        notifyButton.setOnClickListener(v -> {
            Intent settings = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
            startActivity(settings);
        });
        row2.addView(notifyButton, halfWidthParams(0));
        card.addView(row2);

        return card;
    }

    private View buildManualConfigCard() {
        LinearLayout card = createCardContainer();

        LinearLayout headerRow = new LinearLayout(this);
        headerRow.setOrientation(LinearLayout.HORIZONTAL);
        headerRow.setGravity(Gravity.CENTER_VERTICAL);
        headerRow.setOnClickListener(v -> toggleManualConfig());

        TextView title = createSectionTitle("⚙️ 高级手动设置 / MANUAL CONFIG");
        title.setPadding(0, 0, 0, 0);
        headerRow.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        manualToggleText = new TextView(this);
        manualToggleText.setText("▼ 展开");
        manualToggleText.setTextSize(12);
        manualToggleText.setTextColor(COLOR_INFO);
        headerRow.addView(manualToggleText);
        card.addView(headerRow);

        manualContainer = new LinearLayout(this);
        manualContainer.setOrientation(LinearLayout.VERTICAL);
        manualContainer.setPadding(0, dp(10), 0, 0);
        manualContainer.setVisibility(View.GONE); // Default collapsed for clean onboarding

        TextView endLabel = createInputLabel("Bridge WebSocket 终端 (wss:// 或 ws://)");
        manualContainer.addView(endLabel);

        endpointInput = createStyledInput("例如：wss://your-domain.com:6191/android", false);
        endpointInput.setText(prefs.getString(AgentProtocol.KEY_ENDPOINT, ""));
        manualContainer.addView(endpointInput);

        TextView codeLabel = createInputLabel("一次性配对码 (8 位数字)");
        manualContainer.addView(codeLabel);

        pairingCodeInput = createStyledInput("例如：8 位数字配对码", true);
        manualContainer.addView(pairingCodeInput);

        Button saveButton = createButton("保存手动配置并启动", 0xFF2563EB, 0xFF1D4ED8, Color.WHITE);
        saveButton.setOnClickListener(v -> startAgent());
        LinearLayout.LayoutParams sParams = fullWidthParams();
        sParams.setMargins(0, dp(10), 0, 0);
        manualContainer.addView(saveButton, sParams);

        card.addView(manualContainer);
        return card;
    }

    private void toggleManualConfig() {
        if (manualContainer == null || manualToggleText == null) return;
        boolean isVisible = manualContainer.getVisibility() == View.VISIBLE;
        manualContainer.setVisibility(isVisible ? View.GONE : View.VISIBLE);
        manualToggleText.setText(isVisible ? "▼ 展开" : "▲ 收起");
    }

    private View buildFooterView() {
        LinearLayout footer = new LinearLayout(this);
        footer.setOrientation(LinearLayout.VERTICAL);
        footer.setGravity(Gravity.CENTER_HORIZONTAL);
        footer.setPadding(0, dp(14), 0, dp(8));

        TextView brand = new TextView(this);
        brand.setText("FEAGLE WxBot Ecosystem · Enterprise Agent v0.7.0");
        brand.setTextSize(11);
        brand.setTextColor(COLOR_TEXT_MUTED);
        brand.setGravity(Gravity.CENTER);
        footer.addView(brand);

        TextView copyright = new TextView(this);
        copyright.setText("Root Silent OTA · Magisk Integration · Decoupled Core");
        copyright.setTextSize(10);
        copyright.setTextColor(COLOR_CARD_BORDER);
        copyright.setGravity(Gravity.CENTER);
        copyright.setPadding(0, dp(2), 0, 0);
        footer.addView(copyright);

        return footer;
    }

    // Helper UI Component Builders
    private LinearLayout createCardContainer() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16), dp(16), dp(16), dp(16));
        card.setBackground(createPillDrawable(COLOR_CARD, COLOR_CARD_BORDER, dp(14)));

        LinearLayout.LayoutParams params = fullWidthParams();
        params.setMargins(0, 0, 0, dp(14));
        card.setLayoutParams(params);
        return card;
    }

    private TextView createSectionTitle(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(12);
        view.setTypeface(Typeface.DEFAULT_BOLD);
        view.setTextColor(COLOR_TEXT_SECONDARY);
        view.setPadding(0, 0, 0, dp(8));
        return view;
    }

    private TextView createBadgeView(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(12);
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setPadding(dp(10), dp(8), dp(10), dp(8));
        view.setBackground(createPillDrawable(0x1A64748B, COLOR_CARD_BORDER, dp(8)));
        view.setTextColor(COLOR_TEXT_MUTED);
        return view;
    }

    private void updateBadge(TextView view, String text, int textColor, int bgColor, int borderColor) {
        if (view == null) return;
        view.setText(text);
        view.setTextColor(textColor);
        view.setBackground(createPillDrawable(bgColor, borderColor, dp(8)));
    }

    private TextView createInputLabel(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(12);
        view.setTextColor(COLOR_TEXT_SECONDARY);
        view.setPadding(0, dp(8), 0, dp(4));
        return view;
    }

    private EditText createStyledInput(String hint, boolean isPassword) {
        EditText input = new EditText(this);
        input.setHint(hint);
        input.setHintTextColor(COLOR_TEXT_MUTED);
        input.setTextColor(COLOR_TEXT_PRIMARY);
        input.setTextSize(13);
        input.setSingleLine(true);
        input.setBackground(createPillDrawable(COLOR_BG, COLOR_CARD_BORDER, dp(8)));
        input.setPadding(dp(12), dp(10), dp(12), dp(10));
        if (isPassword) {
            input.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        } else {
            input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        }
        return input;
    }

    private Button createButton(String text, int normalColor, int pressedColor, int textColor) {
        Button btn = new Button(this);
        btn.setText(text);
        btn.setTextSize(13);
        btn.setTypeface(Typeface.DEFAULT_BOLD);
        btn.setTextColor(textColor);
        btn.setPadding(dp(12), dp(10), dp(12), dp(10));

        StateListDrawable states = new StateListDrawable();
        states.addState(new int[]{android.R.attr.state_pressed}, createPillDrawable(pressedColor, pressedColor, dp(8)));
        states.addState(new int[]{}, createPillDrawable(normalColor, COLOR_CARD_BORDER, dp(8)));
        btn.setBackground(states);

        return btn;
    }

    private GradientDrawable createPillDrawable(int bgColor, int borderColor, float radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(bgColor);
        drawable.setCornerRadius(radiusDp);
        if (borderColor != 0) {
            drawable.setStroke(dp(1), borderColor);
        }
        return drawable;
    }

    private LinearLayout.LayoutParams fullWidthParams() {
        return new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private LinearLayout.LayoutParams halfWidthParams(int rightMarginDp) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        if (rightMarginDp > 0) {
            params.setMargins(0, 0, dp(rightMarginDp), 0);
        }
        return params;
    }

    private String maskDeviceId(String deviceId) {
        if (deviceId == null || deviceId.isEmpty()) return "----";
        if (deviceId.length() <= 8) return deviceId;
        return deviceId.substring(0, 4) + "..." + deviceId.substring(deviceId.length() - 4);
    }

    private void triggerManualOtaCheck() {
        String endpoint = prefs.getString(AgentProtocol.KEY_ENDPOINT, "").trim();
        if (endpoint.isEmpty()) {
            Toast.makeText(this, "请先扫码连接或配置 Bridge 终端地址", Toast.LENGTH_SHORT).show();
            return;
        }
        Toast.makeText(this, "正在检查 Root OTA 最新版本...", Toast.LENGTH_SHORT).show();
        OtaUpdater.checkAndApplyUpdate(this, endpoint, null, (success, message) -> {
            runOnUiThread(() -> {
                Toast.makeText(MainActivity.this, (success ? "✅ " : "⚠️ ") + message, Toast.LENGTH_LONG).show();
            });
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_QR_SCAN && resultCode == RESULT_OK && data != null) {
            String qrResult = data.getStringExtra(QrScanActivity.EXTRA_QR_RESULT);
            if (qrResult != null && !qrResult.trim().isEmpty()) {
                handleQrPayload(qrResult.trim());
            }
        }
    }

    private void handleQrPayload(String raw) {
        try {
            JSONObject json = new JSONObject(raw);
            String endpoint = json.optString("endpoint", "").trim();
            String token = json.optString("token", "").trim();
            String pairingCode = json.optString("pairingCode", "").trim();
            if (!endpoint.isEmpty()) {
                if (endpointInput != null) endpointInput.setText(endpoint);
                SharedPreferences.Editor editor = prefs.edit().putString(AgentProtocol.KEY_ENDPOINT, endpoint);
                if (!token.isEmpty()) {
                    editor.putString(AgentProtocol.KEY_TOKEN, token)
                            .remove(AgentProtocol.KEY_PAIRING_CODE);
                } else if (!pairingCode.isEmpty()) {
                    if (pairingCodeInput != null) pairingCodeInput.setText(pairingCode);
                    editor.putString(AgentProtocol.KEY_PAIRING_CODE, pairingCode)
                            .remove(AgentProtocol.KEY_TOKEN);
                }
                editor.apply();
                Toast.makeText(this, "扫码成功，正在一键握手连接...", Toast.LENGTH_SHORT).show();
                startAgent();
                return;
            }
        } catch (Exception ignored) {
        }
        if (raw.startsWith("ws://") || raw.startsWith("wss://")) {
            if (endpointInput != null) endpointInput.setText(raw);
            prefs.edit().putString(AgentProtocol.KEY_ENDPOINT, raw).apply();
            Toast.makeText(this, "已自动载入服务器地址", Toast.LENGTH_SHORT).show();
        } else if (raw.matches("\\d{8}")) {
            if (pairingCodeInput != null) pairingCodeInput.setText(raw);
            Toast.makeText(this, "已自动载入配对码", Toast.LENGTH_SHORT).show();
        } else {
            Toast.makeText(this, "未识别的二维码格式，请确认扫描的是 FEAGLE 控制台配对码", Toast.LENGTH_LONG).show();
        }
    }

    private void applyIntentPrefill(Intent intent) {
        if (intent == null) return;
        String endpoint = intent.getStringExtra(AgentProtocol.EXTRA_ENDPOINT);
        String pairingCode = intent.getStringExtra(AgentProtocol.EXTRA_PAIRING_CODE);
        if (endpoint != null && !endpoint.trim().isEmpty()) {
            if (endpointInput != null) endpointInput.setText(endpoint.trim());
        }
        if (pairingCode != null && pairingCode.trim().matches("\\d{8}")) {
            if (pairingCodeInput != null) pairingCodeInput.setText(pairingCode.trim());
        }
    }

    private void startAgent() {
        String endpoint = endpointInput != null ? endpointInput.getText().toString().trim() : "";
        if (endpoint.isEmpty()) {
            endpoint = prefs.getString(AgentProtocol.KEY_ENDPOINT, "").trim();
        }
        String pairingCode = pairingCodeInput != null ? pairingCodeInput.getText().toString().trim() : "";
        String existingToken = prefs.getString(AgentProtocol.KEY_TOKEN, "").trim();

        if (endpoint.isEmpty()) {
            Toast.makeText(this, "请先扫码连接或输入 Bridge 地址", Toast.LENGTH_SHORT).show();
            if (manualContainer != null && manualContainer.getVisibility() != View.VISIBLE) {
                toggleManualConfig();
            }
            return;
        }

        if (!pairingCode.isEmpty() && !pairingCode.matches("\\d{8}")) {
            if (pairingCodeInput != null) pairingCodeInput.setError("请输入 8 位数字配对码");
            return;
        }
        if (pairingCode.isEmpty() && existingToken.isEmpty()) {
            Toast.makeText(this, "首次连接请扫描控制台配对码或输入 8 位配对码", Toast.LENGTH_SHORT).show();
            if (manualContainer != null && manualContainer.getVisibility() != View.VISIBLE) {
                toggleManualConfig();
            }
            return;
        }

        SharedPreferences.Editor editor = prefs.edit().putString(AgentProtocol.KEY_ENDPOINT, endpoint);
        if (!pairingCode.isEmpty()) {
            editor.putString(AgentProtocol.KEY_PAIRING_CODE, pairingCode)
                    .remove(AgentProtocol.KEY_TOKEN);
        }
        editor.apply();

        Intent intent = new Intent(this, BridgeForegroundService.class)
                .setAction(AgentProtocol.ACTION_START);
        startForegroundService(intent);
        Toast.makeText(this, "正在启动后台传输服务...", Toast.LENGTH_SHORT).show();
    }

    private void stopAgent() {
        Intent intent = new Intent(this, BridgeForegroundService.class)
                .setAction(AgentProtocol.ACTION_STOP);
        startService(intent);
        Toast.makeText(this, "已发送停止服务指令", Toast.LENGTH_SHORT).show();
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
