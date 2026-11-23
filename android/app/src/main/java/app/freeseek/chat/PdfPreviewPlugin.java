package app.freeseek.chat;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Read-only PDF preview. Stage one seekable copy and render bounded pages off the UI thread. */
@CapacitorPlugin(name = "PdfPreview")
public final class PdfPreviewPlugin extends Plugin {
    private static final long MAX_BYTES = 128L * 1024 * 1024;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Map<String, Preview> documents = new HashMap<>();

    private static final class Preview implements AutoCloseable {
        final File folder;
        final File file;
        final long size;
        BufferedOutputStream stream;
        PdfRenderer renderer;
        long written;

        Preview(File folder, long size) throws IOException {
            this.folder = folder;
            this.size = size;
            file = new File(folder, "document.pdf");
            stream = new BufferedOutputStream(new FileOutputStream(file));
        }

        @Override public void close() {
            if (stream != null) {
                try { stream.close(); } catch (IOException ignored) { }
            }
            if (renderer != null) {
                renderer.close();
            }
            File[] contents = folder.listFiles();
            if (contents != null) {
                for (File item : contents) { item.delete(); }
            }
            folder.delete();
        }
    }

    @PluginMethod public void create(PluginCall call) {
        io.execute(() -> {
            File folder = null;
            try {
                long size = (long) (double) call.getDouble("size", 0.0);
                if (size <= 0 || size > MAX_BYTES || documents.size() >= 2) {
                    throw new IOException("preview-limit");
                }
                String id = UUID.randomUUID().toString();
                File root = new File(getContext().getCacheDir(), "pdf-preview");
                if (!root.isDirectory() && !root.mkdirs()) { throw new IOException("preview-storage"); }
                // Only files created for this feature are in this dedicated cache directory.
                if (documents.isEmpty()) {
                    File[] stale = root.listFiles();
                    if (stale != null) {
                        for (File dir : stale) {
                            if (!dir.isDirectory() || !dir.getName().matches("[a-f0-9-]{36}")) { continue; }
                            File[] children = dir.listFiles();
                            if (children != null) {
                                for (File item : children) { if (item.isFile()) { item.delete(); } }
                            }
                            dir.delete();
                        }
                    }
                }
                folder = new File(root, id);
                if (!folder.mkdir()) { throw new IOException("preview-storage"); }
                documents.put(id, new Preview(folder, size));
                JSObject result = new JSObject();
                result.put("id", id);
                call.resolve(result);
            } catch (Exception error) {
                if (folder != null) {
                    new File(folder, "document.pdf").delete();
                    folder.delete();
                }
                call.reject("Cannot prepare PDF preview", "preview-storage");
            }
        });
    }

    @PluginMethod public void write(PluginCall call) {
        io.execute(() -> {
            try {
                Preview item = documents.get(call.getString("id", ""));
                String data = call.getString("data", "");
                if (item == null || item.stream == null || data.length() > 360_000) {
                    throw new IOException("Invalid preview chunk");
                }
                byte[] chunk = Base64.decode(data, Base64.DEFAULT);
                if (item.written + chunk.length > item.size) { throw new IOException("Invalid PDF length"); }
                item.stream.write(chunk);
                item.written += chunk.length;
                call.resolve();
            } catch (Exception ignored) { call.reject("Cannot stage PDF bytes", "preview-storage"); }
        });
    }

    @PluginMethod public void open(PluginCall call) {
        io.execute(() -> {
            try {
                Preview item = documents.get(call.getString("id", ""));
                if (item == null || item.written != item.size || item.stream == null) {
                    throw new IOException("Incomplete PDF");
                }
                item.stream.close();
                item.stream = null;
                ParcelFileDescriptor fd = ParcelFileDescriptor.open(item.file, ParcelFileDescriptor.MODE_READ_ONLY);
                try {
                    item.renderer = new PdfRenderer(fd);
                } catch (Exception error) {
                    fd.close();
                    throw error;
                }
                JSObject result = new JSObject();
                result.put("pages", item.renderer.getPageCount());
                result.put("searchable", Build.VERSION.SDK_INT >= 35);
                call.resolve(result);
            } catch (SecurityException error) {
                call.reject("PDF requires a password", "preview-password");
            } catch (Exception error) {
                call.reject("Cannot open PDF", "preview-invalid");
            }
        });
    }

    @PluginMethod public void page(PluginCall call) {
        io.execute(() -> {
            Preview item = documents.get(call.getString("id", ""));
            int index = call.getInt("index", -1);
            if (item == null || item.renderer == null || index < 0 || index >= item.renderer.getPageCount()) {
                call.reject("Invalid PDF page", "preview-invalid");
                return;
            }
            try (PdfRenderer.Page page = item.renderer.openPage(index)) {
                JSObject result = new JSObject();
                result.put("width", page.getWidth());
                result.put("height", page.getHeight());
                if (Boolean.TRUE.equals(call.getBoolean("text", false))) {
                    if (Build.VERSION.SDK_INT >= 35) {
                        StringBuilder text = new StringBuilder();
                        for (android.graphics.pdf.content.PdfPageTextContent content : page.getTextContents()) {
                            text.append(content.getText()).append('\n');
                            if (text.length() >= 16_000) { break; }
                        }
                        result.put("text", text.substring(0, Math.min(text.length(), 16_000)));
                    }
                } else {
                    int limit = Math.max(100, Math.min(1700, call.getInt("width", 1000)));
                    double scale = Math.min((double) limit / page.getWidth(), 2200.0 / page.getHeight());
                    int width = Math.max(1, (int) Math.round(page.getWidth() * scale));
                    int height = Math.max(1, (int) Math.round(page.getHeight() * scale));
                    File output = new File(item.folder, "page-" + index + "-" + width + ".png");
                    if (!output.isFile()) {
                        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
                        try (FileOutputStream image = new FileOutputStream(output)) {
                            bitmap.eraseColor(Color.WHITE);
                            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 95, image)) {
                                throw new IOException("Cannot write rendered image");
                            }
                        } catch (Exception failure) {
                            output.delete();
                            throw failure;
                        } finally {
                            bitmap.recycle();
                        }
                    }
                    output.setLastModified(System.currentTimeMillis());
                    File[] images = item.folder.listFiles((directory, name) -> name.endsWith(".png"));
                    if (images != null && images.length > 5) {
                        java.util.Arrays.sort(images, java.util.Comparator.comparingLong(File::lastModified).reversed());
                        for (int n = 5; n < images.length; n++) {
                            if (!images[n].equals(output)) { images[n].delete(); }
                        }
                    }
                    result.put("width", width);
                    result.put("height", height);
                    result.put("url", output.getAbsolutePath());
                }
                call.resolve(result);
            } catch (Exception | OutOfMemoryError error) {
                call.reject("Cannot render PDF page", "preview-render");
            }
        });
    }

    @PluginMethod public void close(PluginCall call) {
        io.execute(() -> {
            Preview item = documents.remove(call.getString("id", ""));
            if (item != null) { item.close(); }
            call.resolve();
        });
    }

    @Override protected void handleOnDestroy() {
        io.execute(() -> {
            for (Preview item : documents.values()) { item.close(); }
            documents.clear();
        });
        io.shutdown();
    }
}
