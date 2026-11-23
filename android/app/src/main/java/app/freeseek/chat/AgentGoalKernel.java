package app.freeseek.chat;

import android.content.Context;
import android.os.SystemClock;
import com.getcapacitor.JSObject;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import org.mozilla.javascript.ContextFactory;
import org.mozilla.javascript.Function;
import org.mozilla.javascript.Scriptable;
import org.mozilla.javascript.ScriptableObject;

/** Evaluates only the packaged Agent state machine. All tool and model data is passed as JSON. */
final class AgentGoalKernel {
    private static final int MAX_RESULT = 20 * 1024 * 1024;
    private static final long LOAD_TIMEOUT_MS = 24_000;
    private static final long CALL_TIMEOUT_MS = 12_000;

    private static final class KernelFactory extends ContextFactory {
        private final Context app;
        private String stage;
        private long started;
        private long limit;

        KernelFactory(Context app) {
            this.app = app.getApplicationContext();
        }

        @Override
        protected org.mozilla.javascript.Context makeContext() {
            org.mozilla.javascript.Context cx = super.makeContext();
            cx.setLanguageVersion(org.mozilla.javascript.Context.VERSION_ES6);
            cx.setOptimizationLevel(-1);
            cx.setInstructionObserverThreshold(50_000);
            cx.setClassShutter(name -> false);
            return cx;
        }

        @Override
        protected void observeInstructionCount(org.mozilla.javascript.Context cx, int instructions) {
            long elapsed = SystemClock.elapsedRealtime() - started;
            if (elapsed > limit) {
                DiagnosticsLog.warn(app, "chat", "agent.goal.kernel-timeout", new JSObject()
                    .put("stage", stage).put("elapsedMs", elapsed).put("timeoutMs", limit));
                throw new IllegalStateException("Agent kernel took too long");
            }
        }

        void budget(String stage, long limit) {
            this.stage = stage;
            this.limit = limit;
            started = SystemClock.elapsedRealtime();
        }
    }

    private final KernelFactory factory;
    private final ScriptableObject scope;
    private final Scriptable kernel;

    AgentGoalKernel(Context app) throws Exception {
        long started = SystemClock.elapsedRealtime();
        factory = new KernelFactory(app);
        org.mozilla.javascript.Context context = factory.enterContext();
        try {
            scope = context.initSafeStandardObjects();
            factory.budget("load", LOAD_TIMEOUT_MS);
            try (InputStreamReader source = new InputStreamReader(
                app.getAssets().open("public/agent-kernel.js"), StandardCharsets.UTF_8
            )) {
                context.evaluateReader(scope, source, "agent-kernel.js", 1, null);
            }
            Object library = ScriptableObject.getProperty(scope, "FreeSeekAgentKernel");
            if (!(library instanceof Scriptable)) {
                throw new IllegalStateException("Agent kernel unavailable");
            }
            kernel = (Scriptable) library;
            DiagnosticsLog.record(app, "chat", "agent.goal.kernel-loaded", new JSObject()
                .put("elapsedMs", SystemClock.elapsedRealtime() - started));
        } finally {
            org.mozilla.javascript.Context.exit();
        }
    }

    String call(String name, Object... arguments) {
        org.mozilla.javascript.Context context = factory.enterContext();
        try {
            factory.budget(name, CALL_TIMEOUT_MS);
            Object value = ScriptableObject.getProperty(kernel, name);
            if (!(value instanceof Function)) {
                throw new IllegalStateException("Invalid kernel action");
            }
            Object result = ((Function) value).call(context, scope, kernel, arguments);
            String json = org.mozilla.javascript.Context.toString(result);
            if (json.length() > MAX_RESULT) {
                throw new IllegalStateException("Agent kernel result exceeded local limits");
            }
            return json;
        } finally {
            org.mozilla.javascript.Context.exit();
        }
    }
}
