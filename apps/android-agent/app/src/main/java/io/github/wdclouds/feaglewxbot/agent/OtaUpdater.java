package io.github.wdclouds.feaglewxbot.agent;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;

public final class OtaUpdater {
    private static final String TAG = "FEAGLE-OTA";
    private static final String TARGET_APK_PATH = "/data/local/tmp/feagle-agent-update.apk";

    public interface Callback {
        void onResult(boolean success, String message);
    }

    public static void checkAndApplyUpdate(Context context, String wsEndpoint, JSONObject otaMeta, Callback callback) {
        new Thread(() -> {
            try {
                String currentVersion = "0.0.0";
                try {
                    currentVersion = context.getPackageManager()
                            .getPackageInfo(context.getPackageName(), 0).versionName;
                } catch (Exception ignored) {
                }

                String latestVer = "";
                String downloadUrlStr = "";

                if (otaMeta != null && otaMeta.has("latestVersion") && otaMeta.has("downloadUrl")) {
                    latestVer = otaMeta.optString("latestVersion", "");
                    downloadUrlStr = otaMeta.optString("downloadUrl", "");
                    if (currentVersion.equals(latestVer)) {
                        Log.i(TAG, "Already up-to-date via hello_ack: " + currentVersion);
                        if (callback != null) callback.onResult(true, "Already up-to-date (" + currentVersion + ")");
                        return;
                    }
                    Log.i(TAG, "OTA update available via hello_ack: " + currentVersion + " -> " + latestVer);
                } else {
                    URI uri = URI.create(wsEndpoint);
                    String httpScheme = "wss".equalsIgnoreCase(uri.getScheme()) ? "https" : "http";
                    String host = uri.getHost();
                    int port = uri.getPort();
                    String baseHttp = httpScheme + "://" + host + (port > 0 ? ":" + port : "");

                    // 1. 检查更新
                    URL checkUrl = new URL(baseHttp + "/api/device/check-update?version=" + currentVersion);
                    HttpURLConnection conn = (HttpURLConnection) checkUrl.openConnection();
                    conn.setConnectTimeout(8000);
                    conn.setReadTimeout(8000);
                    conn.setRequestMethod("GET");
                    if (conn.getResponseCode() != 200) {
                        if (callback != null) callback.onResult(false, "Check update HTTP " + conn.getResponseCode());
                        return;
                    }

                    InputStream is = conn.getInputStream();
                    byte[] buf = new byte[4096];
                    int n;
                    StringBuilder sb = new StringBuilder();
                    while ((n = is.read(buf)) > 0) {
                        sb.append(new String(buf, 0, n));
                    }
                    is.close();

                    JSONObject res = new JSONObject(sb.toString());
                    boolean hasUpdate = res.optBoolean("hasUpdate", false);
                    latestVer = res.optString("latestVersion", "");
                    String downloadRel = res.optString("downloadUrl", "/api/device/download-agent");

                    if (!hasUpdate) {
                        Log.i(TAG, "Already up-to-date: " + currentVersion);
                        if (callback != null) callback.onResult(true, "Already up-to-date (" + currentVersion + ")");
                        return;
                    }

                    downloadUrlStr = downloadRel.startsWith("http") ? downloadRel : (baseHttp + downloadRel);
                }

                Log.i(TAG, "New version found: " + latestVer + ", downloading from " + downloadUrlStr);

                // 2. 下载 APK 到 /data/local/tmp
                URL downloadUrl = new URL(downloadUrlStr);
                HttpURLConnection dlConn = (HttpURLConnection) downloadUrl.openConnection();
                dlConn.setConnectTimeout(15000);
                dlConn.setReadTimeout(30000);
                if (dlConn.getResponseCode() != 200) {
                    if (callback != null) callback.onResult(false, "Download failed HTTP " + dlConn.getResponseCode());
                    return;
                }

                File tempApk = new File(TARGET_APK_PATH);
                if (tempApk.exists()) {
                    tempApk.delete();
                }

                InputStream dlIs = dlConn.getInputStream();
                FileOutputStream fos = new FileOutputStream(tempApk);
                byte[] dlBuf = new byte[8192];
                int read;
                while ((read = dlIs.read(dlBuf)) > 0) {
                    fos.write(dlBuf, 0, read);
                }
                fos.flush();
                fos.close();
                dlIs.close();

                Log.i(TAG, "APK downloaded to " + tempApk.getAbsolutePath() + " (" + tempApk.length() + " bytes)");

                // 3. 执行 Root 静默安装
                boolean installedSilently = tryRootInstall(tempApk.getAbsolutePath());
                if (installedSilently) {
                    Log.i(TAG, "Root silent install initiated successfully");
                    if (callback != null) callback.onResult(true, "Silent install started: " + latestVer);
                } else {
                    Log.w(TAG, "Root install failed, falling back to standard intent");
                    // 降级为系统普通安装界面
                    fallbackInstall(context, tempApk);
                    if (callback != null) callback.onResult(false, "Root install failed, fallback prompt shown");
                }

            } catch (Exception e) {
                Log.e(TAG, "OTA update error", e);
                if (callback != null) callback.onResult(false, "Error: " + e.getMessage());
            }
        }).start();
    }

    private static boolean tryRootInstall(String apkPath) {
        try {
            Process suProcess = Runtime.getRuntime().exec("su");
            String command = "pm install -r " + apkPath + " && am start -n io.github.wdclouds.feaglewxbot.agent/.MainActivity\n";
            suProcess.getOutputStream().write(command.getBytes("UTF-8"));
            suProcess.getOutputStream().flush();
            suProcess.getOutputStream().close();
            int exitCode = suProcess.waitFor();
            return exitCode == 0;
        } catch (Exception e) {
            Log.w(TAG, "su command execution failed", e);
            return false;
        }
    }

    private static void fallbackInstall(Context context, File apkFile) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            Uri uri = Uri.fromFile(apkFile);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            context.startActivity(intent);
        } catch (Exception e) {
            Log.e(TAG, "Fallback install failed", e);
        }
    }
}
