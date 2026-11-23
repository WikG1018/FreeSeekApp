package app.freeseek.chat;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.WebView;
import androidx.core.view.ViewCompat;
import com.getcapacitor.JSObject;
import org.json.JSONArray;

/** Detects an attached WebView whose foreground document or visual state never becomes ready. */
final class WebViewHealth {
    private static final long DEADLINE_MS = 6500;
    private static final String PROBE =
        "(function(){var frame=document.querySelector('[data-fs-app-frame]');" +
        "var guard=document.getElementById('fs-startup'),v=window.visualViewport;" +
        "function painted(e){if(!e)return false;var r=e.getBoundingClientRect(),s=getComputedStyle(e);" +
        "return r.width>1&&r.height>1&&s.visibility==='visible'&&s.display!=='none';}" +
        "return [innerWidth,innerHeight,v?Math.round(v.height):innerHeight,painted(frame),painted(guard)];})()";
    private final MainActivity activity;
    private final Handler main = new Handler(Looper.getMainLooper());
    private int generation;
    private JSObject evidence;

    WebViewHealth(MainActivity activity) {
        this.activity = activity;
    }

    void foreground(WebView web, boolean first) {
        stop();
        if (web == null) return;
        int probe = generation;
        long started = SystemClock.elapsedRealtime();
        evidence = new JSObject().put("phase", first ? "startup" : "resume")
            .put("webviewWidth", web.getWidth()).put("webviewHeight", web.getHeight());
        main.postDelayed(() -> {
            if (probe != generation) return;
            // 超时后再宽限一次：从通知冷启动、WebView 首帧慢时先不要打断，
            // 只有确认页面确实没有可渲染内容时才提示恢复。
            inspect(web, probe, started, true, true);
        }, DEADLINE_MS);
        main.postDelayed(() -> inspect(web, probe, started, false), first ? 850 : 300);
    }

    private void inspect(WebView web, int probe, long started, boolean retried) {
        inspect(web, probe, started, retried, false);
    }

    private void inspect(WebView web, int probe, long started, boolean retried, boolean lastChance) {
        if (probe != generation) return;
        if (!web.isAttachedToWindow() || !web.isShown() || web.getWidth() <= 1 || web.getHeight() <= 1) {
            // 最后一次机会仍不可见：说明 WebView 本身没起来，
            // 直接提示恢复，否则用户会卡在没有反馈的白屏上。
            if (lastChance) {
                JSObject report = evidence.put("reason", "webview-not-shown")
                    .put("elapsedMs", SystemClock.elapsedRealtime() - started);
                stop();
                activity.showStartupRecovery(report);
                return;
            }
            retry(web, probe, started, retried);
            return;
        }
        ViewCompat.requestApplyInsets(activity.getWindow().getDecorView());
        web.requestLayout();
        web.invalidate();
        web.evaluateJavascript(
            "window.dispatchEvent(new Event('freeseek:native-foreground'));" + PROBE,
            value -> {
                if (probe != generation) return;
                try {
                    JSONArray frame = new JSONArray(value);
                    evidence.put("viewportWidth", frame.optInt(0))
                        .put("viewportHeight", frame.optInt(1))
                        .put("visualViewportHeight", frame.optInt(2))
                        .put("appVisible", frame.optBoolean(3))
                        .put("guardVisible", frame.optBoolean(4));
                    if (frame.optInt(0) > 1 && frame.optInt(1) > 1 &&
                        (frame.optBoolean(3) || frame.optBoolean(4))) {
                        web.postVisualStateCallback(probe, new WebView.VisualStateCallback() {
                            @Override
                            public void onComplete(long requestId) {
                                if (probe != generation) return;
                                DiagnosticsLog.record(activity, "app", "webview.foreground-ready", evidence
                                    .put("elapsedMs", SystemClock.elapsedRealtime() - started));
                                stop();
                            }
                        });
                        web.invalidate();
                        return;
                    }
                } catch (Exception ignored) {
                    // The page context is still starting or failed before returning a layout.
                }
                if (lastChance) {
                    JSObject report = evidence.put("reason", "foreground-timeout")
                        .put("elapsedMs", SystemClock.elapsedRealtime() - started);
                    stop();
                    activity.showStartupRecovery(report);
                    return;
                }
                retry(web, probe, started, retried);
            });
    }

    private void retry(WebView web, int probe, long started, boolean retried) {
        if (!retried) {
            main.postDelayed(() -> inspect(web, probe, started, true), 2200);
            return;
        }
        // 已经重试过仍不可渲染：给出恢复提示，不要静默卡住。
        JSObject report = evidence.put("reason", "webview-unavailable")
            .put("elapsedMs", SystemClock.elapsedRealtime() - started);
        stop();
        activity.showStartupRecovery(report);
    }

    void stop() {
        generation++;
        main.removeCallbacksAndMessages(null);
    }
}
