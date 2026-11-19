package app.freeseek.chat;

import android.animation.ValueAnimator;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.PorterDuff;
import android.os.Build;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.ImageView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;

/** Draws the short logo handoff above the WebView so it has a native frame clock. */
@CapacitorPlugin(name = "StartupHandoff")
public class StartupHandoffPlugin extends Plugin {
    private FrameLayout cover;
    private View shade;
    private ImageView mark;
    private PluginCall moving;
    private float dx;
    private float dy;
    private float scale;
    private boolean home;

    @PluginMethod
    public void firstPaint(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (getActivity() instanceof MainActivity activity) activity.markStartupPaintable();
            call.resolve();
        });
    }

    @PluginMethod
    public void prepare(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 26 && !ValueAnimator.areAnimatorsEnabled()) {
            call.resolve(new JSObject().put("enabled", false));
            return;
        }
        JSObject source = call.getObject("source");
        JSObject target = call.getObject("target");
        double viewportWidth = call.getDouble("viewportWidth", 0.0);
        if (source == null || viewportWidth <= 0 || source.optDouble("width", 0) <= 0) {
            call.reject("Invalid startup bounds");
            return;
        }
        Bitmap image;
        try (var input = getContext().getAssets().open("public/startup-mark.png")) {
            image = BitmapFactory.decodeStream(input);
        } catch (IOException error) {
            call.reject("Startup mark unavailable", error);
            return;
        }
        if (image == null) {
            call.reject("Startup mark unavailable");
            return;
        }
        getActivity().runOnUiThread(() -> createCover(call, source, target, viewportWidth, image));
    }

    private void createCover(PluginCall call, JSObject source, JSObject target, double viewportWidth, Bitmap image) {
        WebView web = getBridge().getWebView();
        ViewGroup parent = getActivity().findViewById(android.R.id.content);
        if (web == null || parent == null || web.getWidth() <= 0 || !web.isShown()) {
            call.reject("Startup view unavailable");
            return;
        }
        remove(cover);
        int[] webOrigin = new int[2];
        int[] parentOrigin = new int[2];
        web.getLocationInWindow(webOrigin);
        parent.getLocationInWindow(parentOrigin);
        double ratio = web.getWidth() / viewportWidth;
        double width = source.optDouble("width", 0);
        double left = source.optDouble("left", 0);
        double top = source.optDouble("top", 0);
        int size = Math.max(1, (int) Math.round(width * ratio));
        boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", false));
        FrameLayout layer = new FrameLayout(getActivity());
        layer.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        shade = new View(getActivity());
        shade.setBackgroundColor(dark ? Color.rgb(21, 21, 23) : Color.WHITE);
        layer.addView(shade, new FrameLayout.LayoutParams(-1, -1));

        mark = new ImageView(getActivity());
        mark.setImageBitmap(image);
        mark.setScaleType(ImageView.ScaleType.FIT_CENTER);
        if (dark) mark.setColorFilter(Color.rgb(227, 227, 227), PorterDuff.Mode.SRC_IN);
        FrameLayout.LayoutParams position = new FrameLayout.LayoutParams(size, size);
        position.leftMargin = webOrigin[0] - parentOrigin[0] + (int) Math.round(left * ratio);
        position.topMargin = webOrigin[1] - parentOrigin[1] + (int) Math.round(top * ratio);
        layer.addView(mark, position);
        home = target != null && target.optDouble("width", 0) > 0;
        if (home) {
            double endWidth = target.optDouble("width", width);
            dx = (float) ((target.optDouble("left", left) + endWidth / 2 - left - width / 2) * ratio);
            dy = (float) ((target.optDouble("top", top) + endWidth / 2 - top - width / 2) * ratio);
            scale = (float) (endWidth / width);
        }
        cover = layer;
        parent.addView(layer, new ViewGroup.LayoutParams(-1, -1));
        call.resolve(new JSObject().put("enabled", true));
        layer.postDelayed(() -> remove(layer), 2600);
    }

    @PluginMethod
    public void start(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            FrameLayout layer = cover;
            if (layer == null || moving != null) {
                call.reject("Startup cover unavailable");
                return;
            }
            moving = call;
            afterWebPaint(layer, new Runnable() {
                private boolean started;
                @Override public void run() {
                    if (started) return;
                    started = true;
                    if (cover == layer) move(layer, call);
                }
            });
        });
    }

    private void move(FrameLayout layer, PluginCall call) {
        long duration = home ? 280 : 145;
        layer.postOnAnimation(new Runnable() {
            private long last = -1;
            private long elapsed;
            @Override public void run() {
                if (cover != layer) return;
                long now = SystemClock.uptimeMillis();
                // Keep the displacement small if the first app frames are busy.
                if (last >= 0) elapsed += Math.min(34, now - last);
                last = now;
                float t = Math.min(1f, (float) elapsed / duration);
                float pose = t * t * (3f - 2f * t);
                shade.setAlpha(1f - pose);
                if (home) {
                    mark.setTranslationX(dx * pose);
                    mark.setTranslationY(dy * pose);
                    mark.setScaleX(1f + (scale - 1f) * pose);
                    mark.setScaleY(mark.getScaleX());
                } else {
                    mark.setAlpha(1f - pose);
                }
                layer.postOnAnimation(t == 1f ? () -> resolveMotion(call) : this);
            }
        });
    }

    @PluginMethod
    public void dismiss(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            FrameLayout layer = cover;
            if (layer != null) afterWebPaint(layer, () -> remove(layer));
            call.resolve();
        });
    }

    private void afterWebPaint(FrameLayout layer, Runnable action) {
        layer.postDelayed(action, 80);
        WebView web = getBridge().getWebView();
        if (web != null && web.isAttachedToWindow()) {
            web.postVisualStateCallback(0, new WebView.VisualStateCallback() {
                @Override public void onComplete(long requestId) {
                    action.run();
                }
            });
        }
    }

    private void resolveMotion(PluginCall call) {
        if (moving != call || call == null) return;
        moving = null;
        call.resolve();
    }

    private void remove(FrameLayout layer) {
        if (layer == null) return;
        if (layer.getParent() instanceof ViewGroup parent) parent.removeView(layer);
        if (cover == layer) {
            cover = null;
            shade = null;
            mark = null;
            resolveMotion(moving);
        }
    }
}
