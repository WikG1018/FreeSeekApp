package app.freeseek.chat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 字体大小：调用 Android WebView 的 textZoom（只缩放文字，不改变布局尺寸），
 * 避免整体 zoom 导致的固定层留白。
 */
@CapacitorPlugin(name = "FontScale")
public class FontScalePlugin extends Plugin {

    @PluginMethod
    public void setFontScale(PluginCall call) {
        Double scale = call.getDouble("scale", 1.0);
        float textZoom = (float) Math.max(0.85, Math.min(1.25, scale)) * 100f;
        getActivity().runOnUiThread(() -> {
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().getSettings().setTextZoom(Math.round(textZoom));
            }
        });
        call.resolve(new JSObject());
    }
}
