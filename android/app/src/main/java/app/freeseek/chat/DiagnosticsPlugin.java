package app.freeseek.chat;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.provider.DocumentsContract;
import androidx.activity.result.ActivityResult;
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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.json.JSONArray;

@CapacitorPlugin(name = "Diagnostics")
public class DiagnosticsPlugin extends Plugin {
    private static final ExecutorService deviceWorker = Executors.newSingleThreadExecutor();
    private static final ExecutorService historyWorker = Executors.newSingleThreadExecutor();
    private static final String HISTORY_PREFERENCES = "history-presence";

    private static JSObject historyCheckpoint(Context context) {
        try {
            SharedPreferences preferences = context.getSharedPreferences(HISTORY_PREFERENCES, Context.MODE_PRIVATE);
            JSObject result = new JSObject().put("present", preferences.getBoolean("has-conversations", false));
            if (preferences.contains("verified-count")) {
                result.put("sessionCount", preferences.getInt("verified-count", 0));
                result.put("verifiedAt", preferences.getLong("verified-at", 0L));
            }
            return result;
        } catch (Exception error) {
            return new JSObject().put("present", false).put("readState", "unreadable");
        }
    }

    @PluginMethod
    public void checkHistory(PluginCall call) {
        // A startup read must not wait for a batch of diagnostic writes.
        historyWorker.execute(() -> call.resolve(historyCheckpoint(getContext())));
    }

    @PluginMethod
    public void recordHistory(PluginCall call) {
        boolean present = Boolean.TRUE.equals(call.getBoolean("present", false));
        Integer count = call.getInt("sessionCount");
        if (count != null && (count < 0 || present != (count > 0))) {
            call.reject("Invalid history verification");
            return;
        }
        historyWorker.execute(() -> {
            try {
                SharedPreferences preferences = getContext().getSharedPreferences(HISTORY_PREFERENCES, Context.MODE_PRIVATE);
                SharedPreferences.Editor edit = preferences.edit().putBoolean("has-conversations", present);
                if (count != null) {
                    edit.putInt("verified-count", count).putLong("verified-at", System.currentTimeMillis());
                } else if (preferences.getBoolean("has-conversations", false) != present) {
                    edit.remove("verified-count").remove("verified-at");
                }
                if (edit.commit()) call.resolve();
                else call.reject("Unable to record history presence");
            } catch (Exception error) {
                call.reject("Unable to record history presence");
            }
        });
    }

    @PluginMethod
    public void retainClientEvents(PluginCall call) {
        JSONArray events = call.getArray("events");
        if (events == null || events.length() < 1 || events.length() > 16) {
            call.reject("Invalid diagnostic batch");
            return;
        }
        RetainedClientLog.enqueue(() -> {
            try {
                RetainedClientLog.append(getContext(), events);
                call.resolve();
            } catch (Exception error) {
                call.reject("Unable to keep diagnostic evidence");
            }
        });
    }

    @PluginMethod
    public void readEvents(PluginCall call) {
        DiagnosticsLog.afterPending(() -> call.resolve(logSnapshot(getContext())));
    }

    @PluginMethod
    public void snapshot(PluginCall call) {
        DiagnosticsLog.afterPending(() -> deviceWorker.execute(() -> {
            try {
                call.resolve(snapshotNow());
            } catch (Exception error) {
                DiagnosticsLog.error(getContext(), "diagnostics", "snapshot.failed", error);
                call.reject("Diagnostics unavailable", error);
            }
        }));
    }

    private static JSObject logSnapshot(Context context) {
        return DiagnosticsLog.snapshot(context)
            .put("retainedClient", RetainedClientLog.snapshot(context))
            .put("historyCheckpoint", historyCheckpoint(context));
    }

    private JSObject snapshotNow() {
        return logSnapshot(getContext()).put("environment", DiagnosticDevice.snapshot(getContext()));
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
                writeBasicArchive(getContext(), new FileOutputStream(file), startupReport(call), "native-fallback");
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

    static File createStartupShare(Context context, JSObject report) throws Exception {
        File file = ShareFiles.create(context, "freeseek-startup-diagnostics-" + System.currentTimeMillis() + ".zip");
        try {
            writeBasicArchive(context, new FileOutputStream(file), report, "startup");
            return file;
        } catch (Exception error) {
            ShareFiles.discard(file);
            throw error;
        }
    }

    private static void writeBasicArchive(Context context, OutputStream output, JSObject report, String mode) throws Exception {
        try (ZipOutputStream zip = new ZipOutputStream(output)) {
            JSObject snapshot = logSnapshot(context);
            JSObject nativeEnv = null;
            try {
                nativeEnv = DiagnosticDevice.snapshot(context);
            } catch (Exception error) {
                DiagnosticsLog.error(context, "diagnostics", "fallback.environment-failed", error);
            }
            long timestamp = System.currentTimeMillis();
            JSObject manifest = new JSObject();
            manifest.put("diagnostic_format_version", 1);
            manifest.put("diagnostic_mode", mode);
            manifest.put("createdAtEpochMs", timestamp);
            if (nativeEnv != null) manifest.put("version", nativeEnv.optString("version"));
            JSObject env = new JSObject().put("native", nativeEnv == null ? new JSObject().put("unavailable", true) : nativeEnv)
                .put("historyCheckpoint", snapshot.getJSObject("historyCheckpoint"));
            JSObject summary = new JSObject(report.toString());
            summary.put("nativeSnapshotAvailable", nativeEnv != null);
            summary.put("clientStorageAvailable", false);
            summary.put("unavailableNativeWrites", snapshot.optInt("failedWrites"));
            if (snapshot.has("readFailure")) summary.put("nativeLogReadFailure", snapshot.optString("readFailure"));

            JSONArray events = snapshot.getJSONArray("events");
            summary.put("nativeEvents", events.length());
            StringBuilder lines = new StringBuilder();
            for (int i = 0; i < events.length(); i++) {
                lines.append(events.getJSONObject(i)).append('\n');
            }
            JSObject retained = snapshot.getJSObject("retainedClient");
            JSONArray keptEvents = retained.getJSONArray("events");
            retained.remove("events");
            summary.put("retainedClient", retained.put("eventCount", keptEvents.length()));
            summary.put("recoveredClientEvents", keptEvents.length());
            StringBuilder clientLines = new StringBuilder();
            for (int i = 0; i < keptEvents.length(); i++) {
                clientLines.append(keptEvents.getJSONObject(i)).append('\n');
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
            zipEntry(zip, "client-events.jsonl", clientLines.append(client).append('\n').toString());
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
                writeBasicArchive(getContext(), out, report, mode);
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
