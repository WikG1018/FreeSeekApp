package app.freeseek.chat;

import android.app.Activity;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.IOException;
import java.util.Arrays;
import java.util.Comparator;
import java.util.UUID;

final class ShareFiles {
    private ShareFiles() {}
    static File create(Context context, String name) throws IOException {
        return create(context, name, false);
    }
    static File create(Context context, String name, boolean artifact) throws IOException {
        if (artifact ? !isDocumentName(name) : name == null || !name.matches("freeseek-[A-Za-z0-9_.-]{1,150}\\.zip")) {
            throw new IOException("Invalid share filename");
        }
        File root = new File(context.getCacheDir(), artifact ? "task-shares" : "diagnostic-shares");
        if (!root.isDirectory() && !root.mkdirs() && !root.isDirectory()) {
            throw new IOException("Cannot create share cache");
        }
        File[] folders = root.listFiles();
        if (folders != null) {
            Arrays.sort(folders, Comparator.comparingLong(File::lastModified).reversed());
            for (int i = 0; i < folders.length; i++) {
                File folder = folders[i];
                if (!folder.getName().matches("[0-9a-f-]{36}") || (i < 20 && System.currentTimeMillis() - folder.lastModified() < 86400000L)) continue;
                File[] files = folder.listFiles();
                if (files != null) for (File file : files) if (file.isFile()) file.delete();
                folder.delete();
            }
        }
        File folder = new File(root, UUID.randomUUID().toString());
        if (!folder.mkdir()) throw new IOException("Cannot create share folder");
        return new File(folder, name);
    }
    static void discard(File file) {
        if (file == null) return;
        file.delete();
        file.getParentFile().delete();
    }
    static Intent intent(Context context, File file) {
        Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType(typeOf(file.getName())); send.putExtra(Intent.EXTRA_STREAM, uri);
        send.setClipData(ClipData.newRawUri("FreeSeek", uri));
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return send;
    }
    static boolean isDocumentName(String name) {
        return name != null && name.matches("(?i)[^\\p{Cntrl}/\\\\<>:\"|?*]{1,81}\\.(xlsx|docx|pptx|pdf|md|csv|json|txt|zip|glb|stl|patch|png)");
    }
    static String typeOf(String filename) {
        String name = filename.toLowerCase(java.util.Locale.ROOT);
        if (name.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        if (name.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if (name.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        if (name.endsWith(".pdf")) return "application/pdf";
        if (name.endsWith(".md")) return "text/markdown";
        if (name.endsWith(".csv")) return "text/csv";
        if (name.endsWith(".json")) return "application/json";
        if (name.endsWith(".txt")) return "text/plain";
        if (name.endsWith(".glb")) return "model/gltf-binary";
        if (name.endsWith(".stl")) return "model/stl";
        if (name.endsWith(".patch")) return "text/x-diff";
        if (name.endsWith(".png")) return "image/png";
        return "application/zip";
    }
    static void openDocument(Activity activity, File file) {
        Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", file);
        Intent view = new Intent(Intent.ACTION_VIEW);
        view.setDataAndType(uri, typeOf(file.getName()));
        view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        activity.startActivity(view);
    }
    static void open(Activity activity, File file) {
        Intent chooser = Intent.createChooser(intent(activity, file), null);
        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        activity.startActivity(chooser);
    }
}
