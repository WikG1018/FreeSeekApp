package app.freeseek.chat;

import android.os.Bundle;
import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.JSObject;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        DiagnosticsLog.installCrashHandler(getApplicationContext());
        DiagnosticsLog.record(getApplicationContext(), "app", "activity.created", new com.getcapacitor.JSObject());
        registerPlugin(FontScalePlugin.class);
        registerPlugin(AppearancePlugin.class);
        registerPlugin(MicPermissionPlugin.class);
        registerPlugin(DonatePlugin.class);
        registerPlugin(UpdatePlugin.class);
        registerPlugin(BackupPlugin.class);
        registerPlugin(DiagnosticsPlugin.class);
        registerPlugin(CustomHttpPlugin.class);
        registerPlugin(DiagnosticSharePlugin.class);
        // 插件先登记，super 创建 Bridge 后再安装观察器；无 WebView 时保留框架降级页。
        super.onCreate(savedInstanceState);
        if (getBridge() != null) new WindowEdges(getWindow(), getBridge()).install();
        if (getBridge() != null) { getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()) {
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
    @Override
    public void onTrimMemory(int level) {
        com.getcapacitor.JSObject details = new com.getcapacitor.JSObject(); details.put("level", level);
        DiagnosticsLog.record(getApplicationContext(), "app", "memory.pressure", details);
        super.onTrimMemory(level);
    }
}
