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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

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
    @Test public void startupAndNativeBridges() throws Exception {
        var instrumentation = InstrumentationRegistry.getInstrumentation();
        Intent intent = new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(intent);
        try {
            awaitTrue(activity, "!!document.getElementById('root') && document.getElementById('root').childElementCount > 0 && document.getElementById('fs-startup').style.display === 'none'");
            assertEquals("true", evaluate(activity, "typeof Blob.prototype.stream==='function' && typeof Array.prototype.toReversed==='function' && typeof Object.hasOwn==='function' && typeof AbortSignal.prototype.throwIfAborted==='function'"));
            evaluate(activity, "window.__nativeCheck=null; Promise.all([Capacitor.nativePromise('Diagnostics','snapshot',{}),Capacitor.nativePromise('MicPermission','check',{})]).then(function(r){window.__nativeCheck={sdk:r[0].environment.sdk,version:r[0].environment.version,pageSize:r[0].environment.pageSizeBytes,mic:typeof r[1].granted==='boolean'};},function(){window.__nativeCheck={failed:true};});");
            awaitTrue(activity, "window.__nativeCheck!==null");
            String encoded=evaluate(activity, "JSON.stringify(window.__nativeCheck)");
            JSONObject result=new JSONObject(new org.json.JSONArray("["+encoded+"]").getString(0));
            assertFalse(result.optBoolean("failed")); assertEquals(Build.VERSION.SDK_INT,result.getInt("sdk"));
            assertTrue(result.getInt("pageSize") >= 4096);assertTrue(result.getBoolean("mic"));
            evaluate(activity, "window.__untrusted=null;Capacitor.nativePromise('Update','get',{url:'https://invalid.example/not-a-release'}).then(function(){window.__untrusted=false;},function(){window.__untrusted=true;});");
            awaitTrue(activity, "window.__untrusted===true");
            evaluate(activity, "window.__invalidSave=null;Capacitor.nativePromise('Backup','create',{fileName:'../bad.zip',size:-1}).then(function(){window.__invalidSave=false;},function(){window.__invalidSave=true;});");
            awaitTrue(activity, "window.__invalidSave===true");
            assertEquals("true",evaluate(activity,"document.documentElement.scrollWidth<=innerWidth+1"));
            assertEquals("true", evaluate(activity, "document.querySelector('meta[name=viewport]').content.indexOf('viewport-fit=cover')===-1"));
            // 新旧 WebView 都由原生留出系统栏；页面加载后不能切换到状态栏下面。
            instrumentation.runOnMainSync(() -> {
                var decor = activity.getWindow().getDecorView();
                var insets = androidx.core.view.ViewCompat.getRootWindowInsets(decor);
                assertNotNull("Window insets must be available", insets);
                var safe = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars() | androidx.core.view.WindowInsetsCompat.Type.displayCutout());
                int[] position = new int[2]; activity.getBridge().getWebView().getLocationOnScreen(position);
                assertTrue("WebView overlaps the status bar", position[1] >= safe.top);
                assertTrue("WebView overlaps the display cutout", position[0] >= safe.left);
            });
        } finally { activity.runOnUiThread(activity::finish); }
    }
}
