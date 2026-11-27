package app.freeseek.chat;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

/** Keep navigation preferences independent of WebView history storage. Runs on the plugin thread. */
@CapacitorPlugin(name = "StartupRoute")
public class StartupRoutePlugin extends Plugin {
    private SharedPreferences preferences() {
        return getContext().getSharedPreferences("freeseek-startup-route", Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void read(PluginCall call) {
        try {
            SharedPreferences preferences = preferences();
            JSObject value = new JSObject();
            if (preferences.contains("chat")) {
                String id = preferences.getString("chat", "");
                value.put("activeChat", id.isEmpty() ? JSONObject.NULL : id);
            }
            if (preferences.contains("page")) {
                String page = preferences.getString("page", "");
                if ("last-chat".equals(page) || "new-chat".equals(page)) {
                    value.put("startupPage", page);
                }
            }
            call.resolve(value);
        } catch (RuntimeException error) {
            call.reject("Cannot read startup preferences");
        }
    }

    @PluginMethod
    public void save(PluginCall call) {
        try {
            SharedPreferences.Editor edit = preferences().edit();
            if (call.getData().has("activeChat")) {
                if (!call.getData().isNull("activeChat") &&
                        !(call.getData().opt("activeChat") instanceof String)) {
                    call.reject("Invalid chat selection");
                    return;
                }
                String id = call.getString("activeChat", "");
                if (id.length() > 4096) {
                    call.reject("Invalid chat selection");
                    return;
                }
                // An empty string records an explicit choice to return to the home screen.
                edit.putString("chat", id);
            } else {
                String page = call.getString("startupPage", "");
                if (!page.equals("new-chat") && !page.equals("last-chat")) {
                    call.reject("Invalid startup page");
                    return;
                }
                edit.putString("page", page);
            }
            if (edit.commit()) call.resolve();
            else call.reject("Cannot save startup preferences");
        } catch (RuntimeException error) {
            call.reject("Cannot save startup preferences");
        }
    }
}
