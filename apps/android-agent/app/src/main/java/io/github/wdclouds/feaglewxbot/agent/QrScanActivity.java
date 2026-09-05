package io.github.wdclouds.feaglewxbot.agent;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.hardware.Camera;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;

import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;

import java.util.EnumMap;
import java.util.Map;

public final class QrScanActivity extends Activity
        implements SurfaceHolder.Callback, Camera.PreviewCallback {

    static final String EXTRA_QR_RESULT = "qr_result";
    private static final String TAG = "FEAGLE-QrScan";
    private static final int REQUEST_CAMERA = 200;

    private Camera camera;
    private SurfaceView surfaceView;
    private TextView hintView;
    private final QRCodeReader reader = new QRCodeReader();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private volatile boolean decoded;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        surfaceView = new SurfaceView(this);
        root.addView(surfaceView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        hintView = new TextView(this);
        hintView.setText("将二维码对准取景框 / Aim at QR code");
        hintView.setTextSize(18);
        hintView.setTextColor(Color.WHITE);
        hintView.setGravity(Gravity.CENTER);
        hintView.setPadding(0, dp(48), 0, 0);
        root.addView(hintView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM));

        setContentView(root);

        if (checkSelfPermission(Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQUEST_CAMERA);
        } else {
            surfaceView.getHolder().addCallback(this);
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code == REQUEST_CAMERA) {
            if (results.length > 0
                    && results[0] == PackageManager.PERMISSION_GRANTED) {
                surfaceView.getHolder().addCallback(this);
            } else {
                setResult(RESULT_CANCELED);
                finish();
            }
        }
    }

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        try {
            camera = Camera.open(Camera.CameraInfo.CAMERA_FACING_BACK);
            Camera.Parameters params = camera.getParameters();
            for (String mode : params.getSupportedFocusModes()) {
                if (Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE.equals(mode)) {
                    params.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
                    break;
                }
            }
            params.setPreviewFormat(ImageFormat.NV21);
            camera.setParameters(params);
            setCameraDisplayOrientation();
            camera.setPreviewDisplay(holder);
            camera.setPreviewCallback(this);
            camera.startPreview();
        } catch (Exception e) {
            Log.e(TAG, "Camera open failed", e);
            setResult(RESULT_CANCELED);
            finish();
        }
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int w, int h) {
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        releaseCamera();
    }

    @Override
    public void onPreviewFrame(byte[] data, Camera cam) {
        if (decoded || data == null) return;
        Camera.Size size = cam.getParameters().getPreviewSize();
        try {
            PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(
                    data, size.width, size.height,
                    0, 0, size.width, size.height, false);
            BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(source));
            Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
            hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
            Result result = reader.decode(bitmap, hints);
            decoded = true;
            handler.post(() -> onQrDecoded(result.getText()));
        } catch (Exception ignored) {
            reader.reset();
        }
    }

    private void onQrDecoded(String text) {
        releaseCamera();
        Intent result = new Intent();
        result.putExtra(EXTRA_QR_RESULT, text);
        setResult(RESULT_OK, result);
        finish();
    }

    private void setCameraDisplayOrientation() {
        Camera.CameraInfo info = new Camera.CameraInfo();
        Camera.getCameraInfo(Camera.CameraInfo.CAMERA_FACING_BACK, info);
        int rotation = getWindowManager().getDefaultDisplay().getRotation();
        int degrees = 0;
        switch (rotation) {
            case Surface.ROTATION_0:   degrees = 0;   break;
            case Surface.ROTATION_90:  degrees = 90;  break;
            case Surface.ROTATION_180: degrees = 180; break;
            case Surface.ROTATION_270: degrees = 270; break;
        }
        int displayRotation = (info.orientation - degrees + 360) % 360;
        camera.setDisplayOrientation(displayRotation);
    }

    private void releaseCamera() {
        if (camera != null) {
            camera.setPreviewCallback(null);
            camera.stopPreview();
            camera.release();
            camera = null;
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        releaseCamera();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
