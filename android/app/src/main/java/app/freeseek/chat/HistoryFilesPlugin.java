package app.freeseek.chat;

import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** App-private storage for originals from large history imports. */
@CapacitorPlugin(name = "HistoryFiles")
public class HistoryFilesPlugin extends Plugin {
    private static final int CHUNK_BYTES = 512 * 1024;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Map<String, Write> writes = new HashMap<>();

    private static final class Write {
        final File file;
        final long size;
        final FileOutputStream stream;
        long written;

        Write(File file, long size) throws IOException {
            this.file = file;
            this.size = size;
            this.stream = new FileOutputStream(file);
        }
    }

    private File directory() {
        return new File(getContext().getFilesDir(), "history-originals");
    }

    private File file(String key) {
        if (key == null || !key.matches("[a-z0-9-]{12,64}")) {
            throw new IllegalArgumentException("Invalid history file key");
        }
        return new File(directory(), key + ".bin");
    }

    private long fileSize(PluginCall call) {
        Object value = call.getData().opt("size");
        double size = value instanceof Number ? ((Number) value).doubleValue() : -1;
        if (!Double.isFinite(size) || size < 0 || size > 9007199254740991d || size != Math.floor(size)) {
            throw new IllegalArgumentException("Invalid history file size");
        }
        return (long) size;
    }

    @FunctionalInterface
    private interface Operation {
        void run() throws Exception;
    }

    private void enqueue(PluginCall call, Operation operation) {
        io.execute(() -> {
            try {
                operation.run();
            } catch (Exception failure) {
                DiagnosticsLog.error(getContext(), "backup", "history-file.failed", failure);
                String message = String.valueOf(failure.getMessage()).toLowerCase(Locale.ROOT);
                boolean noSpace = message.contains("enospc") || message.contains("no space")
                        || message.contains("quota exceeded");
                call.reject("Unable to access an imported original", noSpace ? "NO_SPACE" : "HISTORY_FILE");
            }
        });
    }

    @PluginMethod public void begin(PluginCall call) {
        enqueue(call, () -> {
            String key = call.getString("key");
            long size = fileSize(call);
            File target = file(key);
            if (writes.containsKey(key) || target.exists()) {
                throw new IllegalArgumentException("Invalid new history file");
            }
            File dir = directory();
            if (!dir.isDirectory() && !dir.mkdirs()) {
                throw new IOException("Could not create history storage");
            }
            if (size > dir.getUsableSpace()) {
                call.reject("Not enough storage for this original", "NO_SPACE");
                return;
            }
            writes.put(key, new Write(target, size));
            call.resolve();
        });
    }

    @PluginMethod public void append(PluginCall call) {
        enqueue(call, () -> {
            Write write = writes.get(call.getString("key"));
            String data = call.getString("data");
            if (write == null || data == null || data.length() > ((CHUNK_BYTES + 2) / 3) * 4) {
                throw new IllegalArgumentException("Invalid file chunk");
            }
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            if (bytes.length == 0 || bytes.length > CHUNK_BYTES || bytes.length > write.size - write.written) {
                throw new IllegalArgumentException("Invalid file chunk size");
            }
            write.stream.write(bytes);
            write.written += bytes.length;
            call.resolve();
        });
    }

    @PluginMethod public void finish(PluginCall call) {
        enqueue(call, () -> {
            Write write = writes.remove(call.getString("key"));
            if (write == null) {
                throw new IllegalArgumentException("Unknown import file");
            }
            try (FileOutputStream stream = write.stream) {
                if (write.written != write.size || write.file.length() != write.size) {
                    throw new IOException("Incomplete original");
                }
                stream.getFD().sync();
            }
            call.resolve();
        });
    }

    @PluginMethod public void locate(PluginCall call) {
        enqueue(call, () -> {
            String key = call.getString("key");
            File local = file(key);
            long size = fileSize(call);
            if (writes.containsKey(key) || !local.isFile() || local.length() != size) {
                throw new IOException("Imported original is missing");
            }
            JSObject result = new JSObject();
            result.put("path", local.getAbsolutePath());
            call.resolve(result);
        });
    }

    private void delete(String key) throws IOException {
        File target = file(key);
        Write write = writes.remove(key);
        if (write != null) {
            write.stream.close();
        }
        if (target.exists() && !target.delete()) {
            throw new IOException("Could not remove unused history file");
        }
    }

    @PluginMethod public void prune(PluginCall call) {
        enqueue(call, () -> {
            JSArray input = call.getArray("keep");
            if (input == null) {
                throw new IllegalArgumentException("Missing history files to retain");
            }
            Set<Object> keep = new HashSet<>(input.toList());
            File[] locals = directory().listFiles();
            if (locals != null) {
                for (File local : locals) {
                    String name = local.getName();
                    if (name.matches("[a-z0-9-]{12,64}\\.bin")) {
                        String key = name.substring(0, name.length() - 4);
                        if (!keep.contains(key)) {
                            delete(key);
                        }
                    }
                }
            }
            call.resolve();
        });
    }

    @PluginMethod public void remove(PluginCall call) {
        enqueue(call, () -> {
            JSArray input = call.getArray("keys");
            if (input == null) {
                throw new IllegalArgumentException("Missing history file keys");
            }
            for (Object value : input.toList()) {
                delete((String) value);
            }
            call.resolve();
        });
    }

    @Override protected void handleOnDestroy() {
        io.execute(() -> {
            for (Write write : writes.values()) {
                try {
                    write.stream.close();
                } catch (IOException ignored) {
                    // A later import removes partial files that were never committed.
                }
            }
            writes.clear();
        });
        io.shutdown();
    }
}
