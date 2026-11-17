package app.freeseek.chat;

import android.graphics.Color;
import android.os.Build;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.WebViewListener;
import java.util.Locale;

/** 画布延伸到系统栏。把可操作区域的四边距离交给页面，键盘高度只在原生层扣一次。 */
final class WindowEdges {
    private final Window window;
    private final Bridge bridge;
    private Insets safe;
    private String lastScript;

    WindowEdges(Window window, Bridge bridge) {
        this.window = window;
        this.bridge = bridge;
    }

    void install() {
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 29) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }
        if (Build.VERSION.SDK_INT >= 28) {
            window.setNavigationBarDividerColor(Color.TRANSPARENT);
            WindowManager.LayoutParams layout = window.getAttributes();
            layout.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(layout);
        }
        View decor = window.getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(decor, (view, insets) -> {
            int bars = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
            Insets system = insets.getInsets(bars);
            int keyboard = insets.isVisible(WindowInsetsCompat.Type.ime())
                ? insets.getInsets(WindowInsetsCompat.Type.ime()).bottom : 0;
            int keyboardPadding = keyboard > system.bottom ? keyboard : 0;
            if (view.getPaddingBottom() != keyboardPadding || view.getPaddingTop() != 0 ||
                    view.getPaddingLeft() != 0 || view.getPaddingRight() != 0) {
                view.setPadding(0, 0, 0, keyboardPadding);
            }
            safe = Insets.of(system.left, system.top, system.right, keyboardPadding == 0 ? system.bottom : 0);
            publish(false);
            // Chromium 139+ 还会按 IME 自动缩小视觉视口，清零已处理的距离以免重复留白。
            return new WindowInsetsCompat.Builder(insets)
                .setInsets(bars | WindowInsetsCompat.Type.ime(), Insets.NONE)
                .setVisible(WindowInsetsCompat.Type.ime(), false)
                .setDisplayCutout(null)
                .build();
        });
        bridge.addWebViewListener(new WebViewListener() {
            @Override public void onPageCommitVisible(WebView view, String url) { publish(true); }
            @Override public void onPageLoaded(WebView view) {
                publish(true);
                ViewCompat.requestApplyInsets(decor);
            }
        });
        ViewCompat.requestApplyInsets(decor);
    }

    private void publish(boolean newDocument) {
        if (safe == null || bridge.getWebView() == null) return;
        float density = bridge.getWebView().getResources().getDisplayMetrics().density;
        String script = String.format(Locale.US,
            "(function(){var s=document.documentElement.style;" +
            "s.setProperty('--fs-native-top','%.2fpx');s.setProperty('--fs-native-bottom','%.2fpx');" +
            "s.setProperty('--fs-native-left','%.2fpx');s.setProperty('--fs-native-right','%.2fpx');})()",
            safe.top / density, safe.bottom / density, safe.left / density, safe.right / density);
        if (newDocument || !script.equals(lastScript)) {
            lastScript = script;
            bridge.getWebView().evaluateJavascript(script, null);
        }
    }
}
