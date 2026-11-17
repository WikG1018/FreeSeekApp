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
    private static final class Save {
        final Uri uri; final OutputStream stream; final long expected;
        long written = 0;
        Save(Uri uri, OutputStream stream, long expected) {
            this.uri = uri; this.stream = stream; this.expected = expected;
        }
    }
    @PluginMethod
    public void create(PluginCall call) {
        String name = call.getString("fileName", "freeseek-backup.zip");
        if (!name.matches("[A-Za-z0-9_.-]+\\.zip") || call.getDouble("size", -1.0) < 0) {
            call.reject("invalid backup"); return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/zip");
        intent.putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, intent, "created");
    }
    @ActivityCallback
    private void created(PluginCall call, ActivityResult result) {
        if (call == null) { return; }
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            JSObject cancelled = new JSObject(); cancelled.put("cancelled", true); call.resolve(cancelled); return;
        }
        io.execute(() -> {
            try {
                OutputStream stream = getContext().getContentResolver().openOutputStream(uri, "wt");
                if (stream == null) { throw new IllegalStateException("cannot open document"); }
                String id = UUID.randomUUID().toString();
                saves.put(id, new Save(uri, stream, call.getDouble("size", 0.0).longValue()));
                JSObject response = new JSObject(); response.put("id", id); call.resolve(response);
            } catch (Exception error) { call.reject("cannot create backup", error); }
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
                if (save.written + bytes.length > save.expected) { throw new IllegalStateException("backup size mismatch"); }
                save.stream.write(bytes); save.written += bytes.length; call.resolve();
            } catch (Exception error) { call.reject("cannot write backup", error); }
        });
    }
    @PluginMethod
    public void finish(PluginCall call) {
        io.execute(() -> {
            String id = call.getString("id", "");
            try {
                Save save = saves.get(id);
                if (save == null || save.written != save.expected) { throw new IllegalStateException("backup is incomplete"); }
                save.stream.flush(); save.stream.close(); saves.remove(id); call.resolve();
            } catch (Exception error) { call.reject("cannot finish backup", error); }
        });
    }
    @PluginMethod
    public void cancel(PluginCall call) {
        io.execute(() -> { discard(call.getString("id", "")); call.resolve(); });
    }
    private void discard(String id) {
        Save save = saves.remove(id);
        if (save != null) {
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
