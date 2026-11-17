package app.freeseek.chat;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 应用更新：提前下载 APK + 调起系统安装器。
 * - download：后台线程流式下载到应用私有目录，边下边发 progress 事件
 * - install：FileProvider 授权后用 ACTION_VIEW 拉起安装器
 * - hasFile：判断某版本安装包是否已下好（重启后可直接安装）
 *
 * 只下载 GitHub Release 里我们自己的 APK，不接受任意文件安装。
 */
@CapacitorPlugin(name = "Update")
public class UpdatePlugin extends Plugin {

    private static final String DIR = "updates";
    private volatile boolean cancelled = false;

    private File updateDir() {
        File dir = new File(getContext().getExternalFilesDir(null), DIR);
        if (!dir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
        }
        return dir;
    }

    private File apkFile(String fileName) {
        return new File(updateDir(), fileName.endsWith(".apk") ? fileName : fileName + ".apk");
    }

    /**
     * 代发 GET 请求：WebView 里的 fetch 受 CORS 限制，国内镜像大多不带 CORS 头，
     * 由原生发请求可以绕开这个限制（只用于读取 Release 元数据）。
     */
    @PluginMethod
    public void get(PluginCall call) {
        String url = call.getString("url", "");
        int timeout = call.getInt("timeoutMs", 8000);
        if (url.isEmpty()) {
            call.reject("empty url");
            return;
        }
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setInstanceFollowRedirects(true);
                connection.setConnectTimeout(timeout);
                connection.setReadTimeout(timeout);
                connection.setRequestProperty("Accept", "application/vnd.github+json");
                connection.setRequestProperty("User-Agent", "FreeSeek-Updater");
                int status = connection.getResponseCode();
                java.io.InputStream stream = status >= 400
                    ? connection.getErrorStream()
                    : connection.getInputStream();
                StringBuilder text = new StringBuilder();
                if (stream != null) {
                    try (java.io.InputStream in = stream) {
                        byte[] buffer = new byte[16 * 1024];
                        int read;
                        while ((read = in.read(buffer)) != -1 && text.length() < 2_000_000) {
                            text.append(new String(buffer, 0, read, "UTF-8"));
                        }
                    }
                }
                JSObject result = new JSObject();
                result.put("status", status);
                result.put("body", text.toString());
                call.resolve(result);
            } catch (Exception error) {
                call.reject(error.getMessage() == null ? "request failed" : error.getMessage());
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }
        }).start();
    }

    @PluginMethod
    public void hasFile(PluginCall call) {
        String name = call.getString("fileName", "");
        File file = apkFile(name);
        JSObject result = new JSObject();
        result.put("exists", file.exists() && file.length() > 1024 * 1024);
        result.put("path", file.exists() ? file.getAbsolutePath() : "");
        result.put("size", file.length());
        call.resolve(result);
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url", "");
        String fileName = call.getString("fileName", "freeseek-update");
        if (url.isEmpty()) {
            call.reject("empty url");
            return;
        }
        final PluginCall pending = call;
        final File target = apkFile(fileName);
        cancelled = false;

        // 已有完整包直接返回，避免重复下载
        if (target.exists() && target.length() > 1024 * 1024) {
            JSObject done = new JSObject();
            done.put("path", target.getAbsolutePath());
            done.put("size", target.length());
            done.put("cached", true);
            pending.resolve(done);
            return;
        }

        new Thread(() -> {
            HttpURLConnection connection = null;
            File temp = new File(target.getAbsolutePath() + ".part");
            try {
                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setInstanceFollowRedirects(true);
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(60000);
                connection.setRequestProperty("User-Agent", "FreeSeek-Updater");
                connection.connect();
                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) {
                    throw new IllegalStateException("HTTP " + status);
                }
                long total = connection.getContentLengthLong();
                try (InputStream in = connection.getInputStream();
                     FileOutputStream out = new FileOutputStream(temp)) {
                    byte[] buffer = new byte[64 * 1024];
                    long received = 0;
                    long last = 0;
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        if (cancelled) {
                            throw new IllegalStateException("cancelled");
                        }
                        out.write(buffer, 0, read);
                        received += read;
                        if (received - last > 256 * 1024) {
                            last = received;
                            JSObject progress = new JSObject();
                            progress.put("received", received);
                            progress.put("total", total);
                            notifyListeners("progress", progress);
                        }
                    }
                }
                if (target.exists() && !target.delete()) {
                    throw new IllegalStateException("cannot replace file");
                }
                if (!temp.renameTo(target)) {
                    throw new IllegalStateException("rename failed");
                }
                JSObject done = new JSObject();
                done.put("path", target.getAbsolutePath());
                done.put("size", target.length());
                pending.resolve(done);
            } catch (Exception error) {
                //noinspection ResultOfMethodCallIgnored
                temp.delete();
                pending.reject(error.getMessage() == null ? "download failed" : error.getMessage());
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }
        }).start();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        cancelled = true;
        call.resolve();
    }

    /** 拉起系统安装器；未授权「安装未知应用」时先把用户带到授权页 */
    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path", "");
        File file = path.isEmpty() ? null : new File(path);
        if (file == null || !file.exists()) {
            call.reject("file not found");
            return;
        }
        Context context = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && !context.getPackageManager().canRequestPackageInstalls()) {
            try {
                Intent settings = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + context.getPackageName())
                );
                settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(settings);
                JSObject result = new JSObject();
                result.put("installed", false);
                result.put("reason", "permission");
                call.resolve(result);
                return;
            } catch (Exception ignored) {
                // 打不开授权页就继续尝试直接安装
            }
        }
        try {
            Uri uri = FileProvider.getUriForFile(
                context,
                context.getPackageName() + ".fileprovider",
                file
            );
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            context.startActivity(intent);
            JSObject result = new JSObject();
            result.put("installed", true);
            call.resolve(result);
        } catch (Exception error) {
            JSObject result = new JSObject();
            result.put("installed", false);
            result.put("reason", error.getMessage() == null ? "error" : error.getMessage());
            call.resolve(result);
        }
    }

    /** 系统下载器兜底：交给 DownloadManager（部分机型对自建下载有限制） */
    @PluginMethod
    public void enqueueSystemDownload(PluginCall call) {
        String url = call.getString("url", "");
        String fileName = call.getString("fileName", "freeseek-update.apk");
        if (url.isEmpty()) {
            call.reject("empty url");
            return;
        }
        try {
            DownloadManager manager =
                (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setMimeType("application/vnd.android.package-archive");
            request.setTitle("FreeSeek 更新");
            request.setNotificationVisibility(
                DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
            );
            request.setDestinationInExternalFilesDir(getContext(), DIR, fileName);
            manager.enqueue(request);
            JSObject result = new JSObject();
            result.put("enqueued", true);
            call.resolve(result);
        } catch (Exception error) {
            JSObject result = new JSObject();
            result.put("enqueued", false);
            result.put("reason", error.getMessage() == null ? "error" : error.getMessage());
            call.resolve(result);
        }
    }
}
