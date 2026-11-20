package app.freeseek.chat;

import static org.junit.Assert.*;
import android.content.Intent;
import android.os.Build;
import android.webkit.WebView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Collectors;
import java.util.zip.ZipFile;

/** 对实际打包资源和原生桥运行；同一测试可在 Android 10–17 执行。 */
@RunWith(AndroidJUnit4.class)
public class AndroidCompatibilityTest {
    private String evaluate(MainActivity activity, String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1); AtomicReference<String> result = new AtomicReference<>();
        activity.runOnUiThread(() -> activity.getBridge().getWebView().evaluateJavascript(script, value -> { result.set(value); done.countDown(); }));
        assertTrue("JavaScript evaluation timeout", done.await(8, TimeUnit.SECONDS)); return result.get();
    }
    private void awaitTrue(MainActivity activity, String expression) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(25);
        while (System.nanoTime() < deadline) {
            if ("true".equals(evaluate(activity, expression))) { return; }
            Thread.sleep(100);
        }
        fail("WebView condition timed out: " + expression);
    }
    private static String readZipText(ZipFile zip, String name) throws Exception {
        try (var reader = new BufferedReader(new InputStreamReader(
            zip.getInputStream(zip.getEntry(name)), StandardCharsets.UTF_8))) {
            return reader.lines().collect(Collectors.joining("\n"));
        }
    }
    private void verifyNativeDiagnosticArchive(MainActivity activity) throws Exception {
        evaluate(activity, "window.__nativeExport=null;" +
            "Capacitor.nativePromise('Diagnostics','exportStartup'," +
            "{mode:'fallback',phase:'diagnostics',share:true,errorName:'PRIVATE_NATIVE_CANARY'})" +
            ".then(function(r){window.__nativeExport=r.launched;},function(){window.__nativeExport=false;});");
        awaitTrue(activity, "window.__nativeExport===true");
        File[] folders = new File(activity.getCacheDir(), "diagnostic-shares").listFiles();
        assertNotNull(folders);
        File archive = null;
        for (File folder : folders) {
            File[] files = folder.listFiles((dir, name) -> name.matches("freeseek-native-diagnostics-[0-9]+\\.zip"));
            if (files == null) continue;
            for (File file : files) {
                if (archive == null || file.lastModified() > archive.lastModified()) archive = file;
            }
        }
        assertNotNull("The chooser must receive a real diagnostic ZIP", archive);
        try (ZipFile zip = new ZipFile(archive)) {
            assertEquals("native-fallback", new JSONObject(readZipText(zip, "manifest.json")).getString("diagnostic_mode"));
            JSONObject nativeEnv = new JSONObject(readZipText(zip, "environment.json")).getJSONObject("native");
            assertEquals(Build.VERSION.SDK_INT, nativeEnv.getInt("sdk"));
            assertEquals(Build.MODEL, nativeEnv.getString("model"));
            assertTrue(readZipText(zip, "native-events.jsonl").contains("bridge.ready"));
            assertFalse(readZipText(zip, "client-events.jsonl").contains("PRIVATE_NATIVE_CANARY"));
        }
    }
    @Test public void startupAndNativeBridges() throws Exception {
        var instrumentation = InstrumentationRegistry.getInstrumentation();
        Intent intent = new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(intent);
        try {
            awaitTrue(activity, "!!document.getElementById('root') && document.getElementById('root').childElementCount > 0 && document.getElementById('fs-startup').style.display === 'none'");
            assertEquals("true", evaluate(activity, "typeof Blob.prototype.stream==='function' && typeof Array.prototype.toReversed==='function' && typeof Object.hasOwn==='function' && typeof AbortSignal.prototype.throwIfAborted==='function'"));
            evaluate(activity, "window.__nativeCheck=null; Promise.all([" +
                "Capacitor.nativePromise('Diagnostics','snapshot',{})," +
                "Capacitor.nativePromise('MicPermission','check',{})," +
                "Capacitor.nativePromise('Diagnostics','readEvents',{})" +
                "]).then(function(r){" +
                "var e=r[0].environment; window.__nativeCheck={" +
                "sdk:e.sdk,version:e.version,pageSize:e.pageSizeBytes,mic:typeof r[1].granted==='boolean'," +
                "model:e.model,manufacturer:e.manufacturer,webviewDetected:e.webviewDetected," +
                "webviewVersion:e.webviewVersion,displayWidth:e.display.widthPixels," +
                "processExits:e.collection.processExits,network:e.collection.network," +
                "privateIds:['serial','imei','androidId','fingerprint'].some(function(k){return k in e;})," +
                "nativeLifecycle:r[2].events.some(function(event){return event.event==='bridge.ready' && typeof event.runId==='string';})" +
                "};},function(){window.__nativeCheck={failed:true};});");
            awaitTrue(activity, "window.__nativeCheck!==null");
            String encoded=evaluate(activity, "JSON.stringify(window.__nativeCheck)");
            JSONObject result=new JSONObject(new org.json.JSONArray("["+encoded+"]").getString(0));
            assertFalse(result.optBoolean("failed")); assertEquals(Build.VERSION.SDK_INT,result.getInt("sdk"));
            assertTrue(result.getInt("pageSize") >= 4096);assertTrue(result.getBoolean("mic"));
            assertEquals(Build.MODEL, result.getString("model"));
            assertEquals(Build.MANUFACTURER, result.getString("manufacturer"));
            assertTrue(result.getBoolean("webviewDetected"));
            assertFalse(result.getString("webviewVersion").isEmpty());
            assertTrue(result.getInt("displayWidth") > 0);
            assertEquals(Build.VERSION.SDK_INT >= 30 ? "available" : "unsupported", result.getString("processExits"));
            assertEquals("available", result.getString("network"));
            assertFalse(result.getBoolean("privateIds"));
            assertTrue(result.getBoolean("nativeLifecycle"));
            evaluate(activity, "window.__untrusted=null;Capacitor.nativePromise('Update','get',{url:'https://invalid.example/not-a-release'}).then(function(){window.__untrusted=false;},function(){window.__untrusted=true;});");
            awaitTrue(activity, "window.__untrusted===true");
            evaluate(activity, "window.__invalidSave=null;Capacitor.nativePromise('Backup','create',{fileName:'../bad.zip',size:-1}).then(function(){window.__invalidSave=false;},function(){window.__invalidSave=true;});");
            awaitTrue(activity, "window.__invalidSave===true");
            assertEquals("true",evaluate(activity,"document.documentElement.scrollWidth<=innerWidth+1"));
            awaitTrue(activity, "document.documentElement.style.getPropertyValue('--fs-native-top')!==''");
            // 画布包含状态栏和导航栏。可点击控件使用同一份真实边距。
            final int[] expected = new int[2];
            instrumentation.runOnMainSync(() -> {
                var decor = activity.getWindow().getDecorView();
                var insets = androidx.core.view.ViewCompat.getRootWindowInsets(decor);
                assertNotNull("Window insets must be available", insets);
                var safe = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars() | androidx.core.view.WindowInsetsCompat.Type.displayCutout());
                var webView = activity.getBridge().getWebView();
                int[] origin = new int[2], canvas = new int[2];
                decor.getLocationOnScreen(origin); webView.getLocationOnScreen(canvas);
                assertEquals("Canvas starts at top of window", origin[1], canvas[1]);
                assertEquals("Canvas ends at bottom of window", decor.getHeight(), webView.getHeight());
                float density = webView.getResources().getDisplayMetrics().density;
                expected[0] = Math.round(safe.top / density);
                expected[1] = Math.round(safe.bottom / density);
            });
            awaitTrue(activity, "Math.abs(parseFloat(document.documentElement.style.getPropertyValue('--fs-native-top'))-" + expected[0] + ")<=1 && Math.abs(parseFloat(document.documentElement.style.getPropertyValue('--fs-native-bottom'))-" + expected[1] + ")<=1");
            assertEquals("true", evaluate(activity, "(function(){var b=document.querySelector('[aria-controls=mobile-sider]'),t=document.querySelector('textarea');return (!b||b.getBoundingClientRect().top>=" + expected[0] + "-1)&&(!t||t.getBoundingClientRect().bottom<=innerHeight-" + expected[1] + "+1)})()"));
            verifyNativeDiagnosticArchive(activity);
        } finally { activity.runOnUiThread(activity::finish); }
    }
}
