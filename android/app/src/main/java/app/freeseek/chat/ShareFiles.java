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
        if (name.length() > 180 || !name.matches("freeseek-[A-Za-z0-9_.-]+\\.zip")) throw new IOException("Invalid diagnostic filename");
        File root = new File(context.getCacheDir(), "diagnostic-shares");
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("Cannot create share cache");
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
    static Intent intent(Context context, File file) {
        Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("application/zip"); send.putExtra(Intent.EXTRA_STREAM, uri);
        send.setClipData(ClipData.newRawUri("diagnostics", uri));
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return send;
    }
    static void open(Activity activity, File file) {
        Intent chooser = Intent.createChooser(intent(activity, file), null);
        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        activity.startActivity(chooser);
    }
}
