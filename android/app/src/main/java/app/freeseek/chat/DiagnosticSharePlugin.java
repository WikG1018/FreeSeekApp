package app.freeseek.chat;

import android.util.Base64;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;

/** 仅缓存本应用生成的诊断 ZIP，分片写入后调起系统分享器。 */
@CapacitorPlugin(name = "DiagnosticShare")
public class DiagnosticSharePlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Map<String, Save> saves = new HashMap<>();
    private static class Save {
        final File file; final OutputStream stream; final long expected; long written;
        Save(File file, OutputStream stream, long expected) { this.file = file; this.stream = stream; this.expected = expected; }
    }
    @PluginMethod public void create(PluginCall call) {
        io.execute(() -> {
            File file = null;
            try {
                double size = call.getDouble("size", -1.0);
                if (!Double.isFinite(size) || size <= 0 || size > 16 * 1024 * 1024 || size != Math.floor(size) || saves.size() >= 4) throw new IOException("Invalid size");
                file = ShareFiles.create(getContext(), call.getString("fileName", ""));
                String id = UUID.randomUUID().toString();
                saves.put(id, new Save(file, new FileOutputStream(file), (long) size));
                JSObject result = new JSObject(); result.put("id", id); call.resolve(result);
            } catch (Exception error) { ShareFiles.discard(file); call.reject("Cannot prepare diagnostic share"); }
        });
    }
    @PluginMethod public void write(PluginCall call) {
        io.execute(() -> {
            String id = call.getString("id", "");
            try {
                Save save = saves.get(id); String data = call.getString("data", "");
                if (save == null || data.length() > 400000) throw new IOException("Invalid share chunk");
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                if (save.written + bytes.length > save.expected) throw new IOException("Share size mismatch");
                save.stream.write(bytes); save.written += bytes.length; call.resolve();
            } catch (Exception error) { discard(id); call.reject("Cannot write diagnostic share"); }
        });
    }
    @PluginMethod public void finish(PluginCall call) {
        io.execute(() -> {
            String id = call.getString("id", "");
            try {
                Save save = saves.get(id);
                if (save == null || save.written != save.expected) throw new IOException("Incomplete share file");
                save.stream.close(); saves.remove(id);
                getActivity().runOnUiThread(() -> {
                    try {
                        ShareFiles.open(getActivity(), save.file);
                        JSObject meta = new JSObject(); meta.put("bytes", save.written);
                        DiagnosticsLog.record(getContext(), "diagnostics", "share.opened", meta);
                        JSObject result = new JSObject(); result.put("launched", true); call.resolve(result);
                    } catch (Exception error) { ShareFiles.discard(save.file); call.reject("Cannot open share sheet"); }
                });
            } catch (Exception error) { discard(id); call.reject("Cannot finish diagnostic share"); }
        });
    }
    @PluginMethod public void cancel(PluginCall call) { io.execute(() -> { discard(call.getString("id", "")); call.resolve(); }); }
    private void discard(String id) {
        Save save = saves.remove(id);
        if (save != null) { try { save.stream.close(); } catch (Exception ignored) {} ShareFiles.discard(save.file); }
    }
    @Override protected void handleOnDestroy() {
        io.execute(() -> { for (String id : saves.keySet().toArray(new String[0])) discard(id); }); io.shutdown();
    }
}
