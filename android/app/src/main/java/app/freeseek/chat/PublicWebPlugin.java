package app.freeseek.chat;

import android.os.SystemClock;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.net.InetAddress;
import java.net.Proxy;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import okhttp3.Call;
import okhttp3.Dns;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "PublicWeb")
public class PublicWebPlugin extends Plugin {
    private static final int MAX_BYTES = 1024 * 1024;
    private static final int MAX_REDIRECTS = 4;
    private static final int MAX_TIMEOUT_MS = 15000;
    private static final Pattern HOST = Pattern.compile(
        "(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z][a-z0-9-]*", Pattern.CASE_INSENSITIVE);
    private static final Pattern LOCAL = Pattern.compile(
        ".*\\.(?:localhost|local|lan|internal|home\\.arpa|onion)", Pattern.CASE_INSENSITIVE);
    private static final Pattern CREDENTIAL = Pattern.compile(
        "(?:access[-_]?token|auth(?:orization)?|api[-_]?key|key|token|session(?:id)?|signature|sig|password|x-amz-.+|x-goog-.+)",
        Pattern.CASE_INSENSITIVE);
    private static final Pattern TEXT = Pattern.compile(
        "(?:text/[^;]+|application/(?:[\\w.-]+\\+)?(?:json|xml|xhtml\\+xml|x-yaml|yaml|javascript))(?:;.*)?",
        Pattern.CASE_INSENSITIVE);
    private final Semaphore permits = new Semaphore(4);
    private final ExecutorService io = Executors.newFixedThreadPool(4);
    private final ConcurrentHashMap<String, Transfer> active = new ConcurrentHashMap<>();
    private static final class Client {
        static final OkHttpClient reader = new OkHttpClient.Builder()
            .proxy(Proxy.NO_PROXY)
            .dns(PublicWebPlugin::publicAddresses)
            .protocols(Collections.singletonList(Protocol.HTTP_1_1))
            .followRedirects(false)
            .followSslRedirects(false)
            .connectTimeout(8, TimeUnit.SECONDS)
            .build();
    }

    private static final class PublicDns {
        static final OkHttpClient client = new OkHttpClient.Builder()
            .proxy(Proxy.NO_PROXY).followRedirects(false).followSslRedirects(false)
            .callTimeout(4500, TimeUnit.MILLISECONDS).build();
    }

    static final class Transfer {
        volatile Call request;
        volatile boolean cancelled;

        void cancel() {
            cancelled = true;
            Call current = request;
            if (current != null) current.cancel();
        }
    }

    private static final class ReadFailure extends IOException {
        final String code;

        ReadFailure(String code) {
            super(code);
            this.code = code;
        }
    }

