package app.freeseek.chat;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
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
import java.io.IOException;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** 所有缓存、下载和安装均核验长度、摘要、APK 签名、应用身份与版本。 */
@CapacitorPlugin(name = "Update")
public class UpdatePlugin extends Plugin {
    private static final String REPO = "WikG1018/FreeSeekApp";
    private static final String[] MIRRORS = {"https://gh-proxy.com/", "https://ghfast.top/", "https://ghproxy.net/"};
    private static final String CACHE_DIR = "updates";
    private static final String VERSION = "[0-9]+\\.[0-9]+\\.[0-9]+";
    private static final Pattern CACHED_PACKAGE = Pattern.compile(
        "freeseek-(" + VERSION + ")\\.apk(?:(?:\\.([a-f0-9]{64}))?(\\.part))?");
    private static final Pattern CONTENT_RANGE = Pattern.compile(
        "bytes ([0-9]+)-([0-9]+)/([0-9]+)", Pattern.CASE_INSENSITIVE);
    private static final ExecutorService PROBES = Executors.newFixedThreadPool(MIRRORS.length);
    private static final int SAMPLE_BYTES = 96 * 1024;
    // File operations share a worker, including across overlapping Capacitor activity instances.
    private static final ExecutorService PACKAGES = Executors.newSingleThreadExecutor();
    private static final AtomicBoolean DOWNLOADING = new AtomicBoolean();
    private static String installerFile;
    private volatile boolean cancelled = false;
    private volatile HttpURLConnection activeDownload;
    private static final java.util.concurrent.ScheduledExecutorService DEADLINES =
        java.util.concurrent.Executors.newSingleThreadScheduledExecutor();

    private File updateDir() throws Exception {
        // Android 7–9 的外部应用目录可被持有存储权限的其他应用修改，安装包须放内部私有目录。
        File dir = new File(getContext().getFilesDir(), CACHE_DIR);
        if (!dir.isDirectory() && !dir.mkdirs()) { throw new IllegalStateException("cannot create update directory"); }
        return dir;
    }
    private File apkFile(String name) throws Exception {
        if (!name.matches("freeseek-" + VERSION + "\\.apk")) {
            throw new IllegalArgumentException("invalid package name");
        }
        return new File(updateDir(), name);
    }

    @Override public void load() {
        Context context = getContext().getApplicationContext();
        PACKAGES.execute(() -> {
            try {
                String installed = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
                pruneCache(new File(context.getFilesDir(), CACHE_DIR), installed, null, false);
            } catch (PackageManager.NameNotFoundException error) {
                DiagnosticsLog.error(context, "update", "cache.cleanup-failed", error);
            }
        });
    }

    private static int compareVersions(String first, String second) {
        String[] left = first.split("\\.");
        String[] right = second.split("\\.");
        for (int i = 0; i < left.length; i++) {
            int order = new BigInteger(left[i]).compareTo(new BigInteger(right[i]));
            if (order != 0) return order;
        }
        return 0;
    }

    private void pruneCache(File dir, String throughVersion, String keepName, boolean onlyPartials) {
        try {
            File[] entries = dir.listFiles();
            if (entries == null) return;
            boolean hasVersion = throughVersion != null && throughVersion.matches(VERSION);
            int removed = 0, failed = 0;
            long removedBytes = 0;
            for (File entry : entries) {
                String name = entry.getName();
                Matcher match = CACHED_PACKAGE.matcher(name);
                if (!match.matches() || !entry.isFile() || name.equals(keepName) || name.equals(installerFile)) {
                    continue;
                }
                boolean partial = match.group(3) != null;
                if (onlyPartials && !partial) continue;
                boolean legacyPartial = partial && match.group(2) == null;
                if (!legacyPartial && (!hasVersion || compareVersions(match.group(1), throughVersion) > 0)) continue;
                long bytes = entry.length();
                if (entry.delete()) {
                    removed++;
                    removedBytes += bytes;
                } else {
                    failed++;
                }
            }
            if (removed > 0 || failed > 0) {
                DiagnosticsLog.record(getContext(), "update", "cache.cleaned", new JSObject()
                    .put("removed", removed).put("failed", failed).put("bytes", removedBytes));
            }
        } catch (SecurityException error) {
            DiagnosticsLog.error(getContext(), "update", "cache.cleanup-failed", error);
        }
    }

