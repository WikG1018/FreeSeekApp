package app.freeseek.chat;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.annotation.ActivityCallback;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
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
            try { call.resolve(snapshotNow()); }
            catch (Exception error) { DiagnosticsLog.error(getContext(), "diagnostics", "snapshot.failed", error); call.reject("Diagnostics unavailable", error); }
        });
    }
    private JSObject snapshotNow() throws Exception {
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
                    PackageInfo webview = androidx.webkit.WebViewCompat.getCurrentWebViewPackage(context);
                    if (webview != null) { env.put("webviewVersion", webview.versionName); env.put("webviewPackage", webview.packageName); }
                }
                ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
                ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo(); manager.getMemoryInfo(memory);
                Debug.MemoryInfo process = new Debug.MemoryInfo(); Debug.getMemoryInfo(process);
                env.put("systemTotalMemoryBytes", memory.totalMem); env.put("systemAvailableMemoryBytes", memory.availMem);
                env.put("systemLowMemory", memory.lowMemory); env.put("processPssKB", process.getTotalPss());
                env.put("javaHeapMaxBytes", Runtime.getRuntime().maxMemory());
                env.put("lowRamDevice", manager.isLowRamDevice());
                env.put("pageSizeBytes", android.system.Os.sysconf(android.system.OsConstants._SC_PAGESIZE));
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
                        String description = exit.getDescription();
                        entry.put("memoryLimiter", description != null && description.contains("MemoryLimiter:AnonSwap"));
                        exits.put(entry);
                    }
                    env.put("recentProcessExits", exits);
                }
                result.put("environment", env); return result;
    }
    /** 主包尚未运行时，也能由静态启动页通过原生桥导出诊断。 */
    @PluginMethod
    public void exportStartup(PluginCall call) {
        DiagnosticsLog.record(getContext(), "diagnostics", "startup-export.requested", new JSObject());
        SimpleDateFormat format = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US); format.setTimeZone(TimeZone.getTimeZone("UTC"));
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT); intent.addCategory(Intent.CATEGORY_OPENABLE);
        String prefix = "fallback".equals(call.getString("mode")) ? "freeseek-native-diagnostics-" : "freeseek-startup-diagnostics-";
        intent.setType("application/zip"); intent.putExtra(Intent.EXTRA_TITLE, prefix + format.format(new Date()) + ".zip");
        startActivityForResult(call, intent, "startupDocumentCreated");
    }
    private JSObject startupReport(PluginCall call) {
        JSObject report = new JSObject();
        String phase = call.getString("phase", "bootstrap"), error = call.getString("errorName", "Error");
        report.put("phase", Arrays.asList("bootstrap", "render", "resource", "timeout", "diagnostics").contains(phase) ? phase : "bootstrap");
        report.put("errorName", Arrays.asList("Error", "SyntaxError", "TypeError", "ReferenceError", "RangeError", "ResourceError", "TimeoutError").contains(error) ? error : "Error");
        String script = call.getString("script", "");
        if (script.matches("[A-Za-z0-9_.-]{1,100}") && !script.toLowerCase(Locale.ROOT).contains("sk-")) { report.put("script", script); }
        report.put("line", Math.max(0, Math.min(1_000_000, call.getInt("line", 0))));
        report.put("column", Math.max(0, Math.min(1_000_000, call.getInt("column", 0))));
        return report;
    }
    private void zipEntry(ZipOutputStream zip, String name, String value) throws Exception {
        zip.putNextEntry(new ZipEntry(name)); zip.write(value.getBytes(StandardCharsets.UTF_8)); zip.closeEntry();
    }
    @ActivityCallback
    private void startupDocumentCreated(PluginCall call, ActivityResult activityResult) {
        if (call == null) { return; }
        Uri uri = activityResult.getData() == null ? null : activityResult.getData().getData();
        if (activityResult.getResultCode() != Activity.RESULT_OK || uri == null) {
            DiagnosticsLog.record(getContext(), "diagnostics", "startup-export.cancelled", new JSObject());
            JSObject response = new JSObject(); response.put("cancelled", true); call.resolve(response); return;
        }
        DiagnosticsLog.afterPending(() -> {
            try {
                JSObject snapshot;
                try { snapshot = snapshotNow(); } catch (Exception unavailable) { snapshot = DiagnosticsLog.snapshot(getContext()); }
                JSObject report = startupReport(call), env = new JSObject(); env.put("native", snapshot.opt("environment"));
                String mode = "fallback".equals(call.getString("mode")) ? "native-fallback" : "startup";
                JSObject manifest = new JSObject(); manifest.put("diagnostic_format_version", 1); manifest.put("diagnostic_mode", mode); manifest.put("createdAtEpochMs", System.currentTimeMillis());
                JSONArray events = snapshot.getJSONArray("events"); StringBuilder nativeEvents = new StringBuilder();
                for (int i = 0; i < events.length(); i++) { nativeEvents.append(events.getJSONObject(i).toString()).append('\n'); }
                JSObject client = new JSObject(); client.put("source", "client"); client.put("timestamp", System.currentTimeMillis());
                client.put("scope", "app"); client.put("level", "error"); client.put("event", "startup.failed"); client.put("details", report);
                try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                    if (out == null) { throw new IllegalStateException("cannot open document"); }
                    try (ZipOutputStream zip = new ZipOutputStream(out)) {
                        zipEntry(zip, "manifest.json", manifest.toString()); zipEntry(zip, "environment.json", env.toString());
                        zipEntry(zip, "summary.json", report.toString()); zipEntry(zip, "client-events.jsonl", client.toString() + "\n");
                        zipEntry(zip, "native-events.jsonl", nativeEvents.toString());
                        zipEntry(zip, "README.txt", "FreeSeek 启动诊断\n包含版本、WebView、设备环境、运行记录和启动错误类型。\n不含 Key、聊天正文、附件原件、录音或原始异常消息。不是聊天备份。\n");
                    }
                }
                DiagnosticsLog.record(getContext(), "diagnostics", "startup-export.saved", report);
                JSObject response = new JSObject(); response.put("saved", true); call.resolve(response);
            } catch (Exception error) {
                try { DocumentsContract.deleteDocument(getContext().getContentResolver(), uri); } catch (Exception ignored) {}
                DiagnosticsLog.error(getContext(), "diagnostics", "startup-export.failed", error); call.reject("Cannot save startup diagnostics", error);
            }
        });
    }
}
