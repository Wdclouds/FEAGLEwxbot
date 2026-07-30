package io.github.wdclouds.feaglewxbot.agent;

final class AgentProtocol {
    static final int MSG_REGISTER_HOOK = 1;
    static final int MSG_PRIVATE_TEXT = 2;
    static final int MSG_SEND_TEXT = 3;
    static final int MSG_COMMAND_RESULT = 4;
    static final int MSG_REGISTER_NOTIFICATION = 5;

    static final String PREFS = "agent";
    static final String KEY_ENDPOINT = "endpoint";
    static final String KEY_TOKEN = "token";
    static final String KEY_DEVICE_ID = "device_id";
    static final String KEY_STATUS = "status";
    static final String KEY_HOOK_STATUS = "hook_status";
    static final String KEY_PENDING_EVENTS = "pending_events";
    static final String KEY_RECENT_EVENTS = "recent_events";

    static final String ACTION_START = "io.github.wdclouds.feaglewxbot.agent.START";
    static final String ACTION_STOP = "io.github.wdclouds.feaglewxbot.agent.STOP";

    static final String AGENT_PACKAGE = "io.github.wdclouds.feaglewxbot.agent";
    static final String SERVICE_CLASS =
            "io.github.wdclouds.feaglewxbot.agent.BridgeForegroundService";
    static final String WECHAT_PACKAGE = "com.tencent.mm";

    private AgentProtocol() {
    }
}