    private URL metadataUrl(String value) throws Exception {
        String direct = value;
        for (String mirror : MIRRORS) {
            if (direct.startsWith(mirror)) { direct = direct.substring(mirror.length()); break; }
        }
        URL url = new URL(direct);
        boolean history = direct.matches(
            "https://api\\.github\\.com/repos/" + REPO + "/releases\\?per_page=30&page=([1-9]|10)");
        if (!"https".equals(url.getProtocol()) || url.getUserInfo() != null ||
            url.getPort() != -1 || (url.getQuery() != null && !history) || url.getRef() != null) {
            throw new IllegalArgumentException("invalid update URL");
        }
        if (!history && !direct.equals("https://api.github.com/repos/" + REPO + "/releases/latest") &&
            !direct.equals("https://github.com/" + REPO + "/releases/latest/download/update.json")) {
            throw new IllegalArgumentException("untrusted update URL");
        }
        return new URL(value);
    }
    private HttpURLConnection connect(URL url, int timeout) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(timeout); connection.setReadTimeout(timeout);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestProperty("User-Agent", "FreeSeek-Updater");
        return connection;
    }
    private URL assetUrl(PluginCall call) throws Exception {
        String version = call.getString("version", "");
        if (!version.matches(VERSION)) throw new IllegalArgumentException("invalid package version");
        String direct = "https://github.com/" + REPO + "/releases/download/v" + version +
            "/freeseek-v" + version + "-release.apk";
        String value = call.getString("url", "");
        if (value.equals(direct)) return new URL(value);
        for (String mirror : MIRRORS) {
            if (value.equals(mirror + direct)) return new URL(value);
        }
        throw new IllegalArgumentException("untrusted update package URL");
    }

    private boolean allowedAssetRedirect(URL initial, URL next) {
        String host = next.getHost();
        return "https".equals(next.getProtocol()) && next.getPort() == -1 && next.getUserInfo() == null &&
            (initial.getHost().equals(host) || host.equals("github.com") ||
                host.equals("release-assets.githubusercontent.com") || host.equals("objects.githubusercontent.com"));
    }

    private HttpURLConnection openAsset(URL initial, String range, int timeout, boolean download) throws Exception {
        long endsAt = SystemClock.elapsedRealtime() + timeout;
        URL url = initial;
        for (int hops = 0; hops <= 5; hops++) {
            int remaining = (int) (endsAt - SystemClock.elapsedRealtime());
            if (remaining <= 0) throw new SocketTimeoutException("update connection timed out");
            HttpURLConnection connection = connect(url, remaining);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept-Encoding", "identity");
            if (range != null) connection.setRequestProperty("Range", range);
            if (download) activeDownload = connection;
            boolean done = false;
            try {
                if (download && cancelled) throw new IOException("download cancelled");
                int status = connection.getResponseCode();
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    String location = connection.getHeaderField("Location");
                    if (location == null) throw new IOException("invalid update redirect");
                    url = new URL(url, location);
                    if (!allowedAssetRedirect(initial, url)) throw new IOException("untrusted update redirect");
                } else {
                    done = true;
                    return connection;
                }
            } finally {
                if (!done) connection.disconnect();
            }
        }
        throw new IOException("too many update redirects");
    }

    // A partial response must describe the same package and start at the byte we requested.
    static boolean validRange(String header, long length, long offset, long end, long expected) {
        Matcher match = CONTENT_RANGE.matcher(header == null ? "" : header);
        if (!match.matches()) return false;
        try {
            long last = Long.parseLong(match.group(2));
            return Long.parseLong(match.group(1)) == offset &&
                (last == end || last == expected - 1) &&
                Long.parseLong(match.group(3)) == expected &&
                (length == -1 || length == last - offset + 1);
        } catch (NumberFormatException invalid) {
            return false;
        }
    }

    private boolean packageResponse(HttpURLConnection connection, long offset, long end, long expected) throws Exception {
        String contentType = connection.getContentType();
        String encoding = connection.getContentEncoding();
        if ((contentType != null && contentType.toLowerCase(Locale.ROOT).startsWith("text/html")) ||
            (encoding != null && !encoding.equalsIgnoreCase("identity"))) {
            throw new IOException("unexpected package response");
        }
        int status = connection.getResponseCode();
        long length = connection.getContentLengthLong();
        if (status == 206) {
            if (!validRange(connection.getHeaderField("Content-Range"), length, offset, end, expected)) {
                throw new IOException("package range mismatch");
            }
            return true;
        }
        if (status != 200) throw new IOException("download HTTP " + status);
        if (length != -1 && length != expected) throw new IOException("download size mismatch");
        return false;
    }

    private long expectedLength(PluginCall call) {
        double length = call.getDouble("expectedSize", -1.0);
        if (!Double.isFinite(length) || length <= 0 || length > 512L * 1024 * 1024 ||
            length != Math.floor(length)) {
            throw new IllegalArgumentException("invalid package size");
        }
        return (long) length;
    }

    private String expectedHash(PluginCall call) {
        String hash = call.getString("sha256");
        if (hash != null && !hash.matches("[a-fA-F0-9]{64}")) {
            throw new IllegalArgumentException("invalid package digest");
        }
        return hash == null ? null : hash.toLowerCase(Locale.ROOT);
    }

    private File checkedApkFile(PluginCall call) throws Exception {
        String name = call.getString("fileName", "");
        if (!name.equals("freeseek-" + call.getString("version", "") + ".apk")) {
            throw new IllegalArgumentException("package name or version mismatch");
        }
        return apkFile(name);
    }

    private File partialFile(File target, String hash) {
        return new File(target.getAbsolutePath() + (hash == null ? "" : "." + hash) + ".part");
    }

    private long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }
    private void verify(File file, PluginCall call) throws Exception {
        long expected = expectedLength(call);
        if (!file.isFile() || file.length() != expected) {
            throw new IllegalStateException("package size mismatch: expected " + expected + ", actual " + file.length());
        }
        String expectedHash = expectedHash(call);
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
        DiagnosticsLog.record(getContext(), "update", "metadata.started", new JSObject());
        new Thread(() -> {
            HttpURLConnection connection = null;
            java.util.concurrent.ScheduledFuture<?> deadline = null;
            try {
                int timeout = Math.max(1000, Math.min(30000, call.getInt("timeoutMs", 8000)));
                long endsAt = android.os.SystemClock.elapsedRealtime() + timeout;
                connection = connect(metadataUrl(call.getString("url", "")), timeout);
                final HttpURLConnection active = connection;
                deadline = DEADLINES.schedule(active::disconnect, timeout, java.util.concurrent.TimeUnit.MILLISECONDS);
                connection.setRequestProperty("Accept", "application/vnd.github+json");
                int status = connection.getResponseCode();
                if (!"https".equals(connection.getURL().getProtocol())) { throw new IllegalStateException("untrusted redirect"); }
                JSObject metadata = new JSObject(); metadata.put("status", status);
                metadata.put("source", connection.getURL().getHost());
                DiagnosticsLog.record(getContext(), "update", "metadata.response", metadata);
                try (InputStream in = status >= 400 ? connection.getErrorStream() : connection.getInputStream()) {
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    if (in != null) {
                        byte[] buffer = new byte[16 * 1024]; int read;
                        while (true) {
                            long remaining = endsAt - android.os.SystemClock.elapsedRealtime();
                            if (remaining <= 0) { throw new java.net.SocketTimeoutException("metadata timeout"); }
                            connection.setReadTimeout((int) remaining);
                            read = in.read(buffer);
                            if (read == -1) { break; }
                            if (bytes.size() + read > 2_000_000) { throw new IllegalStateException("response too large"); }
                            bytes.write(buffer, 0, read);
                        }
                    }
                    JSObject result = new JSObject(); result.put("status", status);
                    result.put("body", bytes.toString(StandardCharsets.UTF_8.name())); call.resolve(result);
                }
            } catch (Exception error) { DiagnosticsLog.error(getContext(), "update", "metadata.failed", error); call.reject("update request failed", error); }
            finally { if (deadline != null) { deadline.cancel(false); } if (connection != null) { connection.disconnect(); } }
        }).start();
    }

    @PluginMethod
    public void hasFile(PluginCall call) {
        PACKAGES.execute(() -> {
            try {
                File file = checkedApkFile(call);
                String hash = expectedHash(call);
                long expected = expectedLength(call);
                boolean exists = false;
                String reason = "";
                try { verify(file, call); exists = true; }
                catch (Exception invalid) { reason = invalid.toString(); if (file.exists()) {
                    DiagnosticsLog.error(getContext(), "update", "cache.rejected", invalid); file.delete();
                } }
                if (exists) pruneCache(file.getParentFile(), call.getString("version"), file.getName(), false);
                File partial = partialFile(file, hash);
                long downloaded = hash != null && partial.isFile() ? partial.length() : 0;
                JSObject result = new JSObject(); result.put("exists", exists);
                result.put("reason", reason);
                result.put("path", exists ? file.getAbsolutePath() : ""); result.put("size", exists ? file.length() : 0);
                result.put("partialBytes", !exists && downloaded <= expected ? downloaded : 0);
                call.resolve(result);
            } catch (Exception error) { call.reject("invalid update cache", error); }
        });
    }

    @PluginMethod
    public void probe(PluginCall call) {
        PROBES.execute(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = assetUrl(call);
                if ("github.com".equals(url.getHost())) throw new IllegalArgumentException("only mirrors are probed");
                long expected = expectedLength(call);
                double requested = call.getDouble("offset", -1.0);
                if (requested < 0 || requested >= expected || requested != Math.floor(requested)) {
                    throw new IllegalArgumentException("invalid probe offset");
                }
                long offset = (long) requested;
                int limit = (int) Math.min(SAMPLE_BYTES, expected - offset);
                long started = SystemClock.elapsedRealtime();
                long end = offset + limit - 1;
                connection = openAsset(url, "bytes=" + offset + "-" + end, 3500, false);
                boolean supportsRange = packageResponse(connection, offset, end, expected);
                int received = 0;
                try (InputStream in = connection.getInputStream()) {
                    byte[] buffer = new byte[16 * 1024];
                    while (received < limit) {
                        int remaining = (int) (3500 - (SystemClock.elapsedRealtime() - started));
                        if (remaining <= 0) break;
                        connection.setReadTimeout(remaining);
                        int read = in.read(buffer, 0, Math.min(buffer.length, limit - received));
                        if (read == -1) throw new IOException("mirror sample incomplete");
                        received += read;
                    }
                } catch (SocketTimeoutException timeout) {
                    if (received < Math.min(16 * 1024, limit)) throw timeout;
                }
                if (received < Math.min(16 * 1024, limit)) throw new IOException("mirror sample incomplete");
                long rate = received * 1000L / Math.max(1, SystemClock.elapsedRealtime() - started);
                call.resolve(new JSObject().put("supportsRange", supportsRange).put("bytesPerSecond", rate));
            } catch (Exception failure) {
                call.reject("mirror probe failed", failure);
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    @PluginMethod
    public void download(PluginCall call) {
        if (!DOWNLOADING.compareAndSet(false, true)) { call.reject("download already in progress"); return; }
        DiagnosticsLog.record(getContext(), "update", "download.started", new JSObject());
        cancelled = false;
        PACKAGES.execute(() -> {
            JSObject result = null;
            Exception failure = null;
            try {
                result = downloadPackage(call);
            } catch (Exception error) {
                DiagnosticsLog.error(getContext(), "update", "download.failed", error);
                failure = error;
            } finally {
                DOWNLOADING.set(false);
            }
            // JavaScript may already be trying the next mirror once this promise settles.
            if (failure != null) call.reject("package download or verification failed", failure);
            else call.resolve(result);
        });
    }

    private JSObject downloadPackage(PluginCall call) throws Exception {
        File target = checkedApkFile(call);
        URL url = assetUrl(call);
        String version = call.getString("version");
        long expected = expectedLength(call);
        String hash = expectedHash(call);
        if (target.exists()) {
            try {
                verify(target, call);
                pruneCache(target.getParentFile(), version, target.getName(), false);
                return new JSObject().put("path", target.getAbsolutePath())
                    .put("size", target.length()).put("cached", true);
            } catch (Exception invalid) {
                DiagnosticsLog.error(getContext(), "update", "cache.rejected", invalid);
                target.delete();
            }
        }

        File temporary = partialFile(target, hash);
        pruneCache(target.getParentFile(), version, temporary.getName(), true);
        try {
            long offset = hash != null ? temporary.length() : 0;
            if (offset > expected) {
                if (!temporary.delete()) throw new IOException("cannot discard oversized partial package");
                offset = 0;
            }
            if (offset == expected) {
                try {
                    verify(temporary, call);
                } catch (Exception invalid) {
                    DiagnosticsLog.error(getContext(), "update", "partial.rejected", invalid);
                    if (!temporary.delete()) throw invalid;
                    offset = 0;
                }
            }
            if (offset < expected) {
                boolean restart = call.getBoolean("allowRestart", false);
                JSObject result = transfer(call, url, temporary, restart ? 0 : offset, expected);
                if (result != null) return result;
                try {
                    verify(temporary, call);
                } catch (Exception invalid) {
                    DiagnosticsLog.error(getContext(), "update", "package.rejected", invalid);
                    if (temporary.delete() && offset > 0 && !restart) {
                        return new JSObject().put("restartRequired", true);
                    }
                    throw invalid;
                }
            }
            if (cancelled) throw new IOException("download cancelled");
            if (!temporary.renameTo(target)) throw new IOException("cannot publish verified package");
            DiagnosticsLog.record(getContext(), "update", "package.verified",
                new JSObject().put("bytes", target.length()).put("source", url.getHost()));
            pruneCache(target.getParentFile(), version, target.getName(), false);
            return new JSObject().put("path", target.getAbsolutePath()).put("size", target.length());
        } finally {
            if (hash == null) temporary.delete();
        }
    }

    private JSObject transfer(PluginCall call, URL url, File temporary, long offset, long expected) throws Exception {
        HttpURLConnection connection = null;
        ScheduledFuture<?> deadline = null;
        try {
            connection = openAsset(url, offset == 0 ? null : "bytes=" + offset + "-", 12000, true);
            final HttpURLConnection active = connection;
            deadline = DEADLINES.schedule(active::disconnect, 60, TimeUnit.MINUTES);
            connection.setReadTimeout(12000);
            int status = connection.getResponseCode();
            if (offset > 0 && (status == 200 || status == 416)) {
                return new JSObject().put("restartRequired", true);
            }
            boolean ranged = packageResponse(connection, offset, expected - 1, expected);
            boolean append = offset > 0 && ranged;
            long received = append ? offset : 0;
            notifyListeners("progress", new JSObject().put("received", received).put("total", expected));
            boolean stopIfSlow = call.getBoolean("stopIfSlow", false);
            try (InputStream in = connection.getInputStream();
                 FileOutputStream out = new FileOutputStream(temporary, append)) {
                byte[] buffer = new byte[64 * 1024];
                long windowStart = SystemClock.elapsedRealtime(), windowBytes = received, lastProgress = 0;
                int read;
                while ((read = in.read(buffer)) != -1) {
                    if (cancelled) throw new IOException("download cancelled");
                    if (received + read > expected) throw new IOException("download exceeds package size");
                    out.write(buffer, 0, read);
                    received += read;
                    long now = SystemClock.elapsedRealtime();
                    if (now - lastProgress >= 150) {
                        notifyListeners("progress", new JSObject().put("received", received).put("total", expected));
                        lastProgress = now;
                    }
                    long elapsed = now - windowStart;
                    if (stopIfSlow && elapsed >= 12000) {
                        long rate = (received - windowBytes) * 1000 / elapsed;
                        if (rate < 128 * 1024 && expected - received > rate * 30) {
                            return new JSObject().put("slow", true).put("bytesPerSecond", rate);
                        }
                        windowStart = now;
                        windowBytes = received;
                    }
                }
                if (received != expected) throw new IOException("package download incomplete");
                out.getFD().sync();
            }
            return null;
        } finally {
            if (deadline != null) deadline.cancel(false);
            if (connection != null) connection.disconnect();
            activeDownload = null;
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        cancelled = true;
        HttpURLConnection active = activeDownload;
        if (active != null) { new Thread(active::disconnect).start(); }
        call.resolve();
    }

    @PluginMethod
    public void install(PluginCall call) {
        DiagnosticsLog.record(getContext(), "update", "install.started", new JSObject());
        PACKAGES.execute(() -> {
            try {
                File file = new File(call.getString("path", ""));
                File target = apkFile("freeseek-" + call.getString("version", "") + ".apk");
                if (!file.equals(target) || !file.getCanonicalFile().getParentFile().equals(updateDir().getCanonicalFile())) {
                    throw new IllegalArgumentException("invalid installation path");
                }
                verify(file, call);
                Context context = getContext();
                if (Build.VERSION.SDK_INT >= 26 && !context.getPackageManager().canRequestPackageInstalls()) {
                    DiagnosticsLog.record(getContext(), "update", "install.permission-required", new JSObject());
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
                installerFile = file.getName();
                DiagnosticsLog.record(getContext(), "update", "installer.launched", new JSObject());
                JSObject result = new JSObject(); result.put("installed", true); call.resolve(result);
            } catch (Exception error) {
                DiagnosticsLog.error(getContext(), "update", "install.failed", error);
                JSObject result = new JSObject(); result.put("installed", false); result.put("reason", "verification-or-install-failed");
                call.resolve(result);
            }
        });
    }
}
