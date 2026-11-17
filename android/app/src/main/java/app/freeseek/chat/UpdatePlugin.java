package app.freeseek.chat;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.android.apksig.ApkVerifier;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.Arrays;

/** 所有缓存、下载和安装均核验长度、摘要、APK 签名、应用身份与版本。 */
@CapacitorPlugin(name = "Update")
public class UpdatePlugin extends Plugin {
    private static final String REPO = "WikG1018/FreeSeekApp";
    private static final String[] MIRRORS = {"https://gh-proxy.com/", "https://ghfast.top/", "https://ghproxy.net/"};
    private volatile boolean cancelled = false;

    private File updateDir() throws Exception {
        // Android 7–9 的外部应用目录可被持有存储权限的其他应用修改，安装包须放内部私有目录。
        File dir = new File(getContext().getFilesDir(), "updates");
        if (!dir.isDirectory() && !dir.mkdirs()) { throw new IllegalStateException("cannot create update directory"); }
        return dir;
    }
    private File apkFile(String name) throws Exception {
        if (!name.matches("freeseek-[0-9]+\\.[0-9]+\\.[0-9]+\\.apk")) {
            throw new IllegalArgumentException("invalid package name");
        }
        return new File(updateDir(), name);
    }
    private URL allowedUrl(String value, boolean metadata) throws Exception {
        String direct = value;
        for (String mirror : MIRRORS) {
            if (direct.startsWith(mirror)) { direct = direct.substring(mirror.length()); break; }
        }
        URL url = new URL(direct);
        if (!"https".equals(url.getProtocol()) || url.getUserInfo() != null ||
            url.getPort() != -1 || url.getQuery() != null || url.getRef() != null) {
            throw new IllegalArgumentException("invalid update URL");
        }
        boolean allowed = metadata
            ? direct.equals("https://api.github.com/repos/" + REPO + "/releases/latest")
            : url.getHost().equals("github.com") && url.getPath().matches(
                "/" + REPO + "/releases/download/v[0-9]+\\.[0-9]+\\.[0-9]+/freeseek-v[0-9]+\\.[0-9]+\\.[0-9]+-release\\.apk");
        if (!allowed) { throw new IllegalArgumentException("untrusted update URL"); }
        return new URL(value);
    }
    private HttpURLConnection connect(URL url, int timeout) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(timeout); connection.setReadTimeout(timeout);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestProperty("User-Agent", "FreeSeek-Updater");
        return connection;
    }
    private long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }
    private void verify(File file, PluginCall call) throws Exception {
        double expected = call.getDouble("expectedSize", -1.0);
        if (!Double.isFinite(expected) || expected <= 0 || expected > 512L * 1024 * 1024 ||
            expected != Math.floor(expected) || !file.isFile() || file.length() != (long) expected) {
            throw new IllegalStateException("package size mismatch: expected " + expected +
                ", actual " + file.length() + ", exists " + file.exists() + ", path " + file.getAbsolutePath());
        }
        String expectedHash = call.getString("sha256");
        if (expectedHash != null && !expectedHash.matches("[a-fA-F0-9]{64}")) {
            throw new IllegalArgumentException("invalid package digest");
        }
        if (expectedHash != null) {
            MessageDigest hash = MessageDigest.getInstance("SHA-256");
            try (InputStream in = new FileInputStream(file)) {
                byte[] buffer = new byte[64 * 1024]; int read;
                while ((read = in.read(buffer)) != -1) { hash.update(buffer, 0, read); }
            }
            StringBuilder actual = new StringBuilder();
            for (byte b : hash.digest()) { actual.append(String.format("%02x", b & 0xff)); }
            if (!actual.toString().equalsIgnoreCase(expectedHash)) { throw new IllegalStateException("package digest mismatch"); }
        }
        ApkVerifier.Result signature = new ApkVerifier.Builder(file)
            .setMinCheckedPlatformVersion(Build.VERSION.SDK_INT).build().verify();
        if (!signature.isVerified()) { throw new IllegalStateException("APK signature is invalid: " + signature.getErrors()); }
        PackageManager manager = getContext().getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo current = manager.getPackageInfo(getContext().getPackageName(), flags);
        PackageInfo candidate = manager.getPackageArchiveInfo(file.getAbsolutePath(), 0);
        if (candidate == null || !current.packageName.equals(candidate.packageName) ||
            versionCode(candidate) <= versionCode(current) ||
            !call.getString("version", "").equals(candidate.versionName)) {
            throw new IllegalStateException("package identity or version mismatch");
        }
        Signature[] installed = Build.VERSION.SDK_INT >= 28
            ? current.signingInfo.getApkContentsSigners() : current.signatures;
        if (signature.getSignerCertificates().size() != installed.length) {
            throw new IllegalStateException("package signer mismatch");
        }
        for (X509Certificate cert : signature.getSignerCertificates()) {
            boolean match = false;
            for (Signature signer : installed) { match |= Arrays.equals(cert.getEncoded(), signer.toByteArray()); }
            if (!match) { throw new IllegalStateException("package signer mismatch"); }
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                connection = connect(allowedUrl(call.getString("url", ""), true),
                    Math.max(1000, Math.min(30000, call.getInt("timeoutMs", 8000))));
                connection.setRequestProperty("Accept", "application/vnd.github+json");
                int status = connection.getResponseCode();
                try (InputStream in = status >= 400 ? connection.getErrorStream() : connection.getInputStream()) {
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    if (in != null) {
                        byte[] buffer = new byte[16 * 1024]; int read;
                        while ((read = in.read(buffer)) != -1) {
                            if (bytes.size() + read > 2_000_000) { throw new IllegalStateException("response too large"); }
                            bytes.write(buffer, 0, read);
                        }
                    }
                    JSObject result = new JSObject(); result.put("status", status);
                    result.put("body", bytes.toString(StandardCharsets.UTF_8.name())); call.resolve(result);
                }
            } catch (Exception error) { call.reject("update request failed", error); }
            finally { if (connection != null) { connection.disconnect(); } }
        }).start();
    }

    @PluginMethod
    public void hasFile(PluginCall call) {
        new Thread(() -> {
            try {
                File file = apkFile(call.getString("fileName", ""));
                boolean exists = false;
                String reason = "";
                try { verify(file, call); exists = true; }
                catch (Exception invalid) { reason = invalid.toString(); if (file.exists()) { file.delete(); } }
                JSObject result = new JSObject(); result.put("exists", exists);
                result.put("reason", reason);
                result.put("path", exists ? file.getAbsolutePath() : ""); result.put("size", exists ? file.length() : 0);
                call.resolve(result);
            } catch (Exception error) { call.reject("invalid update cache", error); }
        }).start();
    }

    @PluginMethod
    public void download(PluginCall call) {
        cancelled = false;
        new Thread(() -> {
            HttpURLConnection connection = null;
            File temp = null;
            try {
                File target = apkFile(call.getString("fileName", ""));
                URL url = allowedUrl(call.getString("url", ""), false);
                if (target.exists()) {
                    try {
                        verify(target, call);
                        JSObject cached = new JSObject(); cached.put("path", target.getAbsolutePath());
                        cached.put("size", target.length()); cached.put("cached", true); call.resolve(cached); return;
                    } catch (Exception invalid) { target.delete(); }
                }
                temp = new File(target.getAbsolutePath() + ".part");
                connection = connect(url, 60000);
                connection.setConnectTimeout(15000);
                int status = connection.getResponseCode();
                if (status != 200 || !"https".equals(connection.getURL().getProtocol())) {
                    throw new IllegalStateException("download HTTP " + status);
                }
                long expected = call.getDouble("expectedSize", -1.0).longValue();
                long headerSize = connection.getContentLengthLong();
                if (headerSize > 0 && headerSize != expected) { throw new IllegalStateException("download size mismatch"); }
                try (InputStream in = connection.getInputStream(); FileOutputStream out = new FileOutputStream(temp)) {
                    byte[] buffer = new byte[64 * 1024]; long received = 0, last = 0; int read;
                    while ((read = in.read(buffer)) != -1) {
                        if (cancelled || received + read > expected) { throw new IllegalStateException("download cancelled or too large"); }
                        out.write(buffer, 0, read); received += read;
                        if (received - last > 256 * 1024) {
                            JSObject progress = new JSObject(); progress.put("received", received); progress.put("total", expected);
                            notifyListeners("progress", progress); last = received;
                        }
                    }
                    out.getFD().sync();
                }
                verify(temp, call);
                if (!temp.renameTo(target)) { throw new IllegalStateException("cannot publish verified package"); }
                JSObject result = new JSObject(); result.put("path", target.getAbsolutePath()); result.put("size", target.length());
                call.resolve(result);
            } catch (Exception error) {
                if (temp != null) { temp.delete(); }
                call.reject("package download or verification failed", error);
            } finally { if (connection != null) { connection.disconnect(); } }
        }).start();
    }

    @PluginMethod
    public void cancel(PluginCall call) { cancelled = true; call.resolve(); }

    @PluginMethod
    public void install(PluginCall call) {
        new Thread(() -> {
            try {
                File file = new File(call.getString("path", ""));
                if (!file.getCanonicalFile().getParentFile().equals(updateDir().getCanonicalFile())) {
                    throw new IllegalArgumentException("invalid installation path");
                }
                verify(file, call);
                Context context = getContext();
                if (Build.VERSION.SDK_INT >= 26 && !context.getPackageManager().canRequestPackageInstalls()) {
                    Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + context.getPackageName()));
                    settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); context.startActivity(settings);
                    JSObject result = new JSObject(); result.put("installed", false); result.put("reason", "permission");
                    call.resolve(result); return;
                }
                Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
                Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                context.startActivity(intent);
                JSObject result = new JSObject(); result.put("installed", true); call.resolve(result);
            } catch (Exception error) {
                JSObject result = new JSObject(); result.put("installed", false); result.put("reason", "verification-or-install-failed");
                call.resolve(result);
            }
        }).start();
    }
}
