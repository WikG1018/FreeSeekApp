package app.freeseek.chat;

import android.os.Bundle;
import android.os.SystemClock;
import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.JSObject;

public class MainActivity extends BridgeActivity {
    private StartupSplash startupSplash;
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
        registerPlugin(MicPermissionPlugin.class);
        registerPlugin(DonatePlugin.class);
        registerPlugin(UpdatePlugin.class);
        registerPlugin(BackupPlugin.class);
        registerPlugin(HistoryFilesPlugin.class);
        registerPlugin(DiagnosticsPlugin.class);
        registerPlugin(CustomHttpPlugin.class);
        registerPlugin(DiagnosticSharePlugin.class);
        // 插件先登记，super 创建 Bridge 后再安装观察器；无 WebView 时保留框架降级页。
        super.onCreate(savedInstanceState);
        var bridge = getBridge();
        boolean hasWebView = bridge != null && bridge.getWebView() != null;
        JSObject ready = new JSObject().put("bridgeAvailable", bridge != null)
            .put("webviewAvailable", hasWebView)
            .put("elapsedMs", SystemClock.elapsedRealtime() - createdAt);
        if (hasWebView) {
            DiagnosticsLog.record(this, "app", "bridge.ready", ready);
            new WindowEdges(getWindow(), bridge).install();
            startupSplash = new StartupSplash(splash, bridge.getWebView());
            bridge.addWebViewListener(startupSplash);
        } else {
            DiagnosticsLog.warn(this, "app", "bridge.unavailable", ready);
        }
        if (getBridge() != null) { getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()) {
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
            }
            @Override
            public void onReceivedHttpError(android.webkit.WebView view, android.webkit.WebResourceRequest request,
                                            android.webkit.WebResourceResponse response) {
                JSObject info = new JSObject(); info.put("status", response.getStatusCode());
                info.put("mainFrame", request.isForMainFrame());
                DiagnosticsLog.warn(MainActivity.this, "ui", "webview.http-error", info);
                super.onReceivedHttpError(view, request, response);
            }
            @Override
            @androidx.annotation.RequiresApi(26)
            public boolean onRenderProcessGone(android.webkit.WebView view, android.webkit.RenderProcessGoneDetail detail) {
                JSObject info = new JSObject(); info.put("crashed", detail.didCrash());
                info.put("priority", detail.rendererPriorityAtExit());
                DiagnosticsLog.warn(MainActivity.this, "ui", "webview.renderer-exit", info);
                return super.onRenderProcessGone(view, detail);
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
        DiagnosticsLog.record(this, "app", "activity.resumed", new JSObject());
    }

    @Override
    public void onPause() {
        DiagnosticsLog.record(this, "app", "activity.paused", new JSObject());
        super.onPause();
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
