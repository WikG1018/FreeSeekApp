package app.freeseek.chat;

import android.content.Context;
import android.util.AtomicFile;
import com.getcapacitor.JSObject;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Iterator;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** 仅存结构化运行元信息。禁止把请求头、正文、文件内容或异常原文传入此记录器。 */
public final class DiagnosticsLog {
    private static final int LIMIT = 1000;
    private static final int ISSUE_RESERVE = 150;
    private static final int DETAIL_BYTES = 3000;
    private static final int MAX_FILE_BYTES = 4_000_000;
    private static final long RETENTION = 7L * 24 * 3600 * 1000;
    private static final String runId = UUID.randomUUID().toString();
    private static final ArrayDeque<JSONObject> events = new ArrayDeque<>();
    private static final ExecutorService io = Executors.newSingleThreadExecutor();
    private static boolean loaded = false, installed = false;
    private static int failedWrites = 0;
    private static String readFailure;
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
            if (file.getBaseFile().length() > MAX_FILE_BYTES) {
                readFailure = "size-limit";
                return;
            }
            JSONArray stored = new JSONArray(new String(file.readFully(), StandardCharsets.UTF_8));
            for (int i = Math.max(0, stored.length() - LIMIT); i < stored.length(); i++) {
                JSONObject entry = stored.getJSONObject(i);
                if (entry.optLong("timestamp") > System.currentTimeMillis() - RETENTION) { events.add(entry); }
            }
        } catch (FileNotFoundException ignored) {
            // A new installation does not have a diagnostic log yet.
        } catch (Exception ignored) {
            readFailure = "unreadable";
        }
    }
    private static boolean isIssue(JSONObject event) {
        String level = event.optString("level");
        return "warn".equals(level) || "error".equals(level);
    }
    private static void prune(long now) {
        events.removeIf(event -> event.optLong("timestamp") <= now - RETENTION);
        if (events.size() <= LIMIT) return;
        int issues = 0;
        for (JSONObject event : events) if (isIssue(event)) issues++;
        Iterator<JSONObject> iterator = events.iterator();
        while (events.size() > LIMIT && iterator.hasNext()) {
            boolean issue = isIssue(iterator.next());
            if (issue && issues <= ISSUE_RESERVE) continue;
            iterator.remove();
            if (issue) issues--;
        }
    }
    private static JSObject boundedDetails(JSObject details) {
        if (details.toString().getBytes(StandardCharsets.UTF_8).length <= DETAIL_BYTES) return details;
        JSObject bounded = new JSObject().put("truncated", true);
        for (String key : new String[]{"exception", "errno", "reason", "status", "code", "stage", "requestId"}) {
            Object value = details.opt(key);
            if (value instanceof String && ((String) value).length() <= 160) {
                bounded.put(key, (String) value);
            } else if (value instanceof Number) {
                bounded.put(key, ((Number) value).longValue());
            }
        }
        JSONArray frames = details.optJSONArray("frames");
        if (frames != null) {
            JSONArray first = new JSONArray();
            for (int i = 0; i < Math.min(4, frames.length()); i++) {
                String frame = frames.optString(i);
                if (frame.length() <= 180) first.put(frame);
            }
            bounded.put("frames", first);
        }
        return bounded;
    }
    private static synchronized void append(Context context, String scope, String event, JSObject details, String level, long timestamp) {
        load(context);
        JSObject entry = new JSObject();
        entry.put("timestamp", timestamp); entry.put("source", "native");
        entry.put("runId", runId);
        entry.put("scope", scope); entry.put("event", event); entry.put("level", level);
        entry.put("details", boundedDetails(details));
        events.add(entry);
        prune(System.currentTimeMillis());
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
        long timestamp = System.currentTimeMillis();
        io.execute(() -> append(app, scope, event, details, "info", timestamp));
    }
    public static void warn(Context context, String scope, String event, JSObject details) {
        Context app = context.getApplicationContext();
        long timestamp = System.currentTimeMillis();
        io.execute(() -> append(app, scope, event, details, "warn", timestamp));
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
        long timestamp = System.currentTimeMillis();
        io.execute(() -> append(app, scope, event, details, "error", timestamp));
    }
    public static synchronized JSObject snapshot(Context context) {
        load(context);
        prune(System.currentTimeMillis());
        JSObject result = new JSObject(); result.put("events", new JSONArray(events));
        result.put("failedWrites", failedWrites);
        result.put("readFailure", readFailure);
        result.put("limit", LIMIT);
        return result;
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
                append(app, "app", "uncaught-native-error", details, "error", System.currentTimeMillis());
            } catch (Throwable ignored) {}
            if (previous != null) { previous.uncaughtException(thread, error); }
            else { android.os.Process.killProcess(android.os.Process.myPid()); }
        });
    }
}
