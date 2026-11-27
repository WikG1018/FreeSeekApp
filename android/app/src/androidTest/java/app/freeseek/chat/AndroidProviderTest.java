package app.freeseek.chat;

import static org.junit.Assert.*;
import android.content.*;
import android.os.Build;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

@RunWith(AndroidJUnit4.class)
public class AndroidProviderTest {
    private String evaluate(MainActivity activity, String code) throws Exception {
        CountDownLatch done = new CountDownLatch(1); AtomicReference<String> result = new AtomicReference<>();
        activity.runOnUiThread(() -> activity.getBridge().getWebView().evaluateJavascript(code, value -> { result.set(value); done.countDown(); }));
        assertTrue(done.await(8, TimeUnit.SECONDS)); return result.get();
    }
    private void awaitTrue(MainActivity activity, String code) throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(25);
        while (System.nanoTime() < until) { if ("true".equals(evaluate(activity, code))) return; Thread.sleep(100); }
        fail("Timed out: " + code);
    }
    private MainActivity start() throws Exception {
        var instrumentation = InstrumentationRegistry.getInstrumentation();
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        awaitTrue(activity, "!!(window.Capacitor && Capacitor.Plugins.CustomHttp && document.getElementById('root').childElementCount)");
        return activity;
    }
    private static String request(InputStream in) throws Exception {
        ByteArrayOutputStream headers = new ByteArrayOutputStream(); int value; String text;
        do { value = in.read(); if (value < 0 || headers.size() > 65536) throw new IOException(); headers.write(value); text = headers.toString("UTF-8"); } while (!text.endsWith("\r\n\r\n"));
        return text;
    }
    private JSONObject awaitBufferedResponse(Context context, String requestId) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < deadline) {
            var events = DiagnosticsLog.snapshot(context).getJSONArray("events");
            for (int i = events.length() - 1; i >= 0; i--) {
                JSONObject event = events.getJSONObject(i);
                JSONObject details = event.optJSONObject("details");
                if ("custom.body-completed".equals(event.optString("event")) &&
                    details != null && requestId.equals(details.optString("requestId"))) return details;
            }
            Thread.sleep(100);
        }
        throw new AssertionError("Native HTTP did not finish buffering while the WebView paused reads");
    }

    @Test public void nativeHttpBuffersUntilWebViewReadsAndCancels() throws Exception {
        var instrumentation = InstrumentationRegistry.getInstrumentation();
        if (Build.VERSION.SDK_INT >= 37) {
            try (var fd = instrumentation.getUiAutomation().executeShellCommand("pm grant app.freeseek.chat android.permission.ACCESS_LOCAL_NETWORK"); InputStream input = new android.os.ParcelFileDescriptor.AutoCloseInputStream(fd)) {
                while (input.read() != -1) {}
            }
        }
        MainActivity activity = start();
        StringBuilder content = new StringBuilder();
        for (int i = 0; i < 5000; i++) {
            content.append("data: {\"index\":").append(i).append(",\"text\":\"你好 🌏\"}\n\n");
        }
        byte[] payload = content.toString().getBytes(StandardCharsets.UTF_8);
        AtomicReference<Throwable> failure = new AtomicReference<>(); CountDownLatch disconnected = new CountDownLatch(1);
        try (ServerSocket server = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"))) {
            server.setSoTimeout(20000);
            Thread worker = new Thread(() -> {
                try {
                    try (Socket socket = server.accept()) {
                        request(socket.getInputStream()); OutputStream output = socket.getOutputStream();
                        output.write(("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: " + payload.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                        for (int offset = 0; offset < payload.length; offset += 13) output.write(payload, offset, Math.min(13, payload.length - offset));
                        output.flush();
                    }
                    try (Socket socket = server.accept()) {
                        socket.setSoTimeout(8000); request(socket.getInputStream());
                        socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 999999\r\nConnection: close\r\n\r\ndata: start\n\n".getBytes(StandardCharsets.US_ASCII)); socket.getOutputStream().flush();
                        try { if (socket.getInputStream().read() == -1) disconnected.countDown(); } catch (SocketException closed) { disconnected.countDown(); }
                    }
                } catch (Throwable error) { failure.set(error); }
            }, "freeseek-test-server"); worker.start();
            String url = "http://127.0.0.1:" + server.getLocalPort();
            String requestId = UUID.randomUUID().toString();
            evaluate(activity, String.format(Locale.ROOT, """
                window.__http = null;
                window.__httpStatus = null;
                Capacitor.Plugins.CustomHttp.start({
                  id: 'native-flow', url: '%s/stream', method: 'GET', requestId: '%s',
                  headers: { 'x-api-key': 'SYNTHETIC_TEST_KEY' }
                }).then(function (response) {
                  window.__httpStatus = response.status;
                }).catch(function (error) {
                  window.__httpStatus = error.code || 'START_FAILED';
                });
                """, url, requestId));
            awaitTrue(activity, "window.__httpStatus !== null");
            assertEquals("Native start must return successful headers", "200", evaluate(activity, "window.__httpStatus"));
            JSONObject buffered = awaitBufferedResponse(activity, requestId);
            assertEquals(payload.length, buffered.getLong("receivedBytes"));
            assertEquals(payload.length, buffered.getLong("pendingBytes"));
            assertTrue("Large replies must spill to disk while reading is paused", buffered.getLong("spooledBytes") > 0);
            evaluate(activity, """
                (function () {
                  var chunks = [];
                  function drain() {
                    return Capacitor.Plugins.CustomHttp.read({ id: 'native-flow' }).then(function (part) {
                      if (!part.done) {
                        chunks.push(atob(part.data));
                        return drain();
                      }
                      var raw = chunks.join('');
                      var bytes = Uint8Array.from(raw, function (char) { return char.charCodeAt(0); });
                      var lines = new TextDecoder().decode(bytes).trim().split('\\n\\n');
                      window.__http = {
                        bytes: raw.length,
                        exact: lines.length === 5000 && lines.every(function (line, index) {
                          return line === 'data: ' + JSON.stringify({ index: index, text: '你好 🌏' });
                        })
                      };
                    });
                  }
                  drain().catch(function (error) { window.__http = { error: error.code || 'READ_FAILED' }; });
                })();
                """);
            awaitTrue(activity, "window.__http!==null");
            assertEquals("true", evaluate(activity, "window.__http.bytes === " + payload.length + " && window.__http.exact === true"));
            evaluate(activity, String.format(Locale.ROOT, """
                window.__cancelDone = null;
                var nativeHttp = Capacitor.Plugins.CustomHttp;
                nativeHttp.start({ id: 'native-cancel', url: '%s/stall', method: 'GET' })
                  .then(function () { return nativeHttp.cancel({ id: 'native-cancel' }); })
                  .then(function () {
                    return nativeHttp.read({ id: 'native-cancel' }).then(
                      function () { window.__cancelDone = 'UNEXPECTED_READ'; },
                      function (error) { window.__cancelDone = error.code; }
                    );
                  }).catch(function (error) { window.__cancelDone = error.code || 'CANCEL_FAILED'; });
                """, url));
            awaitTrue(activity, "window.__cancelDone !== null");
            assertEquals("\"CANCELLED\"", evaluate(activity, "window.__cancelDone"));
            assertTrue("Cancelling must close the server connection", disconnected.await(10, TimeUnit.SECONDS));
            worker.join(1000); assertNull(failure.get());
        } finally { activity.runOnUiThread(activity::finish); }
    }
    @Test public void diagnosticShareGrantsOnlyTheSelectedFileToAnotherApp() throws Exception {
        var instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext(); MainActivity activity = start();
        CountDownLatch received = new CountDownLatch(1); AtomicBoolean matches = new AtomicBoolean();
        BroadcastReceiver receiver = new BroadcastReceiver() { @Override public void onReceive(Context c, Intent intent) { matches.set(intent.getBooleanExtra("matches", false)); received.countDown(); } };
        IntentFilter filter = new IntentFilter("app.freeseek.TEST_SHARE_RECEIVED");
        androidx.core.content.ContextCompat.registerReceiver(context, receiver, filter, androidx.core.content.ContextCompat.RECEIVER_EXPORTED);
        File file = ShareFiles.create(context, "freeseek-diagnostics-test.zip");
        try {
            try (var out = new java.util.zip.ZipOutputStream(new FileOutputStream(file))) {
                out.putNextEntry(new java.util.zip.ZipEntry("manifest.json"));
                out.write("{\"diagnostic_format_version\":1}".getBytes(StandardCharsets.UTF_8));
                out.closeEntry();
            }
            Intent intent = ShareFiles.intent(context, file);
            assertEquals(Intent.ACTION_SEND, intent.getAction()); assertEquals("application/zip", intent.getType());
            assertNotNull(intent.getClipData()); assertTrue((intent.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0);
            intent.setComponent(new ComponentName(instrumentation.getContext().getPackageName(), "app.freeseek.chat.ShareReceiverActivity"));
            activity.runOnUiThread(() -> activity.startActivity(intent));
            assertTrue("Test receiver did not respond", received.await(15, TimeUnit.SECONDS)); assertTrue(matches.get());
            evaluate(activity, "window.__shareInvalid=null;Capacitor.Plugins.DiagnosticShare.create({fileName:'../private.zip',size:10}).then(function(){window.__shareInvalid=false},function(){window.__shareInvalid=true});");
            awaitTrue(activity, "window.__shareInvalid===true");
        } finally { context.unregisterReceiver(receiver); file.delete(); activity.runOnUiThread(activity::finish); }
    }
}
