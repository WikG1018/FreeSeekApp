package app.freeseek.chat;

import android.app.Activity;
import android.app.job.JobInfo;
import android.Manifest;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.PixelCopy;
import android.webkit.WebView;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

@CapacitorPlugin(name = "WorkspaceFiles", permissions = {
    @Permission(alias = "reminderNotifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class WorkspaceFilesPlugin extends Plugin {
    static final int MAX_FILES = 256;
    static final int MAX_FILE = 256 * 1024;
    static final int MAX_BYTES = 4 * 1024 * 1024;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ConcurrentHashMap<String, AtomicBoolean> jobs = new ConcurrentHashMap<>();

    @PluginMethod
    public void scheduleReminder(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33
                && getPermissionState("reminderNotifications") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("reminderNotifications", call, "reminderPermission");
            return;
        }
        reminderPermission(call);
    }

    @PermissionCallback
    private void reminderPermission(PluginCall call) {
        String session = call.getString("sessionId");
        double when = number(call, "at");
        boolean daily = Boolean.TRUE.equals(call.getBoolean("daily"));
        if (!token(session) || !Double.isFinite(when) || when <= System.currentTimeMillis()) {
            DiagnosticsLog.warn(getContext(), "app", "task.reminder.rejected",
                    new JSObject().put("reason", "invalid-schedule"));
            call.reject("invalid reminder");
            return;
        }
        if (!AgentReminderService.notifications(getContext())) {
            call.resolve(new JSObject().put("scheduled", false).put("permission", false));
            return;
        }
        try {
            boolean done = AgentReminderService.schedule(getContext(), session, (long) when, daily,
                    Boolean.TRUE.equals(call.getBoolean("chinese")));
            call.resolve(new JSObject().put("scheduled", done).put("permission", true));
        } catch (Exception error) {
            DiagnosticsLog.error(getContext(), "app", "task.reminder.failed", error);
            call.reject("reminder unavailable");
        }
    }

    @PluginMethod
    public void getReminder(PluginCall call) {
        String session = call.getString("sessionId");
        if (!token(session)) { call.reject("invalid reminder"); return; }
        JobInfo job = AgentReminderService.pending(getContext(), session);
        JSObject response = new JSObject();
        if (job != null) {
            response.put("at", job.getExtras().getLong("at"));
            response.put("daily", job.getExtras().getBoolean("repeat"));
        }
        call.resolve(response);
    }

    @PluginMethod
    public void cancelReminder(PluginCall call) {
        String session = call.getString("sessionId");
        if (!token(session)) { call.reject("invalid reminder"); return; }
        AgentReminderService.cancel(getContext(), session);
        call.resolve();
    }

    @PluginMethod
    public void cancelAllReminders(PluginCall call) {
        AgentReminderService.cancelAll(getContext());
        call.resolve();
    }

    @PluginMethod
    public void reminderTarget(PluginCall call) {
        String session = AgentReminderService.consume(getContext(), getActivity().getIntent());
        if (session == null) session = TaskNotifications.consume(getContext(), getActivity().getIntent());
        JSObject result = new JSObject();
        if (session != null) result.put("sessionId", session);
        call.resolve(result);
    }

    @Override protected void handleOnNewIntent(Intent intent) {
        String session = AgentReminderService.consume(getContext(), intent);
        if (session == null) session = TaskNotifications.consume(getContext(), intent);
        if (session != null) notifyListeners("reminder", new JSObject().put("sessionId", session), true);
    }

    static boolean token(String value) {
        return value != null && value.matches("[a-zA-Z0-9-]{1,64}");
    }

    static boolean safePath(String path) {
        if (path == null || path.length() > 150) return false;
        for (String part : path.split("/", -1)) {
            if (!part.matches("[\\p{L}\\p{N}_.@+-]{1,64}") || part.endsWith(".")
                    || part.matches("(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\..*)?")) return false;
        }
        return true;
    }

    static void remove(File path) {
        File[] children = path.listFiles();
        if (children != null) for (File child : children) remove(child);
        path.delete();
    }

    private File stage(String id, String suffix) {
        return new File(new File(getContext().getCacheDir(), "project-stage"), id + suffix);
    }

    private File prepareStage(String id, String suffix) throws IOException {
        File file = stage(id, suffix);
        File root = file.getParentFile();
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("workspace cache unavailable");
        File[] leftovers = root.listFiles();
        if (leftovers != null) for (File old : leftovers) {
            if (old.getName().matches("[a-zA-Z0-9-]{1,64}(\\.zip|\\.png|\\.preview)")
                    && System.currentTimeMillis() - old.lastModified() > 86_400_000) remove(old);
        }
        return file;
    }

    private static final class WorkspaceSourceException extends IOException {
        private final String code;
        WorkspaceSourceException(String code) { this.code = code; }
    }

    private interface Reader {
        String read(File target, AtomicBoolean cancelled) throws Exception;
    }

    private void start(PluginCall call, String suffix, Reader reader) {
        String id = call.getString("id");
        AtomicBoolean cancelled = new AtomicBoolean();
        if (!token(id) || jobs.putIfAbsent(id, cancelled) != null) {
            call.reject("invalid workspace request");
            return;
        }
        worker.execute(() -> {
            File target = stage(id, suffix);
            try {
                String name = reader.read(prepareStage(id, suffix), cancelled);
                if (cancelled.get()) throw new IOException("workspace cancelled");
                JSObject output = new JSObject().put("path", target.getAbsolutePath());
                if (name != null) output.put("name", name);
                call.resolve(output);
            } catch (WorkspaceSourceException error) {
                remove(target);
                call.reject("workspace import failed", error.code);
            } catch (Exception error) {
                remove(target);
                call.reject(cancelled.get() ? "workspace cancelled" : "workspace import failed");
            } finally {
                jobs.remove(id);
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        AtomicBoolean job = jobs.get(call.getString("id", ""));
        if (job != null) job.set(true);
        call.resolve();
    }

    @PluginMethod
    public void discard(PluginCall call) {
        String id = call.getString("id");
        if (!token(id)) { call.reject("invalid workspace request"); return; }
        worker.execute(() -> {
            remove(stage(id, ".zip"));
            remove(stage(id, ".png"));
            call.resolve();
        });
    }

    private static double number(PluginCall call, String key) {
        Object value = call.getData().opt(key);
        return value instanceof Number ? ((Number) value).doubleValue() : -1d;
    }

    @PluginMethod
    public void captureReader(PluginCall call) {
        String id = call.getString("id");
        double left = number(call, "left"), top = number(call, "top");
        double width = number(call, "width"), height = number(call, "height");
        double ratio = number(call, "ratio");
        if (Build.VERSION.SDK_INT < 26 || !token(id)
                || !Double.isFinite(left + top + width + height + ratio) || ratio <= 0
                || left < -2 || top < -2 || width < 10 || height < 10 || ratio > 8) {
            call.reject("invalid reader viewport");
            return;
        }
        getActivity().runOnUiThread(() -> {
            WebView webView = getBridge().getWebView();
            int[] location = new int[2];
            webView.getLocationInWindow(location);
            int x = Math.max(0, (int) Math.round(left * ratio));
            int y = Math.max(0, (int) Math.round(top * ratio));
            int edgeX = Math.min(webView.getWidth(), (int) Math.round((left + width) * ratio));
            int edgeY = Math.min(webView.getHeight(), (int) Math.round((top + height) * ratio));
            if (edgeX - x <= 0 || edgeY - y <= 0 || (long) (edgeX - x) * (edgeY - y) > 4_000_000L) {
                call.reject("reader viewport unavailable");
                return;
            }
            Rect source = new Rect(location[0] + x, location[1] + y, location[0] + edgeX, location[1] + edgeY);
            Bitmap bitmap = Bitmap.createBitmap(source.width(), source.height(), Bitmap.Config.ARGB_8888);
            try {
                PixelCopy.request(getActivity().getWindow(), source, bitmap, status -> {
                    if (status != PixelCopy.SUCCESS) {
                        bitmap.recycle();
                        call.reject("reader image unavailable");
                        return;
                    }
                    worker.execute(() -> {
                        File target = stage(id, ".png");
                        try (OutputStream output = new FileOutputStream(prepareStage(id, ".png"))) {
                            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) throw new IOException("PNG unavailable");
                            call.resolve(new JSObject().put("path", target.getAbsolutePath()));
                        } catch (IOException error) {
                            remove(target);
                            call.reject("cannot save reader image");
                        } finally { bitmap.recycle(); }
                    });
                }, new Handler(Looper.getMainLooper()));
            } catch (Exception error) {
                bitmap.recycle();
                call.reject("reader image unavailable");
            }
        });
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        if (!token(call.getString("id"))) { call.reject("invalid workspace request"); return; }
        Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        picker.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try { startActivityForResult(call, picker, "folderChosen"); }
        catch (Exception error) { call.reject("workspace picker unavailable"); }
    }

    @ActivityCallback
    private void folderChosen(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Uri tree = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || tree == null) {
            call.resolve(new JSObject().put("cancelled", true));
            return;
        }
        start(call, ".zip", (target, cancelled) -> {
            String folder = DocumentsContract.getTreeDocumentId(tree);
            try (ZipOutputStream zip = new ZipOutputStream(new FileOutputStream(target))) {
                addDirectory(tree, folder, "", zip, new HashSet<>(), new int[2], cancelled);
            }
            Uri chosen = DocumentsContract.buildDocumentUriUsingTree(tree, folder);
            String[] columns = { DocumentsContract.Document.COLUMN_DISPLAY_NAME };
            try (Cursor entry = getContext().getContentResolver().query(chosen, columns, null, null, null)) {
                return entry != null && entry.moveToFirst() ? entry.getString(0) : null;
            } catch (RuntimeException ignored) {
                return null;
            }
        });
    }

    private void addDirectory(Uri tree, String folder, String prefix, ZipOutputStream zip,
            Set<String> visited, int[] stats, AtomicBoolean cancelled) throws IOException {
        if (cancelled.get()) throw new IOException("workspace cancelled");
        if (!visited.add(folder) || visited.size() > MAX_FILES * 3) {
            throw new WorkspaceSourceException("WORKSPACE_LIMIT");
        }
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, folder);
        String[] columns = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
        };
        try (Cursor entries = getContext().getContentResolver().query(children, columns, null, null, null)) {
            if (entries == null) throw new IOException("workspace folder unavailable");
            while (entries.moveToNext()) {
                if (cancelled.get()) throw new IOException("workspace cancelled");
                String name = entries.getString(1);
                if (name == null) throw new IOException("workspace file unnamed");
                String lower = name.toLowerCase(Locale.ROOT);
                if (lower.equals(".git") || lower.equals("node_modules") || lower.equals("__macosx")) continue;
                String path = prefix + name;
                if (!safePath(path) || name.contains("/")) throw new WorkspaceSourceException("WORKSPACE_PATH");
                String id = entries.getString(0);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(entries.getString(2))) {
                    addDirectory(tree, id, path + "/", zip, visited, stats, cancelled);
                } else {
                    if (++stats[0] > MAX_FILES) throw new WorkspaceSourceException("WORKSPACE_LIMIT");
                    Uri document = DocumentsContract.buildDocumentUriUsingTree(tree, id);
                    try (InputStream file = getContext().getContentResolver().openInputStream(document)) {
                        if (file == null) throw new IOException("workspace file unavailable");
                        zip.putNextEntry(new ZipEntry(path));
                        stats[1] += copy(file, zip, Math.min(MAX_FILE, MAX_BYTES - stats[1]), cancelled);
                        zip.closeEntry();
                    }
                }
            }
        }
    }

    private static int copy(InputStream input, OutputStream output, int limit, AtomicBoolean cancelled)
            throws IOException {
        byte[] buffer = new byte[16 * 1024];
        int count, written = 0;
        while ((count = input.read(buffer)) != -1) {
            if (cancelled.get()) throw new IOException("workspace cancelled");
            if (written + count > limit) throw new WorkspaceSourceException("WORKSPACE_LIMIT");
            output.write(buffer, 0, count);
            written += count;
        }
        return written;
    }

    @PluginMethod
    public void githubArchive(PluginCall call) {
        String repository = call.getString("repository", "");
        String revision = call.getString("revision", "");
        if (!repository.matches("[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}")
                || !revision.matches("[a-fA-F0-9]{40}")) {
            call.reject("invalid GitHub repository or revision");
            return;
        }
        start(call, ".zip", (target, cancelled) -> {
            URL address = new URL("https://codeload.github.com/" + repository + "/zip/" + revision);
            HttpsURLConnection connection = (HttpsURLConnection) address.openConnection();
            try {
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(12_000);
                connection.setReadTimeout(8_000);
                int code = connection.getResponseCode();
                String type = connection.getContentType();
                if (code != 200 || type == null || !type.toLowerCase(Locale.ROOT).contains("zip")
                        || connection.getContentLengthLong() > MAX_BYTES + 512 * 1024) {
                    throw new IOException("GitHub archive unavailable");
                }
                try (InputStream input = connection.getInputStream(); OutputStream out = new FileOutputStream(target)) {
                    copy(input, out, MAX_BYTES + 512 * 1024, cancelled);
                }
            } finally { connection.disconnect(); }
            return null;
        });
    }

    @PluginMethod
    public void preview(PluginCall call) {
        String id = call.getString("id");
        String entry = call.getString("entry", "");
        JSArray files = call.getArray("files");
        if (Build.VERSION.SDK_INT < 29 || !token(id)
                || !safePath(entry) || !entry.toLowerCase(Locale.ROOT).endsWith(".html")
                || files == null || files.length() > MAX_FILES) {
            call.reject("invalid preview request");
            return;
        }
        worker.execute(() -> {
            File target = stage(id, ".preview");
            try {
                target = prepareStage(id, ".preview");
                if (!target.mkdir()) throw new IOException("preview already exists");
                int bytes = 0;
                for (int index = 0; index < files.length(); index++) {
                    JSONObject file = files.getJSONObject(index);
                    String path = file.getString("path");
                    if (!safePath(path)) throw new IOException("invalid preview path");
                    byte[] value = file.getString("text").getBytes(StandardCharsets.UTF_8);
                    bytes += value.length;
                    if (bytes > MAX_BYTES || value.length > MAX_FILE) throw new IOException("preview too large");
                    File destination = new File(target, path);
                    File parent = destination.getParentFile();
                    if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("preview write failed");
                    try (OutputStream output = new FileOutputStream(destination)) { output.write(value); }
                }
                if (!new File(target, entry).isFile()) throw new IOException("missing preview entry");
                Intent view = new Intent(getActivity(), WorkspacePreviewActivity.class);
                view.putExtra("id", id);
                view.putExtra("entry", entry);
                view.putExtra("label", call.getString("label", "Preview"));
                view.putExtra("back", call.getString("back", "Back"));
                view.putExtra("loading", call.getString("loading", "Loading"));
                view.putExtra("failed", call.getString("failed", "Could not load preview"));
                view.putExtra("dark", Boolean.TRUE.equals(call.getBoolean("dark")));
                getActivity().runOnUiThread(() -> {
                    try { getActivity().startActivity(view); call.resolve(); }
                    catch (Exception error) { remove(stage(id, ".preview")); call.reject("cannot show preview"); }
                });
            } catch (Exception error) {
                remove(target);
                call.reject("workspace preview unavailable");
            }
        });
    }
}
