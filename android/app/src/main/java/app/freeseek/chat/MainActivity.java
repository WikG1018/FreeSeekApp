package app.freeseek.chat;

import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Toast;
import androidx.appcompat.app.AlertDialog;
import androidx.core.splashscreen.SplashScreen;
import java.io.File;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.JSObject;

public class MainActivity extends BridgeActivity {
    private StartupSplash startupSplash;
    private WebViewHealth webViewHealth;
    private AlertDialog recovery;
    private boolean firstForeground = true;
    private boolean rendererLost;
    private long createdAt;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        createdAt = SystemClock.elapsedRealtime();
        SplashScreen splash = SplashScreen.installSplashScreen(this);
        DiagnosticsLog.installCrashHandler(getApplicationContext());
        DiagnosticsLog.record(this, "app", "activity.created",
            new JSObject().put("recreated", savedInstanceState != null));
        registerPlugin(FontScalePlugin.class);
        registerPlugin(AppearancePlugin.class);
        registerPlugin(StartupHandoffPlugin.class);
        registerPlugin(StartupRoutePlugin.class);
        registerPlugin(MicPermissionPlugin.class);
        registerPlugin(DonatePlugin.class);
        registerPlugin(UpdatePlugin.class);
        registerPlugin(BackupPlugin.class);
        registerPlugin(HistoryFilesPlugin.class);
        registerPlugin(HistoryVaultPlugin.class);
        registerPlugin(DiagnosticsPlugin.class);
        registerPlugin(CustomHttpPlugin.class);
        registerPlugin(PublicWebPlugin.class);
        registerPlugin(AgentGoalsPlugin.class);
        registerPlugin(DiagnosticSharePlugin.class);
        registerPlugin(PhotoCapturePlugin.class);
        registerPlugin(PdfPreviewPlugin.class);
        registerPlugin(WorkspaceFilesPlugin.class);
        // 插件先登记，super 创建 Bridge 后再安装观察器；无 WebView 时保留框架降级页。
        super.onCreate(savedInstanceState);
        var bridge = getBridge();
        boolean hasWebView = bridge != null && bridge.getWebView() != null;
        JSObject ready = new JSObject().put("bridgeAvailable", bridge != null)
            .put("webviewAvailable", hasWebView)
            .put("elapsedMs", SystemClock.elapsedRealtime() - createdAt);
        if (hasWebView) {
            bridge.getWebView().setOverScrollMode(View.OVER_SCROLL_NEVER);
            DiagnosticsLog.record(this, "app", "bridge.ready", ready);
            webViewHealth = new WebViewHealth(this);
            new WindowEdges(getWindow(), bridge).install();
            startupSplash = new StartupSplash(splash, bridge.getWebView(), this);
            bridge.addWebViewListener(startupSplash);
        } else {
            DiagnosticsLog.warn(this, "app", "bridge.unavailable", ready);
            getWindow().getDecorView().post(() -> showStartupRecovery(
                new JSObject().put("phase", "startup").put("reason", "bridge-unavailable")));
        }
        if (hasWebView) { getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public void onPageStarted(android.webkit.WebView view, String url, android.graphics.Bitmap favicon) {
                DiagnosticsLog.record(MainActivity.this, "app", "webview.page-started", new JSObject());
                super.onPageStarted(view, url, favicon);
            }
            @Override
            public void onPageFinished(android.webkit.WebView view, String url) {
                DiagnosticsLog.record(MainActivity.this, "app", "webview.page-finished", new JSObject()
                    .put("elapsedMs", SystemClock.elapsedRealtime() - createdAt));
                super.onPageFinished(view, url);
            }
            @Override
            public void onReceivedError(android.webkit.WebView view, android.webkit.WebResourceRequest request,
                                        android.webkit.WebResourceError error) {
                JSObject info = new JSObject(); info.put("code", error.getErrorCode());
                info.put("mainFrame", request.isForMainFrame());
                info.put("localResource", "localhost".equals(request.getUrl().getHost()));
                DiagnosticsLog.warn(MainActivity.this, "ui", "webview.resource-error", info);
                super.onReceivedError(view, request, error);
                if (request.isForMainFrame() && info.optBoolean("localResource")) {
                    showStartupRecovery(info.put("phase", "resource").put("reason", "local-page-failed"));
                }
            }
            @Override
            public void onReceivedHttpError(android.webkit.WebView view, android.webkit.WebResourceRequest request,
                                            android.webkit.WebResourceResponse response) {
                JSObject info = new JSObject(); info.put("status", response.getStatusCode());
                info.put("mainFrame", request.isForMainFrame());
                DiagnosticsLog.warn(MainActivity.this, "ui", "webview.http-error", info);
                super.onReceivedHttpError(view, request, response);
                if (request.isForMainFrame() && "localhost".equals(request.getUrl().getHost())) {
                    showStartupRecovery(info.put("phase", "resource").put("reason", "local-page-http"));
                }
            }
            @Override
            @androidx.annotation.RequiresApi(26)
            public boolean onRenderProcessGone(android.webkit.WebView view, android.webkit.RenderProcessGoneDetail detail) {
                JSObject info = new JSObject(); info.put("crashed", detail.didCrash());
                info.put("priority", detail.rendererPriorityAtExit());
                DiagnosticsLog.warnBeforeRendererExit(MainActivity.this, info);
                rendererLost = true;
                if (webViewHealth != null) webViewHealth.stop();
                if (startupSplash != null) startupSplash.destroy();
                if (view.getParent() instanceof ViewGroup parent) parent.removeView(view);
                view.destroy();
                showStartupRecovery(info.put("phase", "render").put("reason", "renderer-exited"));
                return true;
            }
        }); }
    }

    void markStartupPaintable() {
        if (startupSplash != null) {
            startupSplash.markPaintable();
            DiagnosticsLog.record(this, "app", "webview.paintable", new JSObject()
                .put("elapsedMs", SystemClock.elapsedRealtime() - createdAt));
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        TaskNotifications.appVisible = true;
        LiveTaskProgress.refreshNotifications();
        DiagnosticsLog.record(this, "app", "activity.resumed", new JSObject());
        if (webViewHealth != null && !rendererLost && recovery == null) {
            webViewHealth.foreground(getBridge().getWebView(), firstForeground);
            firstForeground = false;
        }
    }

    @Override
    public void onPause() {
        TaskNotifications.appVisible = false;
        LiveTaskProgress.refreshNotifications();
        DiagnosticsLog.record(this, "app", "activity.paused", new JSObject());
        if (webViewHealth != null) webViewHealth.stop();
        super.onPause();
    }

    private String local(String zh, String en) {
        return "zh".equals(getResources().getConfiguration().getLocales().get(0).getLanguage()) ? zh : en;
    }

    void showStartupRecovery(JSObject report) {
        if (webViewHealth != null) webViewHealth.stop();
        if (isFinishing() || isDestroyed() || recovery != null) return;
        DiagnosticsLog.warn(this, "app", "webview.recovery-shown", report);
        recovery = new AlertDialog.Builder(this)
            .setTitle(local("FreeSeek 界面暂时无法显示", "FreeSeek could not display this screen"))
            .setMessage(local("可以重新打开应用，或分享启动诊断包。", "Reopen the app or share startup diagnostics."))
            .setCancelable(false)
            .setNegativeButton(local("分享诊断包", "Share diagnostics"), null)
            .setPositiveButton(local("重新打开", "Reopen"), (dialog, which) -> recreate())
            .create();
        recovery.setOnShowListener(dialog -> recovery.getButton(AlertDialog.BUTTON_NEGATIVE)
            .setOnClickListener(view -> shareRecovery(report)));
        recovery.show();
    }

    private void shareRecovery(JSObject report) {
        if (recovery == null) return;
        recovery.getButton(AlertDialog.BUTTON_NEGATIVE).setEnabled(false);
        DiagnosticsLog.record(this, "diagnostics", "startup-export.requested", report);
        var context = getApplicationContext();
        DiagnosticsLog.afterPending(() -> {
            try {
                File file = DiagnosticsPlugin.createStartupShare(context, report);
                runOnUiThread(() -> {
                    try {
                        if (isFinishing() || isDestroyed()) {
                            ShareFiles.discard(file);
                            return;
                        }
                        ShareFiles.open(this, file);
                        DiagnosticsLog.record(this, "diagnostics", "startup-share.opened", new JSObject());
                    } catch (Exception error) {
                        ShareFiles.discard(file);
                        recoveryShareFailed(error);
                    } finally {
                        if (recovery != null) recovery.getButton(AlertDialog.BUTTON_NEGATIVE).setEnabled(true);
                    }
                });
            } catch (Exception error) {
                runOnUiThread(() -> recoveryShareFailed(error));
            }
        });
    }

    private void recoveryShareFailed(Exception error) {
        DiagnosticsLog.error(this, "diagnostics", "startup-share.failed", error);
        if (recovery != null) recovery.getButton(AlertDialog.BUTTON_NEGATIVE).setEnabled(true);
        if (!isFinishing() && !isDestroyed()) {
            Toast.makeText(this, local("诊断包未生成，请重试。", "Could not share diagnostics. Try again."),
                Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    public void onDestroy() {
        BackgroundReplyService.releaseWebView();
        TaskNotifications.viewing(this, null);
        if (webViewHealth != null) webViewHealth.stop();
        if (startupSplash != null) startupSplash.destroy();
        if (recovery != null) recovery.dismiss();
        recovery = null;
        super.onDestroy();
    }

    @Override
    public void onConfigurationChanged(android.content.res.Configuration config) {
        super.onConfigurationChanged(config);
        DiagnosticsLog.record(this, "ui", "configuration.changed", new JSObject()
            .put("orientation", config.orientation)
            .put("widthDp", config.screenWidthDp)
            .put("heightDp", config.screenHeightDp)
            .put("fontScale", config.fontScale));
    }

    @Override
    public void onTrimMemory(int level) {
        JSObject details = new JSObject().put("level", level);
        if (level == TRIM_MEMORY_UI_HIDDEN) {
            DiagnosticsLog.record(this, "app", "activity.ui-hidden", details);
        } else {
            DiagnosticsLog.warn(this, "app", "memory.pressure", details);
        }
        super.onTrimMemory(level);
    }
}
