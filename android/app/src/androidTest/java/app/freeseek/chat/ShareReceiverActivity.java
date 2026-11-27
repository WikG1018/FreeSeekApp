package app.freeseek.chat;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import java.io.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** 仅装在测试 APK；验证另一个 UID 能读取系统分享 URI，不向任何外部用户发送。 */
public class ShareReceiverActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        boolean matches = false;
        try {
            Uri uri = getIntent().getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri == null) throw new IOException("No URI");
            try (InputStream input = getContentResolver().openInputStream(uri);
                 ZipInputStream zip = new ZipInputStream(input)) {
                int entries = 0;
                long bytes = 0;
                byte[] buffer = new byte[8192];
                for (ZipEntry entry; (entry = zip.getNextEntry()) != null; zip.closeEntry()) {
                    if (++entries > 16) throw new IOException("Unexpected entry count");
                    int count;
                    long size = 0;
                    while ((count = zip.read(buffer)) != -1) {
                        bytes += count;
                        size += count;
                        if (bytes > 32L * 1024 * 1024) throw new IOException("Test size limit");
                    }
                    if (entry.getName().equals("manifest.json") && size > 0) matches = true;
                }
                android.util.Log.i("FreeSeekShareTest", "entries=" + entries + " bytes=" + bytes + " manifest=" + matches);
            }
        } catch (Exception error) {
            matches = false;
            android.util.Log.i("FreeSeekShareTest", "read failed: " + error.getClass().getSimpleName());
        }
        sendBroadcast(new Intent("app.freeseek.TEST_SHARE_RECEIVED").setPackage("app.freeseek.chat").putExtra("matches", matches));
        finish();
    }
}
