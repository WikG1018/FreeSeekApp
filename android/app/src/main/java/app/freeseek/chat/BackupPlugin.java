package app.freeseek.chat;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** 用 SAF 保存到用户选择的位置；不索取存储权限，不缓存整份 base64。 */
@CapacitorPlugin(name = "Backup")
public class BackupPlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Map<String, Save> saves = new HashMap<>();
    private final java.util.concurrent.atomic.AtomicBoolean choosing = new java.util.concurrent.atomic.AtomicBoolean();
    private static final class Save {
        final Uri uri; final OutputStream stream; final long expected;
        final HistoryArchiveOutput archive;
        long written = 0;
        Save(Uri uri, OutputStream stream, long expected, int entries) {
            this.uri = uri; this.stream = stream; this.expected = expected;
            archive = entries > 0 ? new HistoryArchiveOutput(stream, expected, entries) : null;
        }
    }
    @PluginMethod
    public void create(PluginCall call) {
        long expected = HistoryArchiveOutput.backupSize(call.getData().opt("size"));
        JSObject meta = new JSObject(); meta.put("bytes", expected);
        DiagnosticsLog.record(getContext(), "backup", "save.started", meta);
        String name = call.getString("fileName", "freeseek-backup.zip");
        int entries = call.getInt("archiveEntries", 0);
        boolean validName = name != null && (
            name.matches("[A-Za-z0-9_.-]+\\.(zip|json)") ||
            ShareFiles.isDocumentName(name)
        );
        if (!validName || expected < 0 || entries < 0 || entries >= 0xffff
                || (entries > 0 && !name.endsWith(".zip"))) {
            String reason = !validName ? "BACKUP_INVALID_NAME" : expected < 0
                ? "BACKUP_INVALID_SIZE" : "BACKUP_INVALID_ARCHIVE";
            DiagnosticsLog.warn(getContext(), "backup", "save.rejected", new JSObject().put("faultCode", reason));
            call.reject("invalid backup", reason); return;
        }
        if (!choosing.compareAndSet(false, true)) {
            call.reject("save picker already open", "BACKUP_PICKER_BUSY"); return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(ShareFiles.typeOf(name));
        intent.putExtra(Intent.EXTRA_TITLE, name);
        try { startActivityForResult(call, intent, "created"); }
        catch (Exception error) {
            choosing.set(false);
            DiagnosticsLog.error(getContext(), "backup", "save.picker-failed", error);
            call.reject("cannot open save picker", "BACKUP_PICKER_OPEN");
        }
    }
    @ActivityCallback
    private void created(PluginCall call, ActivityResult result) {
        choosing.set(false);
        if (call == null) { return; }
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            DiagnosticsLog.record(getContext(), "backup", "save.cancelled", new JSObject());
            JSObject cancelled = new JSObject(); cancelled.put("cancelled", true); call.resolve(cancelled); return;
        }
        io.execute(() -> {
            try {
                OutputStream stream = getContext().getContentResolver().openOutputStream(uri, "wt");
                if (stream == null) { throw new IllegalStateException("cannot open document"); }
                String id = UUID.randomUUID().toString();
                saves.put(id, new Save(uri, stream, HistoryArchiveOutput.backupSize(call.getData().opt("size")),
                    call.getInt("archiveEntries", 0)));
                JSObject response = new JSObject(); response.put("id", id); call.resolve(response);
            } catch (Exception error) {
                try { DocumentsContract.deleteDocument(getContext().getContentResolver(), uri); } catch (Exception ignored) {}
                DiagnosticsLog.error(getContext(), "backup", "save.create-failed", error);
                call.reject("cannot create backup", "BACKUP_DESTINATION_OPEN");
            }
        });
    }
    @PluginMethod
    public void beginArchiveEntry(PluginCall call) {
        io.execute(() -> {
            String id = call.getString("id", "");
            try {
                Save save = saves.get(id);
                long size = HistoryArchiveOutput.backupSize(call.getData().opt("size"));
                if (save == null || save.archive == null || size < 0) {
                    throw new IllegalArgumentException("Invalid backup entry");
                }
                String name = call.getString("name");
                String key = call.getString("key");
                if (key == null) {
                    save.archive.begin(name, size);
                } else {
                    save.archive.copyOriginal(name, size, HistoryFilesPlugin.originalFile(getContext(), key));
                }
                call.resolve();
            } catch (Exception error) {
                discard(id);
                DiagnosticsLog.error(getContext(), "backup", "save.entry-failed", error);
                call.reject("cannot write backup entry",
                    error instanceof HistoryArchiveOutput.OriginalReadError ? "HISTORY_ARCHIVE_SOURCE" : "HISTORY_ARCHIVE_WRITE");
            }
        });
    }

    @PluginMethod
    public void write(PluginCall call) {
        io.execute(() -> {
            try {
                Save save = saves.get(call.getString("id", ""));
                if (save == null) { throw new IllegalStateException("backup is closed"); }
                String data = call.getString("data", "");
                if (data.length() > 400_000) { throw new IllegalStateException("chunk too large"); }
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                if (save.archive != null) {
                    save.archive.append(bytes, bytes.length);
                } else {
                    if (save.written + bytes.length > save.expected) { throw new IllegalStateException("backup size mismatch"); }
                    save.stream.write(bytes);
                    save.written += bytes.length;
                }
                call.resolve();
            } catch (Exception error) {
                discard(call.getString("id", ""));
                DiagnosticsLog.error(getContext(), "backup", "save.write-failed", error);
                call.reject("cannot write backup", "BACKUP_WRITE");
            }
        });
    }
    @PluginMethod
    public void finish(PluginCall call) {
        io.execute(() -> {
            String id = call.getString("id", "");
            try {
                Save save = saves.get(id);
                if (save == null) { throw new IllegalStateException("backup is closed"); }
                long savedBytes;
                if (save.archive != null) {
                    savedBytes = save.archive.finish();
                } else {
                    if (save.written != save.expected) { throw new IllegalStateException("backup is incomplete"); }
                    save.stream.flush();
                    save.stream.close();
                    savedBytes = save.written;
                }
                saves.remove(id);
                JSObject meta = new JSObject(); meta.put("bytes", savedBytes);
                meta.put("archive", save.archive != null);
                DiagnosticsLog.record(getContext(), "backup", "save.completed", meta); call.resolve();
            } catch (Exception error) {
                discard(id);
                DiagnosticsLog.error(getContext(), "backup", "save.finish-failed", error);
                call.reject("cannot finish backup", "BACKUP_FINALIZE");
            }
        });
    }
    @PluginMethod
    public void cancel(PluginCall call) {
        io.execute(() -> { discard(call.getString("id", "")); call.resolve(); });
    }
    private void discard(String id) {
        Save save = saves.remove(id);
        if (save != null) {
            if (save.archive != null) save.archive.discard();
            try { save.stream.close(); } catch (Exception ignored) {}
            try { DocumentsContract.deleteDocument(getContext().getContentResolver(), save.uri); } catch (Exception ignored) {}
        }
    }
    @Override
    protected void handleOnDestroy() {
        io.execute(() -> { for (String id : saves.keySet().toArray(new String[0])) { discard(id); } });
        io.shutdown();
    }
}
