package app.freeseek.chat;

import android.content.Context;
import android.database.sqlite.SQLiteDatabaseCorruptException;
import android.database.sqlite.SQLiteFullException;
import android.os.Build;
import android.system.ErrnoException;
import android.system.OsConstants;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.nio.file.AccessDeniedException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/** The WebView only handles bounded byte slices and identifiers. The vault remains app-private. */
@CapacitorPlugin(name = "HistoryVault")
public class HistoryVaultPlugin extends Plugin {
    private static final int MAX_BASE64 = ((HistoryVaultObjects.CHUNK_BYTES + 2) / 3) * 4;
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();
    private static HistoryVault vault;
    private final Object owner = new Object();

    @FunctionalInterface
    private interface Operation { JSObject run(HistoryVault store) throws Exception; }

    private void run(PluginCall call, String stage, Operation operation) {
        Context app = getContext().getApplicationContext();
        IO.execute(() -> {
            try {
                if (vault == null) {
                    vault = new HistoryVault(new File(app.getNoBackupFilesDir(), "history-vault"), failure ->
                        DiagnosticsLog.warn(app, "backup", "vault.cleanup-deferred",
                            new JSObject().put("faultCode", faultCode(failure))));
                }
                JSObject result = operation.run(vault);
                if (result == null) call.resolve();
                else call.resolve(result);
            } catch (Exception failure) {
                String code = faultCode(failure);
                if (!"BUSY".equals(code) && !"CHANGED".equals(code)) {
                    DiagnosticsLog.warn(app, "backup", "vault.operation-failed",
                        new JSObject().put("stage", stage).put("faultCode", code));
                }
                call.reject("Private history operation failed", code);
            }
        });
    }

    @PluginMethod public void status(PluginCall call) {
        run(call, "status", store -> statusResult(store.status()));
    }

    @PluginMethod public void begin(PluginCall call) {
        run(call, "begin", store -> new JSObject().put("id", store.begin(
            text(call, "mode", false), number(call, "generation", true), owner)));
    }

    @PluginMethod public void putSession(PluginCall call) {
        run(call, "put-session", store -> {
            store.putSession(text(call, "id", false), text(call, "sessionId", false),
                number(call, "size", false), text(call, "revision", false),
                ids(call, "originalIds"), ids(call, "missingIds"));
            return new JSObject().put("needsAppend", true);
        });
    }

    @PluginMethod public void putOriginal(PluginCall call) {
        Context app = getContext().getApplicationContext();
        run(call, "put-original", store -> {
            String diskKey = text(call, "diskKey", true);
            File source = diskKey == null ? null : HistoryFilesPlugin.originalFile(app, diskKey);
            boolean needsAppend = store.putOriginal(text(call, "id", false),
                text(call, "fileId", false), number(call, "size", false), text(call, "type", false),
                text(call, "sourceRevision", true), source, text(call, "sha256", true), flag(call, "verifyExisting"));
            return new JSObject().put("needsAppend", needsAppend);
        });
    }

    @PluginMethod public void append(PluginCall call) {
        run(call, "append", store -> {
            String data = text(call, "data", false);
            if (data.isEmpty() || data.length() > MAX_BASE64) throw new IllegalArgumentException("Invalid history chunk");
            store.append(text(call, "id", false), Base64.decode(data, Base64.NO_WRAP));
            return null;
        });
    }

    @PluginMethod public void finishEntry(PluginCall call) {
        run(call, "finish-entry", store -> new JSObject().put("sha256", store.finishEntry(text(call, "id", false))));
    }

    @PluginMethod public void deleteSession(PluginCall call) {
        run(call, "delete-session", store -> {
            store.deleteSession(text(call, "id", false), text(call, "sessionId", false));
            return null;
        });
    }

    @PluginMethod public void prepare(PluginCall call) {
        run(call, "prepare", store -> statusResult(store.prepare(text(call, "id", false))));
    }

    @PluginMethod public void commit(PluginCall call) {
        Context app = getContext().getApplicationContext();
        run(call, "commit", store -> {
            HistoryVault.Status status = store.commit(text(call, "id", false));
            DiagnosticsLog.record(app, "backup", "vault.committed", new JSObject()
                .put("generation", status.generation)
                .put("sessionCount", status.sessions)
                .put("originalCount", status.originals)
                .put("missingOriginalCount", status.missingOriginals)
                .put("bytes", status.bytes));
            return statusResult(status);
        });
    }

    @PluginMethod public void cancel(PluginCall call) {
        run(call, "cancel", store -> {
            store.cancel(text(call, "id", false));
            return null;
        });
    }

    @PluginMethod public void listSessions(PluginCall call) { list(call, true); }
    @PluginMethod public void listOriginals(PluginCall call) { list(call, false); }

    private void list(PluginCall call, boolean sessions) {
        run(call, sessions ? "list-sessions" : "list-originals", store -> {
            int limit = sizeLimit(call, "limit", HistoryVault.MAX_PAGE);
            HistoryVault.Page page = store.list(sessions, number(call, "generation", false),
                text(call, "after", true), limit);
            JSArray entries = new JSArray();
            for (HistoryVault.Item item : page.items) {
                JSObject entry = new JSObject()
                    .put("id", item.id)
                    .put("size", item.size)
                    .put("sha256", item.sha256);
                if (sessions) {
                    entry.put("revision", item.revision);
                } else {
                    entry.put("type", item.type);
                    if (item.revision != null) entry.put("sourceRevision", item.revision);
                }
                entries.put(entry);
            }
            JSObject result = new JSObject().put("items", entries);
            if (page.next != null) result.put("next", page.next);
            return result;
        });
    }

