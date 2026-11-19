package app.freeseek.chat;

import android.Manifest;
import android.app.Activity;
import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Debug;
import android.provider.DocumentsContract;
import androidx.activity.result.ActivityResult;
import androidx.webkit.WebViewCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.json.JSONArray;

@CapacitorPlugin(name = "Diagnostics")
public class DiagnosticsPlugin extends Plugin {
    @PluginMethod
    public void snapshot(PluginCall call) {
        DiagnosticsLog.afterPending(() -> {
            try {
                call.resolve(snapshotNow());
            } catch (Exception error) {
                DiagnosticsLog.error(getContext(), "diagnostics", "snapshot.failed", error);
                call.reject("Diagnostics unavailable", error);
            }
        });
    }

    private static JSObject baseEnvironment(Context context) {
        JSObject env = new JSObject();
        env.put("androidVersion", Build.VERSION.RELEASE);
        env.put("sdk", Build.VERSION.SDK_INT);
        env.put("manufacturer", Build.MANUFACTURER);
        env.put("model", Build.MODEL);
        env.put("debuggable", (context.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        env.put("abis", new JSONArray(Arrays.asList(Build.SUPPORTED_ABIS)));
        env.put("pageSizeBytes", android.system.Os.sysconf(android.system.OsConstants._SC_PAGESIZE));
        try {
            PackageInfo app = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            env.put("version", app.versionName);
            env.put("versionCode", Build.VERSION.SDK_INT >= 28 ? app.getLongVersionCode() : app.versionCode);
        } catch (PackageManager.NameNotFoundException ignored) {}
        try {
            PackageInfo webview = WebViewCompat.getCurrentWebViewPackage(context);
            if (webview != null) {
                env.put("webviewVersion", webview.versionName);
                env.put("webviewPackage", webview.packageName);
            }
        } catch (Exception ignored) {}
        return env;
    }

    private JSObject snapshotNow() {
        Context context = getContext();
        JSObject result = DiagnosticsLog.snapshot(context);
        JSObject env = baseEnvironment(context);
        env.put("microphoneGranted", context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED);
        if (Build.VERSION.SDK_INT >= 26) {
            env.put("installPackagesAllowed", context.getPackageManager().canRequestPackageInstalls());
        }

        ActivityManager manager = context.getSystemService(ActivityManager.class);
        if (manager != null) {
            ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo();
            manager.getMemoryInfo(memory);
            Debug.MemoryInfo process = new Debug.MemoryInfo();
            Debug.getMemoryInfo(process);
            env.put("systemTotalMemoryBytes", memory.totalMem);
            env.put("systemAvailableMemoryBytes", memory.availMem);
            env.put("systemLowMemory", memory.lowMemory);
            env.put("processPssKB", process.getTotalPss());
            env.put("lowRamDevice", manager.isLowRamDevice());
            if (Build.VERSION.SDK_INT >= 30) {
                JSONArray exits = new JSONArray();
                for (var exit : manager.getHistoricalProcessExitReasons(context.getPackageName(), 0, 5)) {
                    JSObject entry = new JSObject();
                    entry.put("timestamp", exit.getTimestamp());
                    entry.put("reason", exit.getReason());
                    entry.put("status", exit.getStatus());
                    entry.put("pssKB", exit.getPss());
                    entry.put("rssKB", exit.getRss());
                    String description = exit.getDescription();
                    entry.put("memoryLimiter", description != null && description.contains("MemoryLimiter:AnonSwap"));
                    exits.put(entry);
                }
                env.put("recentProcessExits", exits);
            }
        }
        env.put("javaHeapMaxBytes", Runtime.getRuntime().maxMemory());
        File files = context.getFilesDir();
        env.put("storageFreeBytes", files.getUsableSpace());
        env.put("storageTotalBytes", files.getTotalSpace());

        ConnectivityManager connectivity = context.getSystemService(ConnectivityManager.class);
        if (connectivity != null) {
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
        }
        result.put("environment", env);
        return result;
    }

    /** This bridge also works before the application bundle loads. */
    @PluginMethod
    public void exportStartup(PluginCall call) {
        DiagnosticsLog.record(getContext(), "diagnostics", "startup-export.requested", new JSObject());
        if (Boolean.TRUE.equals(call.getBoolean("share", false))) {
            shareFallback(call);
            return;
        }

        SimpleDateFormat format = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        String prefix = "fallback".equals(call.getString("mode"))
            ? "freeseek-native-diagnostics-" : "freeseek-startup-diagnostics-";
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/zip");
        intent.putExtra(Intent.EXTRA_TITLE, prefix + format.format(new Date()) + ".zip");
        try {
            startActivityForResult(call, intent, "startupDocumentCreated");
        } catch (Exception error) {
            DiagnosticsLog.error(getContext(), "diagnostics", "startup-export.picker-failed", error);
            call.reject("Cannot open the diagnostic file picker", error);
        }
    }

    private static JSObject startupReport(PluginCall call) {
        String phase = call.getString("phase", "bootstrap");
        String error = call.getString("errorName", "Error");
        JSObject report = new JSObject();
        report.put("phase", Arrays.asList("bootstrap", "render", "resource", "timeout", "storage", "diagnostics").contains(phase) ? phase : "bootstrap");
        report.put("errorName", Arrays.asList("Error", "SyntaxError", "TypeError", "ReferenceError",
            "RangeError", "ResourceError", "TimeoutError", "AbortError", "QuotaExceededError",
            "InvalidStateError", "SecurityError", "NotSupportedError", "ArchiveError",
            "ArchiveLimitError", "BackupError").contains(error) ? error : "Error");
        String script = call.getString("script", "");
        if (script.matches("[A-Za-z0-9_-]{1,64}\\.[a-f0-9]{8}\\.(js|css)")) {
            report.put("script", script);
        }
        report.put("line", Math.max(0, Math.min(1_000_000, call.getInt("line", 0))));
        report.put("column", Math.max(0, Math.min(1_000_000, call.getInt("column", 0))));
        return report;
    }

    private void shareFallback(PluginCall call) {
        DiagnosticsLog.afterPending(() -> {
            File file = null;
            try {
                file = ShareFiles.create(getContext(), "freeseek-native-diagnostics-" + System.currentTimeMillis() + ".zip");
                writeBasicArchive(new FileOutputStream(file), startupReport(call), "native-fallback");
                File shared = file;
                getActivity().runOnUiThread(() -> {
                    try {
                        ShareFiles.open(getActivity(), shared);
                        DiagnosticsLog.record(getContext(), "diagnostics", "native-share.opened", new JSObject());
                        call.resolve(new JSObject().put("launched", true));
                    } catch (Exception error) {
                        ShareFiles.discard(shared);
                        DiagnosticsLog.error(getContext(), "diagnostics", "native-share.failed", error);
                        call.reject("Cannot share native diagnostics");
                    }
                });
            } catch (Exception error) {
                ShareFiles.discard(file);
                DiagnosticsLog.error(getContext(), "diagnostics", "native-share.prepare-failed", error);
                call.reject("Cannot prepare native diagnostics");
            }
        });
    }

    private void writeBasicArchive(OutputStream output, JSObject report, String mode) throws Exception {
        try (ZipOutputStream zip = new ZipOutputStream(output)) {
            Context context = getContext();
            JSObject snapshot;
            boolean complete = true;
            try {
                snapshot = snapshotNow();
            } catch (Exception unavailable) {
                complete = false;
                snapshot = DiagnosticsLog.snapshot(context);
                snapshot.put("environment", baseEnvironment(context));
            }
            JSObject nativeEnv = snapshot.getJSObject("environment");
            long timestamp = System.currentTimeMillis();
            JSObject manifest = new JSObject();
            manifest.put("diagnostic_format_version", 1);
            manifest.put("diagnostic_mode", mode);
            manifest.put("createdAtEpochMs", timestamp);
            if (nativeEnv != null) manifest.put("version", nativeEnv.optString("version"));
            JSObject env = new JSObject().put("native", nativeEnv);
            JSObject summary = new JSObject(report.toString());
            summary.put("nativeSnapshotAvailable", complete);
            summary.put("unavailableNativeWrites", snapshot.optInt("failedWrites"));

            JSONArray events = snapshot.getJSONArray("events");
            summary.put("nativeEvents", events.length());
            StringBuilder lines = new StringBuilder();
            for (int i = 0; i < events.length(); i++) {
                lines.append(events.getJSONObject(i)).append('\n');
            }

            boolean startup = "startup".equals(mode);
            JSObject client = new JSObject();
            client.put("source", "client");
            client.put("timestamp", timestamp);
            client.put("scope", startup ? "app" : "diagnostics");
            client.put("level", "error");
            client.put("event", startup ? "startup.failed" : "export.full-unavailable");
            client.put("details", report);
            zipEntry(zip, "manifest.json", manifest.toString());
            zipEntry(zip, "environment.json", env.toString());
            zipEntry(zip, "summary.json", summary.toString());
            zipEntry(zip, "client-events.jsonl", client.toString() + "\n");
            zipEntry(zip, "native-events.jsonl", lines.toString());
            zipEntry(zip, "README.txt", "FreeSeek 基础诊断\n包含版本、设备环境和运行记录。\n不含 API Key、聊天正文、附件原件、录音或原始错误消息。\n");
        }
    }

    private static void zipEntry(ZipOutputStream zip, String name, String data) throws Exception {
        zip.putNextEntry(new ZipEntry(name));
        zip.write(data.getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
    }

    @ActivityCallback
    private void startupDocumentCreated(PluginCall call, ActivityResult activityResult) {
        if (call == null) return;
        Uri uri = activityResult.getData() == null ? null : activityResult.getData().getData();
        if (activityResult.getResultCode() != Activity.RESULT_OK || uri == null) {
            DiagnosticsLog.record(getContext(), "diagnostics", "startup-export.cancelled", new JSObject());
            call.resolve(new JSObject().put("cancelled", true));
            return;
        }
        DiagnosticsLog.afterPending(() -> {
            try {
                JSObject report = startupReport(call);
                String mode = "fallback".equals(call.getString("mode")) ? "native-fallback" : "startup";
                OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt");
                if (out == null) throw new IllegalStateException("Cannot open document");
                writeBasicArchive(out, report, mode);
                DiagnosticsLog.record(getContext(), "diagnostics", "startup-export.saved", report);
                call.resolve(new JSObject().put("saved", true));
            } catch (Exception error) {
                try {
                    DocumentsContract.deleteDocument(getContext().getContentResolver(), uri);
                } catch (Exception ignored) {}
                DiagnosticsLog.error(getContext(), "diagnostics", "startup-export.failed", error);
                call.reject("Cannot save startup diagnostics", error);
            }
        });
    }
}
