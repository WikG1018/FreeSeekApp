package app.freeseek.chat;

import android.Manifest;
import android.app.ActivityManager;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Debug;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import org.json.JSONArray;

@CapacitorPlugin(name = "Diagnostics")
public class DiagnosticsPlugin extends Plugin {
    @PluginMethod
    public void snapshot(PluginCall call) {
        DiagnosticsLog.afterPending(() -> {
            try {
                Context context = getContext();
                JSObject result = DiagnosticsLog.snapshot(context), env = new JSObject();
                PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
                env.put("version", info.versionName);
                env.put("debuggable", (context.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);
                env.put("versionCode", Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode);
                env.put("androidVersion", Build.VERSION.RELEASE); env.put("sdk", Build.VERSION.SDK_INT);
                env.put("manufacturer", Build.MANUFACTURER); env.put("model", Build.MODEL);
                env.put("abis", new JSONArray(java.util.Arrays.asList(Build.SUPPORTED_ABIS)));
                env.put("microphoneGranted", context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED);
                if (Build.VERSION.SDK_INT >= 26) {
                    env.put("installPackagesAllowed", context.getPackageManager().canRequestPackageInstalls());
                    PackageInfo webview = WebView.getCurrentWebViewPackage();
                    if (webview != null) { env.put("webviewVersion", webview.versionName); }
                }
                ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
                ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo(); manager.getMemoryInfo(memory);
                Debug.MemoryInfo process = new Debug.MemoryInfo(); Debug.getMemoryInfo(process);
                env.put("systemTotalMemoryBytes", memory.totalMem); env.put("systemAvailableMemoryBytes", memory.availMem);
                env.put("systemLowMemory", memory.lowMemory); env.put("processPssKB", process.getTotalPss());
                env.put("javaHeapMaxBytes", Runtime.getRuntime().maxMemory());
                File files = context.getFilesDir();
                env.put("storageFreeBytes", files.getUsableSpace()); env.put("storageTotalBytes", files.getTotalSpace());
                ConnectivityManager connectivity = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
                NetworkCapabilities network = connectivity.getNetworkCapabilities(connectivity.getActiveNetwork());
                JSObject connection = new JSObject();
                connection.put("connected", network != null);
                if (network != null) {
                    connection.put("validated", network.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED));
                    connection.put("wifi", network.hasTransport(NetworkCapabilities.TRANSPORT_WIFI));
                    connection.put("cellular", network.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR));
                    connection.put("vpn", network.hasTransport(NetworkCapabilities.TRANSPORT_VPN));
                }
                env.put("network", connection);
                if (Build.VERSION.SDK_INT >= 30) {
                    JSONArray exits = new JSONArray();
                    for (android.app.ApplicationExitInfo exit : manager.getHistoricalProcessExitReasons(context.getPackageName(), 0, 5)) {
                        JSObject entry = new JSObject();
                        entry.put("timestamp", exit.getTimestamp()); entry.put("reason", exit.getReason());
                        entry.put("status", exit.getStatus()); entry.put("pssKB", exit.getPss()); entry.put("rssKB", exit.getRss());
                        exits.put(entry);
                    }
                    env.put("recentProcessExits", exits);
                }
                result.put("environment", env); call.resolve(result);
            } catch (Exception error) { DiagnosticsLog.error(getContext(), "diagnostics", "snapshot.failed", error); call.reject("Diagnostics unavailable", error); }
        });
    }
}
