package app.freeseek.chat;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import java.io.*;
import java.nio.charset.StandardCharsets;

/** 仅装在测试 APK；验证另一个 UID 能读取系统分享 URI，不向任何外部用户发送。 */
public class ShareReceiverActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        boolean matches = false;
        try {
            Uri uri = getIntent().getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri == null) throw new IOException("No URI");
            try (InputStream input = getContentResolver().openInputStream(uri); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[1024]; int count;
                while (input != null && (count = input.read(buffer)) != -1) { output.write(buffer, 0, count); if (output.size() > 1024 * 1024) break; }
                matches = new String(output.toByteArray(), StandardCharsets.UTF_8).equals("SHARE_TEST_诊断");
            }
        } catch (Exception ignored) {}
        sendBroadcast(new Intent("app.freeseek.TEST_SHARE_RECEIVED").setPackage("app.freeseek.chat").putExtra("matches", matches));
        finish();
    }
}
