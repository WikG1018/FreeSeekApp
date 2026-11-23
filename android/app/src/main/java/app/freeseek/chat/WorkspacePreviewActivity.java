package app.freeseek.chat;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.FrameLayout;
import android.widget.TextView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** A separate process and origin with no Capacitor bridge or network routes. */
public final class WorkspacePreviewActivity extends Activity {
    private static final String HOST = "freeseek-preview.invalid";
    private static boolean storageConfigured;
    private File root;
    private WebView page;

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        String id = getIntent().getStringExtra("id");
        String entry = getIntent().getStringExtra("entry");
        if (!WorkspaceFilesPlugin.token(id) || !WorkspaceFilesPlugin.safePath(entry)) { finish(); return; }
        root = new File(new File(getCacheDir(), "project-stage"), id + ".preview");
        if (!new File(root, entry).isFile()) { finish(); return; }
        if (!storageConfigured) {
            WebView.setDataDirectorySuffix("workbench-preview");
            storageConfigured = true;
        }
        boolean dark = getIntent().getBooleanExtra("dark", false);
        int background = dark ? 0xff1c1e22 : Color.WHITE;
        int foreground = dark ? 0xfff4f6fb : 0xff171a20;
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setBackgroundDrawable(new ColorDrawable(background));
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        getWindow().setStatusBarContrastEnforced(false);
        getWindow().setNavigationBarContrastEnforced(false);
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(!dark);
        bars.setAppearanceLightNavigationBars(!dark);
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setBackgroundColor(background);
        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        TextView back = new TextView(this);
        back.setText("‹");
        back.setContentDescription(getIntent().getStringExtra("back"));
        back.setTextColor(foreground);
        back.setTextSize(31);
        back.setGravity(Gravity.CENTER);
        back.setOnClickListener(view -> finish());
        bar.addView(back, new LinearLayout.LayoutParams(dp(48), dp(48)));
        TextView label = new TextView(this);
        label.setText(getIntent().getStringExtra("label"));
        label.setTextColor(foreground);
        label.setTextSize(17);
        label.setGravity(Gravity.CENTER_VERTICAL);
        bar.addView(label, new LinearLayout.LayoutParams(0, dp(32), 1));
        column.addView(bar, new LinearLayout.LayoutParams(-1, dp(52)));
        FrameLayout viewport = new FrameLayout(this);
        TextView status = new TextView(this);
        status.setText(getIntent().getStringExtra("loading"));
        status.setTextColor(foreground);
        status.setTextSize(14);
        status.setGravity(Gravity.CENTER);
        viewport.addView(status, new FrameLayout.LayoutParams(-1, -1));
        column.addView(viewport, new LinearLayout.LayoutParams(-1, 0, 1));
        ViewCompat.setOnApplyWindowInsetsListener(column, (view, insets) -> {
            Insets safe = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        setContentView(column);
        ViewCompat.requestApplyInsets(column);
        viewport.postOnAnimation(() -> viewport.post(() -> {
            if (isFinishing() || isDestroyed()) return;
            try {
                render(viewport, status, id, entry, background);
            } catch (RuntimeException error) {
                DiagnosticsLog.error(this, "app", "workspace.preview-failed", error);
                showFailure(viewport, status);
            }
        }));
    }

    private void render(FrameLayout viewport, TextView status, String id, String entry, int background) {
        page = new WebView(this);
        page.setBackgroundColor(background);
        page.setAlpha(0f);
        page.setOverScrollMode(android.view.View.OVER_SCROLL_NEVER);
        WebSettings settings = page.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setBlockNetworkLoads(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setUseWideViewPort(true);
        CookieManager.getInstance().setAcceptCookie(false);
        page.setWebViewClient(new WebViewClient() {
            private boolean failed;
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    failed = true;
                    status.setText(getIntent().getStringExtra("failed"));
                }
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (!failed && !isFinishing()) {
                    view.postVisualStateCallback(0, new WebView.VisualStateCallback() {
                        @Override public void onComplete(long request) {
                            if (failed || isFinishing() || page != view) return;
                            status.setVisibility(android.view.View.GONE);
                            if (android.animation.ValueAnimator.areAnimatorsEnabled()) {
                                view.animate().alpha(1f).setDuration(145).start();
                            } else {
                                view.setAlpha(1f);
                            }
                        }
                    });
                }
            }
            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                if (page == view) showFailure(viewport, status);
                return true;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !local(request.getUrl());
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!"GET".equals(request.getMethod()) || !local(uri)) return blocked();
                String path = uri.getPath().substring(id.length() + 2);
                if (!WorkspaceFilesPlugin.safePath(path)) return blocked();
                File file = new File(root, path);
                try {
                    if (!file.isFile() || !file.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) {
                        return blocked();
                    }
                    Map<String, String> headers = new HashMap<>();
                    headers.put("Cache-Control", "no-store");
                    headers.put("Content-Security-Policy",
                            "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
                            + "img-src 'self' data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'");
                    String lower = path.toLowerCase(Locale.ROOT);
                    String type = lower.endsWith(".html") ? "text/html"
                            : lower.endsWith(".css") ? "text/css"
                            : lower.endsWith(".mjs") || lower.endsWith(".js") ? "application/javascript"
                            : lower.endsWith(".svg") ? "image/svg+xml" : "text/plain";
                    return new WebResourceResponse(type, "UTF-8", 200, "OK", headers, new FileInputStream(file));
                } catch (Exception error) {
                    return blocked();
                }
            }
            private boolean local(Uri uri) {
                return "https".equals(uri.getScheme()) && HOST.equals(uri.getHost())
                        && uri.getPath() != null && uri.getPath().startsWith("/" + id + "/");
            }
        });
        page.setWebViewRenderProcessClient(new android.webkit.WebViewRenderProcessClient() {
            @Override public void onRenderProcessUnresponsive(WebView view, android.webkit.WebViewRenderProcess process) {
                if (process != null) process.terminate();
                status.setVisibility(android.view.View.VISIBLE);
                status.setText(getIntent().getStringExtra("failed"));
            }
            @Override public void onRenderProcessResponsive(WebView view, android.webkit.WebViewRenderProcess process) {}
        });
        viewport.addView(page, 0, new FrameLayout.LayoutParams(-1, -1));
        Uri.Builder url = new Uri.Builder().scheme("https").authority(HOST).appendPath(id);
        for (String segment : entry.split("/")) url.appendPath(segment);
        WebView loading = page;
        loading.loadUrl(url.build().toString());
        viewport.postDelayed(() -> {
            if (page == loading && !isFinishing() && !isDestroyed()
                    && status.getVisibility() == android.view.View.VISIBLE) {
                showFailure(viewport, status);
            }
        }, 12_000);
    }

    private void showFailure(FrameLayout viewport, TextView status) {
        if (page != null) {
            viewport.removeView(page);
            page.destroy();
            page = null;
        }
        status.setVisibility(android.view.View.VISIBLE);
        status.setText(getIntent().getStringExtra("failed"));
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private static WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not found",
                java.util.Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }
    @Override protected void onDestroy() {
        if (page != null) { page.stopLoading(); page.destroy(); }
        if (isFinishing() && root != null) WorkspaceFilesPlugin.remove(root);
        super.onDestroy();
    }
}