    @PluginMethod public void readSession(PluginCall call) {
        run(call, "read-session", store -> {
            HistoryVault.Chunk chunk = store.readSession(number(call, "generation", false),
                text(call, "sessionId", false), number(call, "offset", false),
                sizeLimit(call, "limit", HistoryVaultObjects.CHUNK_BYTES));
            return new JSObject()
                .put("data", Base64.encodeToString(chunk.data, Base64.NO_WRAP))
                .put("nextOffset", chunk.nextOffset).put("eof", chunk.eof);
        });
    }

    @PluginMethod public void restoreOriginal(PluginCall call) {
        Context app = getContext().getApplicationContext();
        run(call, "restore-original", store -> {
            String key = text(call, "key", false);
            HistoryVault.Item item = store.restoreOriginal(number(call, "generation", false),
                text(call, "fileId", false), HistoryFilesPlugin.originalFile(app, key));
            return new JSObject().put("key", key).put("size", item.size)
                .put("type", item.type).put("sha256", item.sha256);
        });
    }

    private static JSObject statusResult(HistoryVault.Status status) {
        JSObject result = new JSObject()
            .put("generation", status.generation)
            .put("sessionCount", status.sessions)
            .put("originalCount", status.originals)
            .put("missingOriginalCount", status.missingOriginals)
            .put("bytes", status.bytes);
        if (status.generation != 0) result.put("verifiedAt", status.verifiedAt);
        if (status.pendingId != null) result.put("pendingId", status.pendingId);
        return result;
    }

    private static String text(PluginCall call, String key, boolean optional) {
        Object value = call.getData().opt(key);
        if ((value == null || value == JSONObject.NULL) && optional) return null;
        if (!(value instanceof String)) throw new IllegalArgumentException("Invalid history text value");
        return (String) value;
    }

    private static Long number(PluginCall call, String key, boolean optional) {
        Object value = call.getData().opt(key);
        if ((value == null || value == JSONObject.NULL) && optional) return null;
        double size = value instanceof Number ? ((Number) value).doubleValue() : -1;
        if (!Double.isFinite(size) || size < 0 || size > HistoryVault.MAX_SAFE_INTEGER || size != Math.floor(size)) {
            throw new IllegalArgumentException("Invalid history numeric value");
        }
        return (long) size;
    }

    private static int sizeLimit(PluginCall call, String key, int maximum) {
        Long limit = number(call, key, true);
        if (limit == null) return maximum;
        if (limit < 1 || limit > maximum) throw new IllegalArgumentException("Invalid history batch size");
        return limit.intValue();
    }

    private static boolean flag(PluginCall call, String key) {
        Object value = call.getData().opt(key);
        if (value == null || value == JSONObject.NULL) return false;
        if (!(value instanceof Boolean)) throw new IllegalArgumentException("Invalid history flag");
        return (Boolean) value;
    }

    private static List<String> ids(PluginCall call, String key) {
        Object value = call.getData().opt(key);
        if (value == null || value == JSONObject.NULL) return Collections.emptyList();
        if (!(value instanceof JSONArray)) throw new IllegalArgumentException("Invalid history reference list");
        JSONArray array = (JSONArray) value;
        List<String> ids = new ArrayList<>(array.length());
        for (int i = 0; i < array.length(); i++) {
            Object item = array.opt(i);
            if (!(item instanceof String)) throw new IllegalArgumentException("Invalid history reference");
            ids.add((String) item);
        }
        return ids;
    }

    private static String faultCode(Exception failure) {
        for (Throwable cause = failure; cause != null; cause = cause.getCause()) {
            if (cause instanceof HistoryVault.Fault) return ((HistoryVault.Fault) cause).code;
            if (cause instanceof SecurityException ||
                (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && cause instanceof AccessDeniedException) ||
                (cause instanceof ErrnoException &&
                    (((ErrnoException) cause).errno == OsConstants.EACCES ||
                     ((ErrnoException) cause).errno == OsConstants.EPERM))) {
                return "PERMISSION";
            }
            if (cause instanceof SQLiteFullException || cause instanceof HistoryVaultObjects.NoSpace
                || (cause instanceof ErrnoException && ((ErrnoException) cause).errno == OsConstants.ENOSPC)) {
                return "NO_SPACE";
            }
            if (cause instanceof SQLiteDatabaseCorruptException || cause instanceof HistoryVaultObjects.IntegrityFailure) {
                return "UNREADABLE";
            }
            String msg = String.valueOf(cause.getMessage()).toLowerCase(Locale.ROOT);
            if (msg.contains("enospc") || msg.contains("no space") || msg.contains("quota exceeded")) {
                return "NO_SPACE";
            }
        }
        return failure instanceof IllegalArgumentException ? "INVALID" : "IO";
    }

    @Override protected void handleOnDestroy() {
        Context app = getContext().getApplicationContext();
        IO.execute(() -> {
            if (vault == null) return;
            try {
                vault.abandon(owner);
            } catch (Exception failure) {
                DiagnosticsLog.warn(app, "backup", "vault.close-deferred", new JSObject().put("faultCode", faultCode(failure)));
            }
        });
    }
}
