package app.freeseek.chat;

import android.animation.ValueAnimator;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.WebView;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.splashscreen.SplashScreenViewProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.WebViewListener;

/** Keeps the exit view above WebView while the local page prepares its first frame. */
final class StartupSplash extends WebViewListener {
    private static final long FIRST_FRAME_TIMEOUT_MS = 2200;
    /** 系统启动屏的最长存活时间；超时后强制移除，避免通知冷启动等场景白屏 */
    private static final long HARD_RELEASE_TIMEOUT_MS = 6000;
    private static final long EXIT_MS = 105;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final WebView webView;
    private SplashScreenViewProvider provider;
    private boolean frameReady;
    private boolean requested;
    private boolean exiting;
    private boolean removed;
    /** 持有 Runnable 引用，才可以用 removeCallbacks 精确取消 */
    private final Runnable allowExitTask = this::allowExit;
    private final Runnable releaseTask = this::forceRelease;

    private final MainActivity activity;

    StartupSplash(SplashScreen splash, WebView webView, MainActivity activity) {
        this.webView = webView;
        this.activity = activity;
        // Keeping the Activity's pre-draw blocked can delay WebView's first composited frame.
        splash.setOnExitAnimationListener(view -> {
            // 硬超时之后迟到的退出视图：此时 entering/exiting 状态已收尾，
            // 若直接 return 它会一直盖在 WebView 上，表现就是永久白屏。
            if (removed) {
                try { view.remove(); } catch (RuntimeException ignored) { }
                DiagnosticsLog.warn(activity, "app", "startup.splash.late-removed", new JSObject());
                return;
            }
            provider = view;
            exitWhenReady();
        });
        main.postDelayed(allowExitTask, FIRST_FRAME_TIMEOUT_MS);
        // 硬兜底：某些机型（尤其从通知冷启动）退出动画回调可能再也不来，
        // 若不强制清理，系统启动屏会一直盖在上面，表现为白屏。
        main.postDelayed(releaseTask, HARD_RELEASE_TIMEOUT_MS);
    }

    /**
     * 无条件放行：移除启动屏并通知页面，不依赖 provider / 动画回调。
     * 重复调用安全。
     */
    private void forceRelease() {
        // 已正常释放过就不再重复通知页面（重复 dispatch 虽无害但属于多余工作）
        if (removed) return;
        exiting = true;
        frameReady = true;
        if (provider != null) {
            try { provider.remove(); } catch (RuntimeException ignored) { }
            provider = null;
            DiagnosticsLog.warn(activity, "app", "startup.splash.forced", new JSObject()
                .put("hadView", true));
        } else {
            // 退出视图还没来：这里没有可移除的对象，只能先放行页面；
            // 迟到的视图由上面的监听器移除（见 startup.splash.late-removed）。
            DiagnosticsLog.warn(activity, "app", "startup.splash.forced", new JSObject()
                .put("hadView", false));
        }
        removed = true;
        notifyPage();
    }

    @Override
    public void onPageCommitVisible(WebView view, String url) {
        if (removed) notifyPage();
    }

    @Override
    public void onPageLoaded(WebView view) {
        if (removed) notifyPage();
    }

    void markPaintable() {
        if (frameReady || requested) return;
        requested = true;
        webView.postVisualStateCallback(0, new WebView.VisualStateCallback() {
            @Override
            public void onComplete(long requestId) {
                allowExit();
            }
        });
    }

    private void allowExit() {
        frameReady = true;
        exitWhenReady();
    }

    private void exitWhenReady() {
        if (!frameReady || provider == null || exiting) return;
        exiting = true;
        View cover = provider.getView();
        Runnable finish = () -> {
            if (removed) return;
            provider.remove();
            provider = null;
            removed = true;
            notifyPage();
        };
        if (Build.VERSION.SDK_INT >= 26 && !ValueAnimator.areAnimatorsEnabled()) {
            finish.run();
        } else {
            cover.animate().alpha(0f).setDuration(EXIT_MS).withEndAction(finish).start();
            main.postDelayed(finish, EXIT_MS + 80);
        }
    }

    void destroy() {
        // 只清自己的回调，避免影响 Activity 其他延迟任务
        main.removeCallbacks(releaseTask);
        main.removeCallbacks(allowExitTask);
        if (provider != null) {
            try { provider.remove(); } catch (RuntimeException ignored) { }
        }
        provider = null;
        removed = true;
    }

    private void notifyPage() {
        if (!webView.isAttachedToWindow()) return;
        webView.evaluateJavascript(
            "window.__FreeSeekNativeSplashDone=true;" +
            "window.dispatchEvent(new Event('freeseek:native-splash-ended'));",
            null
        );
    }
}
