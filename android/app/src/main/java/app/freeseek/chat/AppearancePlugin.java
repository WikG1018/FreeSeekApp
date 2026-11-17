package app.freeseek.chat;

import android.content.res.Configuration;
import android.graphics.Color;
import androidx.core.view.WindowCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 原生安全区底色与应用主题一致；不重建 Activity，不打断进行中的会话。 */
@CapacitorPlugin(name = "Appearance")
public class AppearancePlugin extends Plugin {
    private boolean dark;
    @Override public void load() {
        dark = getContext().getSharedPreferences("freeseek-appearance", 0).getBoolean("dark", false);
        getActivity().runOnUiThread(this::apply);
    }
    @PluginMethod public void setTheme(PluginCall call) {
        boolean value = Boolean.TRUE.equals(call.getBoolean("dark", false));
        getActivity().runOnUiThread(() -> {
            dark = value;
            getContext().getSharedPreferences("freeseek-appearance", 0).edit().putBoolean("dark", dark).apply();
            apply(); call.resolve();
        });
    }
    @Override protected void handleOnConfigurationChanged(Configuration configuration) {
        super.handleOnConfigurationChanged(configuration);
        apply();
    }
    private void apply() {
        if (getActivity() == null) return;
        int color = dark ? Color.rgb(21, 21, 23) : Color.WHITE;
        // SystemBars 在旋转/改样式时会再次读 windowBackground，主题属性也要同步。
        getActivity().getTheme().applyStyle(dark ? R.style.FreeSeekWindowDark : R.style.FreeSeekWindowLight, true);
        var window = getActivity().getWindow();
        window.getDecorView().setBackgroundColor(color);
        var controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(!dark);
        controller.setAppearanceLightNavigationBars(!dark);
    }
}
