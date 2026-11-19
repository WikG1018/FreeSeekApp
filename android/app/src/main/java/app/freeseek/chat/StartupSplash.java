package app.freeseek.chat;

import android.animation.ValueAnimator;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.WebView;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.splashscreen.SplashScreenViewProvider;
import com.getcapacitor.WebViewListener;

/** Keeps the exit view above WebView while the local page prepares its first frame. */
final class StartupSplash extends WebViewListener {
    private static final long FIRST_FRAME_TIMEOUT_MS = 2200;
    private static final long EXIT_MS = 105;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final WebView webView;
    private SplashScreenViewProvider provider;
    private boolean frameReady;
    private boolean requested;
    private boolean exiting;
    private boolean removed;

    StartupSplash(SplashScreen splash, WebView webView) {
        this.webView = webView;
        // Keeping the Activity's pre-draw blocked can delay WebView's first composited frame.
        splash.setOnExitAnimationListener(view -> {
            provider = view;
            exitWhenReady();
        });
        main.postDelayed(this::allowExit, FIRST_FRAME_TIMEOUT_MS);
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

    private void notifyPage() {
        if (!webView.isAttachedToWindow()) return;
        webView.evaluateJavascript(
            "window.__FreeSeekNativeSplashDone=true;" +
            "window.dispatchEvent(new Event('freeseek:native-splash-ended'));",
            null
        );
    }
}