    // Restrict name resolution to routable addresses before OkHttp opens the socket.
    private static boolean isPublic(InetAddress address) {
        byte[] bytes = address.getAddress();
        int a = bytes[0] & 255, b = bytes[1] & 255, c = bytes[2] & 255, d = bytes[3] & 255;
        if (bytes.length == 4) {
            return !(a == 0 || a == 10 || a == 127 || a >= 224 ||
                (a == 100 && b >= 64 && b <= 127) ||
                (a == 169 && b == 254) ||
                (a == 172 && b >= 16 && b <= 31) ||
                (a == 192 && (b == 168 || (b == 0 && (c == 0 || c == 2)) || (b == 88 && c == 99))) ||
                (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100))) ||
                (a == 203 && b == 0 && c == 113));
        }
        return (a & 224) == 32 &&
            !(a == 0x20 && (b == 2 || (b == 1 && (c < 2 || (c == 0xdb && d == 8))))) &&
            !(a == 0x3f && b == 0xff && c < 16);
    }

    private static List<InetAddress> publicAddresses(String host) throws UnknownHostException {
        List<InetAddress> answers = Dns.SYSTEM.lookup(host);
        List<InetAddress> addresses = new ArrayList<>();
        boolean synthetic = !answers.isEmpty();
        for (InetAddress address : answers) {
            if (isPublic(address)) addresses.add(address);
            byte[] raw = address.getAddress();
            synthetic &= raw.length == 4 && (raw[0] & 255) == 198 && (raw[1] == 18 || raw[1] == 19);
        }
        if (addresses.isEmpty() && synthetic) return resolvePublicV4(host);
        if (addresses.isEmpty()) throw new UnknownHostException("blocked");
        return addresses;
    }

    // A VPN may assign synthetic addresses. Ask a public DNS resolver for real A records
    // only in that case, and never let the connection use reserved addresses.
    private static List<InetAddress> resolvePublicV4(String host) throws UnknownHostException {
        HttpUrl url = HttpUrl.get("https://1.1.1.1/dns-query").newBuilder()
            .addQueryParameter("name", host).addQueryParameter("type", "A").build();
        Request request = new Request.Builder().url(url)
            .header("Accept", "application/dns-json").header("Accept-Encoding", "identity").build();
        try (Response response = PublicDns.client.newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null) throw new IOException("dns");
            var source = response.body().source();
            if (source.request(32769L)) throw new IOException("dns");
            JSONObject data = new JSONObject(source.readUtf8());
            JSONArray records = data.optJSONArray("Answer");
            List<InetAddress> real = new ArrayList<>();
            if (data.optInt("Status", -1) == 0 && records != null) {
                for (int i = 0; i < records.length(); i++) {
                    JSONObject entry = records.getJSONObject(i);
                    String literal = entry.optString("data");
                    if (entry.optInt("type") != 1 || !literal.matches("(?:[0-9]{1,3}\\.){3}[0-9]{1,3}")) continue;
                    InetAddress address = InetAddress.getByName(literal);
                    if (address.getAddress().length == 4 && isPublic(address)) real.add(address);
                }
            }
            if (!real.isEmpty()) return real;
        } catch (Exception ignored) {
            // Preserve the address policy if the public resolver is inaccessible.
        }
        throw new UnknownHostException("dns");
    }

    private static HttpUrl validate(HttpUrl url) throws ReadFailure {
        if (url == null || !url.isHttps() || url.port() != 443 || url.toString().length() > 2048 ||
            !url.username().isEmpty() || !url.password().isEmpty() || url.host().length() > 253 ||
            !HOST.matcher(url.host()).matches() || LOCAL.matcher(url.host()).matches()) {
            throw new ReadFailure("blocked");
        }
        for (String name : url.queryParameterNames()) {
            if (CREDENTIAL.matcher(name).matches()) throw new ReadFailure("blocked");
        }
        return url.newBuilder().fragment(null).build();
    }

    private static boolean redirect(int status) {
        return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
    }

    private static void copyHeader(
        Response response, JSObject headers, String from, String to, int limit
    ) {
        String value = response.header(from);
        if (value != null) headers.put(to, value.substring(0, Math.min(value.length(), limit)));
    }

    static JSObject fetch(String url, boolean raw, boolean sameOrigin, long deadline, Transfer transfer) throws IOException {
        HttpUrl target = validate(HttpUrl.parse(url));
        String initialHost = target.host();
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            long remaining = deadline - SystemClock.elapsedRealtime();
            if (remaining <= 0) throw new ReadFailure("timeout");
            if (transfer.cancelled) throw new ReadFailure("cancelled");

            String accept = raw && target.host().equals("api.github.com")
                ? "application/vnd.github.raw+json"
                : "text/html, text/plain, application/json, application/xml;q=0.9, */*;q=0.1";
            Request request = new Request.Builder().url(target)
                .header("Accept", accept)
                .header("Accept-Encoding", "identity")
                .header("User-Agent", "FreeSeek-WebReader")
                .build();
            Call activeCall = Client.reader.newBuilder().callTimeout(remaining, TimeUnit.MILLISECONDS)
                .build().newCall(request);
            transfer.request = activeCall;
            if (transfer.cancelled) activeCall.cancel();
            try (Response response = activeCall.execute()) {
                int status = response.code();
                if (redirect(status)) {
                    String location = response.header("Location");
                    if (location == null || hop == MAX_REDIRECTS) throw new ReadFailure("redirect");
                    target = validate(target.resolve(location));
                    if (sameOrigin && !initialHost.equals(target.host())) throw new ReadFailure("blocked");
                    continue;
                }
                String type = response.header("Content-Type", "");
                JSObject result = new JSObject().put("url", target.toString()).put("status", status)
                    .put("contentType", type).put("redirects", hop);
                JSObject headers = new JSObject();
                copyHeader(response, headers, "Retry-After", "retryAfter", 96);
                if (target.host().equals("api.github.com")) {
                    copyHeader(response, headers, "Link", "link", 4096);
                    copyHeader(response, headers, "X-RateLimit-Remaining", "rateRemaining", 16);
                    copyHeader(response, headers, "X-RateLimit-Reset", "rateReset", 16);
                }
                result.put("headers", headers);
                if (!response.isSuccessful()) return result;
                String encoding = response.header("Content-Encoding", "identity");
                if (!TEXT.matcher(type).matches() || !encoding.equalsIgnoreCase("identity") ||
                    response.body() == null) return result.put("error", "unsupported");

                try (InputStream input = response.body().byteStream()) {
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    byte[] buffer = new byte[8192];
                    boolean truncated = false;
                    for (int count; (count = input.read(buffer)) != -1; ) {
                        int accepted = Math.min(count, MAX_BYTES - bytes.size());
                        bytes.write(buffer, 0, accepted);
                        if (accepted < count) {
                            truncated = true;
                            break;
                        }
                        if (transfer.cancelled) throw new ReadFailure("cancelled");
                    }
                    return result.put("bytes", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP))
                        .put("receivedBytes", bytes.size()).put("truncated", truncated);
                }
            }
        }
        throw new ReadFailure("redirect");
    }

    static String fetchError(Transfer transfer, Exception error) {
        return transfer.cancelled ? "cancelled"
            : error instanceof ReadFailure ? ((ReadFailure) error).code
            : error instanceof InterruptedIOException ? "timeout"
            : error instanceof UnknownHostException ? ("blocked".equals(error.getMessage()) ? "blocked" : "dns")
            : "network";
    }

    @PluginMethod
    public void read(PluginCall call) {
        String id = call.getString("id", "");
        int timeout = Math.min(MAX_TIMEOUT_MS, call.getInt("timeoutMs", MAX_TIMEOUT_MS));
        if (!id.matches("[a-zA-Z0-9_-]{1,80}") || timeout <= 0 || !permits.tryAcquire()) {
            call.resolve(new JSObject().put("error", "blocked"));
            return;
        }
        Transfer transfer = new Transfer();
        if (active.putIfAbsent(id, transfer) != null) {
            permits.release();
            call.resolve(new JSObject().put("error", "blocked"));
            return;
        }
        long started = SystemClock.elapsedRealtime();
        io.execute(() -> {
            DiagnosticsLog.record(getContext(), "chat", "task.web.native-started",
                new JSObject().put("requestId", id).put("timeoutMs", timeout));
            JSObject result;
            try {
                result = fetch(call.getString("url", ""), call.getBoolean("raw", false),
                    call.getBoolean("sameOrigin", false),
                    started + timeout, transfer);
            } catch (IOException | IllegalArgumentException error) {
                String code = fetchError(transfer, error);
                result = new JSObject().put("error", code);
            } finally {
                active.remove(id, transfer);
                permits.release();
            }
            JSObject evidence = new JSObject()
                .put("requestId", id)
                .put("elapsedMs", SystemClock.elapsedRealtime() - started)
                .put("httpStatus", result.optInt("status"))
                .put("receivedBytes", result.optInt("receivedBytes"))
                .put("reason", result.optString("error", ""))
                .put("truncated", result.optBoolean("truncated"));
            if (result.optInt("status") >= 400 || result.has("error")) {
                DiagnosticsLog.warn(getContext(), "chat", "task.web.native-failed", evidence);
            } else {
                DiagnosticsLog.record(getContext(), "chat", "task.web.native-finished", evidence);
            }
            call.resolve(result);
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Transfer transfer = active.get(call.getString("id", ""));
        if (transfer != null) transfer.cancel();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (Transfer transfer : active.values()) transfer.cancel();
        io.shutdown();
    }
}
