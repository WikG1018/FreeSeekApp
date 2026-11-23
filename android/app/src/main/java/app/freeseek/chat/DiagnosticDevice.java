package app.freeseek.chat;

import android.Manifest;
import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Debug;
import android.os.Process;
import android.provider.MediaStore;
import android.system.Os;
import android.system.OsConstants;
import android.util.DisplayMetrics;
import androidx.webkit.WebViewCompat;
import com.getcapacitor.JSObject;
import java.io.File;
import java.util.Arrays;
import java.util.TimeZone;
import org.json.JSONArray;

/** Device and resource information available without reading user identifiers or requesting permissions. */
final class DiagnosticDevice {
    private DiagnosticDevice() {}

    private interface Probe {
        void read() throws Exception;
    }

    private static void collect(JSObject collection, String section, Probe probe) {
        try {
            probe.read();
            collection.put(section, "available");
        } catch (Exception | LinkageError failure) {
            collection.put(section, new JSObject()
                .put("state", "unavailable")
                .put("exception", failure.getClass().getSimpleName()));
        }
    }

    static JSObject snapshot(Context context) {
        JSObject env = new JSObject();
        JSObject collection = new JSObject();
        env.put("collection", collection);
        env.put("capturedAt", System.currentTimeMillis());
        env.put("androidVersion", Build.VERSION.RELEASE);
        env.put("sdk", Build.VERSION.SDK_INT);
        env.put("securityPatch", Build.VERSION.SECURITY_PATCH);
        env.put("buildId", Build.ID);
        env.put("manufacturer", Build.MANUFACTURER);
        env.put("brand", Build.BRAND);
        env.put("model", Build.MODEL);
        env.put("device", Build.DEVICE);
        env.put("hardware", Build.HARDWARE);
        if (Build.VERSION.SDK_INT >= 31) {
            env.put("socManufacturer", Build.SOC_MANUFACTURER);
            env.put("socModel", Build.SOC_MODEL);
        }
        env.put("abis", new JSONArray(Arrays.asList(Build.SUPPORTED_ABIS)));
        env.put("process64Bit", Process.is64Bit());

        collect(collection, "app", () -> {
            PackageInfo app = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            ApplicationInfo info = context.getApplicationInfo();
            env.put("version", app.versionName);
            env.put("versionCode", Build.VERSION.SDK_INT >= 28 ? app.getLongVersionCode() : app.versionCode);
            env.put("targetSdk", info.targetSdkVersion);
            env.put("debuggable", (info.flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
            env.put("lastUpdateAt", app.lastUpdateTime);
        });
        collect(collection, "webview", () -> {
            PackageInfo webview = WebViewCompat.getCurrentWebViewPackage(context);
            env.put("webviewDetected", webview != null);
            if (webview != null) {
                env.put("webviewPackage", webview.packageName);
                env.put("webviewVersion", webview.versionName);
                env.put("webviewVersionCode", Build.VERSION.SDK_INT >= 28
                    ? webview.getLongVersionCode() : webview.versionCode);
            }
        });
        collect(collection, "display", () -> {
            Configuration config = context.getResources().getConfiguration();
            DisplayMetrics metrics = context.getResources().getDisplayMetrics();
            env.put("display", new JSObject()
                .put("widthPixels", metrics.widthPixels)
                .put("heightPixels", metrics.heightPixels)
                .put("densityDpi", metrics.densityDpi)
                .put("widthDp", config.screenWidthDp)
                .put("heightDp", config.screenHeightDp)
                .put("smallestWidthDp", config.smallestScreenWidthDp)
                .put("orientation", config.orientation)
                .put("fontScale", config.fontScale)
                .put("nightMode", (config.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES));
            env.put("systemLocales", config.getLocales().toLanguageTags());
            env.put("timeZone", TimeZone.getDefault().getID());
        });
        collect(collection, "permissions", () -> {
            env.put("microphoneGranted",
                context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED);
            if (Build.VERSION.SDK_INT >= 26) {
                env.put("installPackagesAllowed", context.getPackageManager().canRequestPackageInstalls());
            }
            if (Build.VERSION.SDK_INT >= 37) {
                env.put("localNetworkGranted", context.checkSelfPermission("android.permission.ACCESS_LOCAL_NETWORK")
                    == PackageManager.PERMISSION_GRANTED);
            }
        });
        collect(collection, "camera", () -> env.put("cameraAvailable",
            new Intent(MediaStore.ACTION_IMAGE_CAPTURE).resolveActivity(context.getPackageManager()) != null));
        collect(collection, "memory", () -> {
            Runtime runtime = Runtime.getRuntime();
            env.put("javaHeapMaxBytes", runtime.maxMemory());
            env.put("javaHeapUsedBytes", runtime.totalMemory() - runtime.freeMemory());
            env.put("pageSizeBytes", Os.sysconf(OsConstants._SC_PAGESIZE));
            ActivityManager manager = context.getSystemService(ActivityManager.class);
            if (manager == null) throw new IllegalStateException();
            ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo();
            manager.getMemoryInfo(memory);
            Debug.MemoryInfo process = new Debug.MemoryInfo();
            Debug.getMemoryInfo(process);
            env.put("systemTotalMemoryBytes", memory.totalMem);
            env.put("systemAvailableMemoryBytes", memory.availMem);
            env.put("systemLowMemory", memory.lowMemory);
            env.put("systemMemoryThresholdBytes", memory.threshold);
            env.put("processPssKB", process.getTotalPss());
            env.put("lowRamDevice", manager.isLowRamDevice());
            env.put("memoryClassMB", manager.getMemoryClass());
        });
        if (Build.VERSION.SDK_INT >= 30) {
            collect(collection, "processExits", () -> {
                ActivityManager manager = context.getSystemService(ActivityManager.class);
                if (manager == null) throw new IllegalStateException();
                JSONArray exits = new JSONArray();
                for (var exit : manager.getHistoricalProcessExitReasons(context.getPackageName(), 0, 5)) {
                    String description = exit.getDescription();
                    exits.put(new JSObject()
                        .put("timestamp", exit.getTimestamp())
                        .put("reason", exit.getReason())
                        .put("status", exit.getStatus())
                        .put("pssKB", exit.getPss())
                        .put("rssKB", exit.getRss())
                        .put("memoryLimiter", description != null && description.contains("MemoryLimiter:AnonSwap")));
                }
                env.put("recentProcessExits", exits);
            });
        } else {
            collection.put("processExits", "unsupported");
        }
        collect(collection, "storage", () -> {
            File files = context.getFilesDir();
            env.put("storageFreeBytes", files.getUsableSpace());
            env.put("storageTotalBytes", files.getTotalSpace());
        });
        collect(collection, "network", () -> {
            ConnectivityManager connectivity = context.getSystemService(ConnectivityManager.class);
            if (connectivity == null) throw new IllegalStateException();
            NetworkCapabilities network = connectivity.getNetworkCapabilities(connectivity.getActiveNetwork());
            JSObject connection = new JSObject().put("connected", network != null);
            if (network != null) {
                connection.put("validated", network.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED));
                connection.put("metered", connectivity.isActiveNetworkMetered());
                connection.put("wifi", network.hasTransport(NetworkCapabilities.TRANSPORT_WIFI));
                connection.put("cellular", network.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR));
                connection.put("ethernet", network.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET));
                connection.put("vpn", network.hasTransport(NetworkCapabilities.TRANSPORT_VPN));
            }
            env.put("network", connection);
        });
        return env;
    }
}
