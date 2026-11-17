package app.freeseek.chat;

import android.content.Context;
import android.util.AtomicFile;
import com.getcapacitor.JSObject;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** 仅存结构化运行元信息。禁止把请求头、正文、文件内容或异常原文传入此记录器。 */
public final class DiagnosticsLog {
    private static final int LIMIT = 1000;
    private static final long RETENTION = 7L * 24 * 3600 * 1000;
    private static final ArrayDeque<JSONObject> events = new ArrayDeque<>();
    private static final ExecutorService io = Executors.newSingleThreadExecutor();
    private static boolean loaded = false, installed = false;
    private static int failedWrites = 0;
    private DiagnosticsLog() {}
    private static AtomicFile file(Context context) {
        File dir = new File(context.getNoBackupFilesDir(), "diagnostics");
        if (!dir.exists()) { dir.mkdirs(); }
        return new AtomicFile(new File(dir, "native-events.json"));
    }
    private static synchronized void load(Context context) {
        if (loaded) { return; }
        loaded = true;
        try {
            AtomicFile file = file(context);
            if (file.getBaseFile().length() > 2_000_000) { file.delete(); return; }
            JSONArray stored = new JSONArray(new String(file.readFully(), StandardCharsets.UTF_8));
            for (int i = Math.max(0, stored.length() - LIMIT); i < stored.length(); i++) {
                JSONObject entry = stored.getJSONObject(i);
                if (entry.optLong("timestamp") > System.currentTimeMillis() - RETENTION) { events.add(entry); }
            }
        } catch (Exception ignored) { /* 首次启动或旧日志损坏不影响业务。 */ }
    }
    private static synchronized void append(Context context, String scope, String event, JSObject details, String level) {
        load(context);
        JSObject entry = new JSObject();
        entry.put("timestamp", System.currentTimeMillis()); entry.put("source", "native");
        entry.put("scope", scope); entry.put("event", event); entry.put("level", level);
        entry.put("details", details);
        events.add(entry);
        while (events.size() > LIMIT || (!events.isEmpty() && events.peek().optLong("timestamp") < System.currentTimeMillis() - RETENTION)) { events.removeFirst(); }
        AtomicFile target = file(context); FileOutputStream out = null;
        try {
            out = target.startWrite();
            out.write(new JSONArray(events).toString().getBytes(StandardCharsets.UTF_8));
            target.finishWrite(out);
        } catch (Exception error) {
            failedWrites++;
            if (out != null) { target.failWrite(out); }
        }
    }
    public static void record(Context context, String scope, String event, JSObject details) {
        Context app = context.getApplicationContext();
        io.execute(() -> append(app, scope, event, details, "info"));
    }
    public static void warn(Context context, String scope, String event, JSObject details) {
        Context app = context.getApplicationContext();
        io.execute(() -> append(app, scope, event, details, "warn"));
    }
    public static void error(Context context, String scope, String event, Throwable error) {
        JSObject details = new JSObject();
        details.put("exception", error.getClass().getName());
        String message = error.getMessage() == null ? "" : error.getMessage();
        Matcher errno = Pattern.compile("\\b(EACCES|ENOSPC|ENOENT|ETIMEDOUT|ECONNRESET|ECONNREFUSED)\\b").matcher(message);
        if (errno.find()) { details.put("errno", errno.group(1)); }
        String[] known = {"package size mismatch", "package digest mismatch", "package signer mismatch",
            "package identity or version mismatch", "APK signature is invalid", "untrusted update URL",
            "download cancelled or too large", "cannot create update directory", "backup is incomplete"};
        for (String reason : known) { if (message.startsWith(reason)) { details.put("reason", reason); break; } }
        Matcher status = Pattern.compile("HTTP (\\d{3})").matcher(message);
        if (status.find()) { details.put("status", Integer.parseInt(status.group(1))); }
        JSONArray frames = new JSONArray();
        for (int i = 0; i < Math.min(8, error.getStackTrace().length); i++) { frames.put(error.getStackTrace()[i].toString()); }
        details.put("frames", frames);
        details.put("causes", causes(error));
        Context app = context.getApplicationContext();
        io.execute(() -> append(app, scope, event, details, "error"));
    }
    public static synchronized JSObject snapshot(Context context) {
        load(context);
        JSObject result = new JSObject(); result.put("events", new JSONArray(events));
        result.put("failedWrites", failedWrites); result.put("limit", LIMIT); return result;
    }
    public static void afterPending(Runnable task) { io.execute(task); }
    private static JSONArray causes(Throwable error) {
        JSONArray causes = new JSONArray();
        Throwable cause = error.getCause();
        for (int depth = 0; cause != null && cause != error && depth < 4; depth++, cause = cause.getCause()) {
            JSObject entry = new JSObject(); entry.put("exception", cause.getClass().getName());
            JSONArray frames = new JSONArray();
            for (int i = 0; i < Math.min(6, cause.getStackTrace().length); i++) { frames.put(cause.getStackTrace()[i].toString()); }
            entry.put("frames", frames); causes.put(entry);
        }
        return causes;
    }
    public static synchronized void installCrashHandler(Context context) {
        if (installed) { return; }
        installed = true;
        Context app = context.getApplicationContext();
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                JSObject details = new JSObject(); details.put("exception", error.getClass().getName());
                JSONArray frames = new JSONArray();
                for (int i = 0; i < Math.min(12, error.getStackTrace().length); i++) { frames.put(error.getStackTrace()[i].toString()); }
                details.put("frames", frames);
                details.put("causes", causes(error));
                append(app, "app", "uncaught-native-error", details, "error");
            } catch (Throwable ignored) {}
            if (previous != null) { previous.uncaughtException(thread, error); }
            else { android.os.Process.killProcess(android.os.Process.myPid()); }
        });
    }
}
