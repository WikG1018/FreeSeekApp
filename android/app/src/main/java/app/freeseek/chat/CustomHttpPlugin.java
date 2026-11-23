package app.freeseek.chat;

import android.os.Build;
import android.util.Base64;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/** 用户自行配置的 API。流式传输避免 CORS 限制；不记录 URL、请求头或正文。 */
@CapacitorPlugin(name = "CustomHttp", permissions = {
    @Permission(alias = "localNetwork", strings = { "android.permission.ACCESS_LOCAL_NETWORK" })
})
public class CustomHttpPlugin extends Plugin {
    private final ExecutorService io = Executors.newFixedThreadPool(4);
    private final ConcurrentHashMap<String, Transfer> transfers = new ConcurrentHashMap<>();
    private static class Transfer {
        volatile boolean cancelled;
        volatile HttpURLConnection connection;
        final Semaphore window = new Semaphore(4);
    }
    private void event(String id, String type, String data) {
        JSObject item = new JSObject(); item.put("id", id); item.put("type", type);
        if (data != null) item.put("data", data);
        notifyListeners("transfer", item);
    }
    private boolean localAddress(URL url) throws Exception {
        for (InetAddress address : InetAddress.getAllByName(url.getHost())) {
            byte[] bytes = address.getAddress();
            if (address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress() || address.isSiteLocalAddress() ||
                (bytes.length == 16 && (bytes[0] & 0xfe) == 0xfc)) return true;
        }
        return false;
    }
    @PluginMethod public void start(PluginCall call) {
        String id = call.getString("id", "");
        String correlation = call.getString("requestId", "");
        String requestId = correlation.matches("[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
            ? correlation : null;
        Transfer transfer = new Transfer();
        if (!id.matches("[A-Za-z0-9-]{1,100}") || transfers.size() >= 8 || transfers.putIfAbsent(id, transfer) != null) {
            call.reject("Invalid or busy request", "INVALID_REQUEST"); return;
        }
        io.execute(() -> {
            boolean started = false;
            long received = 0;
            try {
                URL url = new URL(call.getString("url", ""));
                if ((!url.getProtocol().equals("https") && !url.getProtocol().equals("http")) || url.getUserInfo() != null || url.getRef() != null) {
                    throw new IllegalArgumentException("Invalid API address");
                }
                if (Build.VERSION.SDK_INT >= 37 && localAddress(url) && getPermissionState("localNetwork") != PermissionState.GRANTED) {
                    DiagnosticsLog.warn(getContext(), "api", "local-network.permission-required",
                        new JSObject().put("requestId", requestId));
                    call.reject("Local network permission required", "LOCAL_NETWORK_PERMISSION"); return;
                }
                String method = call.getString("method", "GET");
                if (!method.equals("GET") && !method.equals("POST")) throw new IllegalArgumentException("Invalid method");
                byte[] body = call.getString("body", "").getBytes(StandardCharsets.UTF_8);
                if (body.length > 32 * 1024 * 1024) throw new IllegalArgumentException("Request too large");
                if (transfer.cancelled) throw new InterruptedIOException();
                HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                transfer.connection = connection;
                connection.setRequestMethod(method); connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(20000); connection.setReadTimeout(120000);
                connection.setUseCaches(false); connection.setRequestProperty("Accept-Encoding", "identity");
                JSObject headers = call.getObject("headers", new JSObject());
                for (Iterator<String> keys = headers.keys(); keys.hasNext();) {
                    String name = keys.next(), value = headers.getString(name);
                    if (!name.matches("[!#$%&'*+.^_`|~0-9A-Za-z-]+") || value == null || value.contains("\r") || value.contains("\n") ||
                        Arrays.asList("host", "content-length", "connection", "transfer-encoding", "cookie", "origin").contains(name.toLowerCase(Locale.ROOT))) {
                        throw new IllegalArgumentException("Invalid header");
                    }
                    connection.setRequestProperty(name, value);
                }
                if (method.equals("POST")) {
                    connection.setDoOutput(true); connection.setFixedLengthStreamingMode(body.length);
                    try (OutputStream out = connection.getOutputStream()) {
                        for (int offset = 0; offset < body.length; offset += 16384) {
                            if (transfer.cancelled) throw new InterruptedIOException();
                            out.write(body, offset, Math.min(16384, body.length - offset));
                        }
                    }
                }
                int status = connection.getResponseCode();
                if (transfer.cancelled) throw new InterruptedIOException();
                JSObject result = new JSObject(); result.put("status", status);
                result.put("contentType", connection.getContentType() == null ? "" : connection.getContentType());
                String mcp = connection.getHeaderField("Mcp-Session-Id");
                if (mcp != null && mcp.matches("[!-~]{1,256}")) result.put("mcpSessionId", mcp);
                call.resolve(result); started = true;
                JSObject meta = new JSObject().put("status", status).put("method", method).put("requestId", requestId);
                DiagnosticsLog.record(getContext(), "api", "custom.response", meta);
                InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                String encoding = connection.getContentEncoding();
                if (input != null && "gzip".equalsIgnoreCase(encoding)) input = new java.util.zip.GZIPInputStream(input);
                else if (input != null && "deflate".equalsIgnoreCase(encoding)) input = new java.util.zip.InflaterInputStream(input);
                if (input != null) try (InputStream in = input) {
                    byte[] buffer = new byte[16384];
                    for (;;) {
                        if (transfer.cancelled || !transfer.window.tryAcquire(120, TimeUnit.SECONDS)) throw new InterruptedIOException();
                        int count = in.read(buffer);
                        if (count == -1) break;
                        received += count;
                        if (received > 64L * 1024 * 1024) throw new IOException("Response too large");
                        event(id, "chunk", Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP));
                    }
                }
                if (!transfer.cancelled) {
                    DiagnosticsLog.record(getContext(), "api", "custom.body-completed",
                        new JSObject().put("requestId", requestId).put("receivedBytes", received));
                    event(id, "end", null);
                }
            } catch (Exception error) {
                String code = transfer.cancelled ? "CANCELLED" : error instanceof SocketTimeoutException ? "TIMEOUT" : "NETWORK_ERROR";
                JSObject meta = new JSObject().put("requestId", requestId)
                    .put("stage", started ? "response-body" : "headers")
                    .put("receivedBytes", received).put("code", code);
                if (transfer.cancelled) {
                    DiagnosticsLog.record(getContext(), "api", "custom.cancelled", meta);
                } else {
                    DiagnosticsLog.warn(getContext(), "api", "custom.failed", meta);
                }
                if (started) event(id, "error", code); else call.reject(code, code);
            } finally {
                transfers.remove(id, transfer);
                if (transfer.connection != null) transfer.connection.disconnect();
            }
        });
    }
    @PluginMethod public void ack(PluginCall call) {
        Transfer transfer = transfers.get(call.getString("id", ""));
        if (transfer != null && transfer.window.availablePermits() < 4) transfer.window.release();
        call.resolve();
    }
    @PluginMethod public void cancel(PluginCall call) {
        Transfer transfer = transfers.get(call.getString("id", ""));
        if (transfer != null) {
            transfer.cancelled = true; transfer.window.release(4);
            HttpURLConnection connection = transfer.connection;
            if (connection != null) new Thread(connection::disconnect, "freeseek-api-cancel").start();
        }
        call.resolve();
    }
    @PluginMethod public void requestLocalNetwork(PluginCall call) {
        if (Build.VERSION.SDK_INT < 37 || getPermissionState("localNetwork") == PermissionState.GRANTED) { permissionResult(call); return; }
        requestPermissionForAlias("localNetwork", call, "permissionResult");
    }
    @PermissionCallback private void permissionResult(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", Build.VERSION.SDK_INT < 37 || getPermissionState("localNetwork") == PermissionState.GRANTED);
        DiagnosticsLog.record(getContext(), "api", "local-network.permission-result", result);
        call.resolve(result);
    }
    @Override protected void handleOnDestroy() {
        for (Transfer transfer : transfers.values()) {
            transfer.cancelled = true; transfer.window.release(4);
            if (transfer.connection != null) new Thread(transfer.connection::disconnect, "freeseek-api-close").start();
        }
        io.shutdownNow();
    }
}
