package app.freeseek.chat;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * 打赏相关原生能力：
 * - saveImage：把 base64 图片存进系统相册（Android 10+ 走 MediaStore，无需权限）
 * - openApp：尝试按包名打开支付宝 / 微信；未安装时返回 opened=false，由前端退化为网页链接
 *
 * 只做这两件事，不读取相册、不索取多余权限。
 */
@CapacitorPlugin(
    name = "Donate",
    permissions = {
      @Permission(alias = "storage", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
    }
)
public class DonatePlugin extends Plugin {

    /** 各支付 App 的包名与常用跳转 scheme */
    private static final String ALIPAY_PACKAGE = "com.eg.android.AlipayGphone";
    private static final String WECHAT_PACKAGE = "com.tencent.mm";

    @PluginMethod
    public void saveImage(PluginCall call) {
        String base64 = call.getString("data", "");
        String fileName = call.getString("fileName", "freeseek-donate");
        if (base64.isEmpty()) {
            call.reject("empty image");
            return;
        }
        // Android 10 起 MediaStore 不需要任何权限
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "storageCallback");
            return;
        }
        doSave(call, base64, fileName);
    }

    @PermissionCallback
    private void storageCallback(PluginCall call) {
        if (getPermissionState("storage") == PermissionState.GRANTED) {
            doSave(call, call.getString("data", ""), call.getString("fileName", "freeseek-donate"));
        } else {
            JSObject result = new JSObject();
            result.put("saved", false);
            result.put("reason", "permission");
            call.resolve(result);
        }
    }

    private void doSave(PluginCall call, String base64, String fileName) {
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            String name = fileName + "-" + System.currentTimeMillis() + ".png";
            Uri uri;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Images.Media.DISPLAY_NAME, name);
                values.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
                values.put(
                    MediaStore.Images.Media.RELATIVE_PATH,
                    Environment.DIRECTORY_PICTURES + "/FreeSeek"
                );
                ContentResolver resolver = getContext().getContentResolver();
                uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
                if (uri != null) {
                    try (OutputStream out = resolver.openOutputStream(uri)) {
                        out.write(bytes);
                    }
                }
            } else {
                File dir = new File(
                    Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES),
                    "FreeSeek"
                );
                if (!dir.exists() && !dir.mkdirs()) {
                    throw new IllegalStateException("cannot create dir");
                }
                File file = new File(dir, name);
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(bytes);
                }
                MediaScannerConnection.scanFile(
                    getContext(),
                    new String[] { file.getAbsolutePath() },
                    new String[] { "image/png" },
                    null
                );
                uri = Uri.fromFile(file);
            }
            JSObject result = new JSObject();
            result.put("saved", uri != null);
            result.put("reason", uri == null ? "insert-failed" : "");
            call.resolve(result);
        } catch (Exception error) {
            JSObject result = new JSObject();
            result.put("saved", false);
            result.put("reason", error.getMessage() == null ? "error" : error.getMessage());
            call.resolve(result);
        }
    }

    /**
     * 尝试拉起支付 App。
     * 优先用包名直接启动（稳定），失败再用 scheme；都失败返回 opened=false。
     */
    @PluginMethod
    public void openApp(PluginCall call) {
        String target = call.getString("target", "alipay");
        boolean alipay = !"wechat".equals(target);
        String pkg = alipay ? ALIPAY_PACKAGE : WECHAT_PACKAGE;
        String scheme = call.getString("scheme", alipay ? "alipays://" : "weixin://");

        boolean opened = launchPackage(pkg);
        if (!opened && scheme != null && !scheme.isEmpty()) {
            opened = launchUrl(scheme);
        }
        JSObject result = new JSObject();
        result.put("opened", opened);
        call.resolve(result);
    }

    private boolean launchPackage(String pkg) {
        try {
            Intent intent = getContext().getPackageManager().getLaunchIntentForPackage(pkg);
            if (intent == null) {
                return false;
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    private boolean launchUrl(String scheme) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(scheme));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            return true;
        } catch (Exception error) {
            return false;
        }
    }
}
