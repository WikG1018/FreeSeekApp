package app.freeseek.chat;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.provider.MediaStore;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/** Launches the system camera with a private, single-file output grant. */
@CapacitorPlugin(name = "PhotoCapture")
public final class PhotoCapturePlugin extends Plugin {
    private static final String FILE_PATTERN = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\\.jpg";
    private static final long MAX_AGE_MS = 24 * 60 * 60_000L;
    private static final long MAX_BYTES = 64 * 1024 * 1024L;
    private static final int URI_FLAGS = Intent.FLAG_GRANT_READ_URI_PERMISSION |
        Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
    private final AtomicBoolean capturing = new AtomicBoolean();
    private volatile String pending;

    private File directory() {
        return new File(getContext().getCacheDir(), "photo-capture");
    }

    private File output(String name) {
        return name != null && name.matches(FILE_PATTERN) ? new File(directory(), name) : null;
    }

    private Uri uri(File file) {
        return FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
    }

    private void releaseGrant(File file) {
        try {
            getContext().revokeUriPermission(uri(file), URI_FLAGS);
        } catch (RuntimeException ignored) {
            // Provider setup can fail before a grant exists.
        }
    }

    @Override
    public void load() {
        new Thread(() -> {
            File[] files = directory().listFiles();
            if (files == null) return;
            long cutoff = System.currentTimeMillis() - MAX_AGE_MS;
            for (File file : files) {
                if (output(file.getName()) != null && file.isFile() && file.lastModified() < cutoff) {
                    file.delete();
                }
            }
        }).start();
    }

    @PluginMethod
    public void take(PluginCall call) {
        if (!capturing.compareAndSet(false, true)) {
            call.reject("Camera already open", "camera-busy");
            return;
        }
        File file = null;
        try {
            File folder = directory();
            if (!folder.isDirectory() && !folder.mkdirs()) throw new IOException("Cannot create camera cache");
            file = new File(folder, UUID.randomUUID() + ".jpg");
            if (!file.createNewFile()) throw new IOException("Cannot create photo output");
            Uri output = uri(file);
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                .putExtra(MediaStore.EXTRA_OUTPUT, output)
                .addFlags(URI_FLAGS);
            intent.setClipData(ClipData.newRawUri("photo-output", output));
            pending = file.getName();
            call.getData().put("photoOutput", pending);
            startActivityForResult(call, intent, "photoTaken");
            DiagnosticsLog.record(getContext(), "upload", "camera.intent-opened", new JSObject());
        } catch (ActivityNotFoundException error) {
            fail(call, file, "camera-unavailable");
        } catch (Exception error) {
            fail(call, file, "camera-launch-failed");
        }
    }

    private void fail(PluginCall call, File file, String code) {
        pending = null;
        capturing.set(false);
        if (file != null) {
            releaseGrant(file);
            file.delete();
        }
        DiagnosticsLog.warn(getContext(), "upload", "camera.intent-failed", new JSObject().put("reason", code));
        call.reject("Unable to capture a photo", code);
    }

    @ActivityCallback
    private void photoTaken(PluginCall call, ActivityResult result) {
        File file = output(call == null ? pending : call.getString("photoOutput"));
        pending = null;
        capturing.set(false);
        if (call == null || PluginCall.CALLBACK_ID_DANGLING.equals(call.getCallbackId())) {
            if (file != null) {
                releaseGrant(file);
                file.delete();
            }
            return;
        }
        if (result.getResultCode() != Activity.RESULT_OK) {
            if (file != null) {
                releaseGrant(file);
                file.delete();
            }
            DiagnosticsLog.record(getContext(), "upload", "camera.intent-cancelled", new JSObject());
            call.resolve(new JSObject().put("cancelled", true));
            return;
        }
        long bytes = file != null && file.isFile() ? file.length() : 0;
        if (bytes == 0 || bytes > MAX_BYTES) {
            fail(call, file, bytes > MAX_BYTES ? "camera-too-large" : "camera-empty");
            return;
        }
        releaseGrant(file);
        DiagnosticsLog.record(getContext(), "upload", "camera.intent-returned", new JSObject().put("bytes", bytes));
        call.resolve(new JSObject().put("id", file.getName()).put("path", file.getAbsolutePath()).put("size", bytes));
    }

    @PluginMethod
    public void release(PluginCall call) {
        File file = output(call.getString("id"));
        if (file != null && !file.getName().equals(pending)) file.delete();
        call.resolve();
    }
}
