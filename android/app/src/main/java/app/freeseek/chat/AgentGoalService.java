package app.freeseek.chat;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Base64;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.Proxy;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import okhttp3.Call;
import okhttp3.Headers;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okio.BufferedSource;
import org.json.JSONArray;
import org.json.JSONObject;

/** The OS-visible owner of one native Agent goal. No Activity or WebView owns this work. */
public final class AgentGoalService extends Service {
    static final String ACTION_START = "app.freeseek.chat.goal.START";
    private static final String ACTION_PAUSE = "app.freeseek.chat.goal.PAUSE";
    private static final String ACTION_END = "app.freeseek.chat.goal.END";
    static final String EXTRA_ID = "run";
    private static final String CHANNEL_ID = "agent-goals";
    private static final int NOTIFICATION_ID = 24310;
    private static final int MAX_MODEL_BYTES = 8 * 1024 * 1024;
    private static final int MODEL_IDLE_MS = 300_000;
    private static final long ACTIVE_WAKE_MS = 6 * 60_000L;
    private static final int PUBLIC_TIMEOUT_MS = 15_000;
    private static final int PUBLIC_ATTEMPTS = 24;
    private static final Pattern RUN_STATUS = Pattern.compile("running|paused|blocked|partial|completed|stopped|failed");
    private static final Pattern STOP_REASON = Pattern.compile(
        "budget-time|budget-requests|context-limit|output-limit|tools-unavailable|provider-error|"
        + "source-failed|waiting-browser|waiting-foreground|criteria-unmet|no-progress|interrupted|storage|host-unavailable|host-busy|"
        + "notification-permission|system-timeout|user|request-unconfirmed|provider-rate-limit|provider-timeout|connection-changed"
    );
    private static final Pattern READ_OR_EFFECT_ERROR = Pattern.compile(
        "artifact-invalid|unknown-effect|request-too-large|provider-empty|provider-redirect|provider-http|"
        + "provider-network|provider-timeout|provider-stream|tools-unavailable|rate-limit|read-budget|public-http|public-empty|blocked|"
        + "timeout|unsupported|network|cancelled|read"
    );
    private static final Pattern RESPONSE_REQUEST_ID = Pattern.compile(
        "(?i)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{32}"
    );
    private static final ExecutorService WORK = Executors.newSingleThreadExecutor();
    private static final AtomicReference<Ticket> ACTIVE = new AtomicReference<>();
    private static boolean forgetting;
    private static final OkHttpClient PROVIDER = new OkHttpClient.Builder()
        .proxy(Proxy.NO_PROXY)
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .connectTimeout(20, TimeUnit.SECONDS)
        .build();
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private static final Set<String> HOP_HEADERS = new HashSet<>(Arrays.asList(
        "host", "content-length", "connection", "transfer-encoding", "cookie", "origin",
        "proxy-authorization", "proxy-connection", "upgrade", "accept", "content-type",
        "accept-encoding", "te", "trailer"
    ));
    private static final Pattern TOOL_REJECTION = Pattern.compile(
        "(?:tool(?:s|_choice| calling)?|function calling).{0,50}(?:not supported|unsupported|unavailable)"
        + "|(?:does not support|unsupported|unrecognized|unknown).{0,40}(?:tools|tool_choice|function calling)",
        Pattern.CASE_INSENSITIVE
    );
    private static final Pattern CHARSET = Pattern.compile("charset\\s*=\\s*[\"']?([\\w-]+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern NEXT = Pattern.compile("<([^>]+)>;\\s*rel=\"next\"", Pattern.CASE_INSENSITIVE);
    private static final Map<String, String> ARTIFACTS = new HashMap<>();
    static {
        ARTIFACTS.put("md", "text/markdown");
        ARTIFACTS.put("txt", "text/plain");
        ARTIFACTS.put("json", "application/json");
        ARTIFACTS.put("csv", "text/csv");
        ARTIFACTS.put("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        ARTIFACTS.put("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    }

    record Wire(HttpUrl endpoint, Headers headers) {
        static Wire read(JSONObject input) throws Exception {
            HttpUrl url = HttpUrl.parse(input.optString("url"));
            if (url == null || !url.username().isEmpty() || !url.password().isEmpty()
                || url.fragment() != null || url.toString().length() > 4096) {
                throw new IllegalArgumentException("Invalid Agent provider");
            }
            JSONObject requested = input.optJSONObject("headers");
            Headers.Builder headers = new Headers.Builder();
            if (requested != null) {
                if (requested.length() > 40) throw new IllegalArgumentException("Too many provider headers");
                Iterator<String> names = requested.keys();
                while (names.hasNext()) {
                    String name = names.next();
                    String lower = name.toLowerCase(Locale.ROOT);
                    if (HOP_HEADERS.contains(lower)) continue;
                    Object value = requested.opt(name);
                    if (!(value instanceof String) || ((String) value).length() > 8192
                        || !name.matches("[!#$%&'*+.^_\u0060|~0-9A-Za-z-]{1,100}")) {
                        throw new IllegalArgumentException("Invalid Agent provider header");
                    }
                    headers.add(name, (String) value);
                }
            }
            return new Wire(url, headers.build());
        }
    }

    static final class Ticket {
        final String id;
        final Wire wire;
        final String session;
        final boolean chinese;
        final AtomicReference<String> stop = new AtomicReference<>();
        final CompletableFuture<Boolean> settled = new CompletableFuture<>();
        volatile Call providerCall;
        volatile PublicWebPlugin.Transfer publicCall;
        AgentGoalKernel kernel;
        String protocol;
        volatile ModelActivity activity;
        volatile PowerManager.WakeLock wakeLock;
        private long wakeRenewedAt;
        int publicAttempts;
        long githubRetryAt;

        Ticket(String id, Wire wire, String session, boolean chinese) {
            this.id = id;
            this.wire = wire;
            this.session = session;
            this.chinese = chinese;
        }

        boolean cancel(String reason) {
            if (!stop.compareAndSet(null, reason)) return false;
            Call provider = providerCall;
            if (provider != null) provider.cancel();
            PublicWebPlugin.Transfer read = publicCall;
            if (read != null) read.cancel();
            return true;
        }

        synchronized void renewWake() {
            PowerManager.WakeLock lock = wakeLock;
            long now = SystemClock.elapsedRealtime();
            if (lock == null || stop.get() != null) return;
            if (!lock.isHeld() || now - wakeRenewedAt >= 240_000L) {
                lock.acquire(ACTIVE_WAKE_MS);
                wakeRenewedAt = now;
            }
        }

        synchronized void releaseWake() {
            PowerManager.WakeLock lock = wakeLock;
            wakeLock = null;
            if (lock != null && lock.isHeld()) lock.release();
        }
    }

    private record ModelActivity(String phase, long updatedAt) {}

    private Ticket running;

    static synchronized Ticket reserve(String id, Wire wire, String session, boolean chinese) {
        if (forgetting) return null;
        Ticket ticket = new Ticket(id, wire, session, chinese);
        if (!ACTIVE.compareAndSet(null, ticket)) return null;
        AgentGoalsPlugin.goalActivityChanged();
        return ticket;
    }

    static String activeSession() {
        Ticket ticket = ACTIVE.get();
        return ticket == null ? null : ticket.session;
    }

    static void pauseForAccessChange() {
        Ticket ticket = ACTIVE.get();
        if (ticket != null) ticket.cancel("interrupted");
    }

    static void release(Ticket ticket) {
        if (ACTIVE.compareAndSet(ticket, null)) AgentGoalsPlugin.goalActivityChanged();
    }

    static boolean active(String id) {
        Ticket ticket = ACTIVE.get();
        return ticket != null && ticket.id.equals(id);
    }

    static Ticket control(String id, String action) {
        Ticket ticket = ACTIVE.get();
        if (ticket == null || !ticket.id.equals(id)) return null;
        ticket.cancel(action);
        return ticket;
    }

    private static Ticket goalBeingForgotten(String id) {
        Ticket ticket = ACTIVE.get();
        return ticket != null && (id == null || id.equals(ticket.id)) ? ticket : null;
    }

    static synchronized boolean beginForget(String id) {
        if (forgetting) return false;
        forgetting = true;
        Ticket ticket = goalBeingForgotten(id);
        if (ticket != null) ticket.cancel("end");
        return true;
    }

    static boolean forgetWaitsForWorker(String id) { return goalBeingForgotten(id) != null; }

    static boolean forget(Context context, String id) throws Exception {
        try {
            // The same executor owns preparation, effects and retirement. Waiting behind it
            // ensures that a canceled transport or staged file cannot recreate this job later.
            AgentGoalStore db = AgentGoalStore.open(context);
            Ticket ticket = goalBeingForgotten(id);
            if (ticket != null && !ticket.settled.isDone()) {
                String state = db.state(ticket.id);
                if (ticket.kernel != null && state != null && "running".equals(run(state).optString("status"))) {
                    String stopped = ticket.kernel.call("stop", state, "end", now());
                    commit(db, ticket.kernel, ticket.id, stopped, null);
                    recordSettlement(context, ticket.id, run(stopped));
                }
                ticket.settled.complete(true);
            }
            boolean deleted = db.forget(id);
            JSObject details = new JSObject().put("all", id == null);
            if (id != null) details.put("runId", id);
            DiagnosticsLog.record(context, "chat", "agent.goal.native-forgotten", details);
            return deleted;
        } finally {
            synchronized (AgentGoalService.class) {
                forgetting = false;
            }
        }
    }

    static synchronized boolean stopInactive(Context context, String id, String action) throws Exception {
        if (active(id)) return false;
        AgentGoalStore db = AgentGoalStore.open(context);
        String view = snapshot(context, id);
        if (view == null) return false;
        String status = run(view).optString("status");
        if ("pause".equals(action)) return "paused".equals(status);
        if ("stopped".equals(status)) return true;
        if (!resumable(status)) return false;
        String state = db.state(id);
        if (state == null) return false;
        AgentGoalKernel engine = new AgentGoalKernel(context);
        String stopped = engine.call("stop", state, "end", now());
        commit(db, engine, id, stopped, null);
        recordSettlement(context, id, run(stopped));
        return true;
    }

    static void schedule(Runnable task) {
        WORK.execute(task);
    }

    private static String text(Context context, String zh, String en) {
        return "zh".equals(context.getResources().getConfiguration().getLocales().get(0).getLanguage())
            ? zh : en;
    }

    private static void ensureChannel(Context context, NotificationManager manager) {
        if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, text(context, "后台目标", "Background goals"), NotificationManager.IMPORTANCE_LOW
            );
            channel.setShowBadge(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
            manager.createNotificationChannel(channel);
        }
    }

    static boolean notificationsAllowed(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || !manager.areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(
            context, Manifest.permission.POST_NOTIFICATIONS
        ) != PackageManager.PERMISSION_GRANTED) return false;
        ensureChannel(context, manager);
        return Build.VERSION.SDK_INT < 26 ||
            manager.getNotificationChannel(CHANNEL_ID).getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    static boolean validId(String id) {
        return id != null && id.matches("[A-Za-z0-9_-]{1,100}");
    }

    static double now() {
        return (double) System.currentTimeMillis();
    }

    private static JSONObject run(String state) throws Exception {
        return new JSONObject(state).getJSONObject("run");
    }

    private static void recordSettlement(Context context, String id, JSONObject run) {
        String status = run.optString("status");
        String reason = run.optString("reason");
        JSObject details = new JSObject().put("runId", id)
            .put("status", RUN_STATUS.matcher(status).matches() ? status : "unknown")
            .put("totalRequests", Math.max(0, run.optInt("totalRequests")))
            .put("requestInFlight", run.optBoolean("requestInFlight"));
        if (STOP_REASON.matcher(reason).matches()) details.put("reason", reason);
        DiagnosticsLog.record(context, "chat", "agent.goal.native-settled", details);
    }

    private static void recordEffect(Context context, Ticket ticket, String kind, JSONObject result, long elapsed) {
        boolean publicRead = "public".equals(kind);
        boolean model = "model".equals(kind);
        JSObject details = new JSObject().put("runId", ticket.id).put("elapsedMs", elapsed)
            .put("kind", model || publicRead || "save".equals(kind) ? kind : "unknown");
        int status = result.optInt("status");
        String error = result.optString("error");
        if (status >= 100 && status <= 599) details.put("status", status);
        if (READ_OR_EFFECT_ERROR.matcher(error).matches()) details.put("reason", error);
        long retryAt = result.optLong("retryAt");
        if (retryAt > 0) details.put("retryAt", retryAt);
        if (result.has("downloadedBytes")) details.put("bytes", result.optInt("downloadedBytes"));
        if (publicRead) details.put("truncated", result.optBoolean("truncated"));
        if (model) {
            details.put("confirmed", result.optBoolean("confirmed"));
            String requestId = result.optString("requestId");
            if (RESPONSE_REQUEST_ID.matcher(requestId).matches()) details.put("requestId", requestId);
        }
        if (error.isEmpty()) DiagnosticsLog.record(context, "chat", "agent.goal.native-effect", details);
        else DiagnosticsLog.warn(context, "chat", "agent.goal.native-effect", details);
    }

    private static String fileId(String run, String state) throws Exception {
        return run + "-file-" + new JSONObject(state).getLong("sequence");
    }

    /** Avoid passing a multi-megabyte event journal across the Capacitor bridge. */
    private static String bridgeView(AgentGoalKernel engine, String state, int count) throws Exception {
        JSONObject view = new JSONObject(engine.call("view", state)).put("blockCount", count);
        view.remove("answer");
        view.remove("blocks");
        String serialized = view.toString();
        if (serialized.length() <= AgentGoalStore.MAX_VIEW_CHARS) return serialized;
        JSONArray steps = view.optJSONArray("steps");
        if (steps != null) {
            JSONArray reduced = new JSONArray();
            for (int i = Math.max(0, steps.length() - 80); i < steps.length(); i++) {
                JSONObject step = steps.optJSONObject(i);
                if (step == null) continue;
                JSONArray evidence = step.optJSONArray("evidence");
                if (evidence != null) {
                    for (int j = 0; j < evidence.length(); j++) {
                        JSONObject detail = evidence.optJSONObject(j);
                        if (detail != null) detail.remove("excerpt");
                    }
                }
                reduced.put(step);
            }
            view.put("steps", reduced).put("stepsTruncated", true);
        }
        serialized = view.toString();
        if (serialized.length() <= AgentGoalStore.MAX_VIEW_CHARS) return serialized;
        view.put("steps", new JSONArray()).put("stepsTruncated", true);
        return view.toString();
    }

    private static String commit(
        AgentGoalStore db, AgentGoalKernel engine, String id, String state, String artifact
    ) throws Exception {
        JSONObject journal = new JSONObject(state);
        JSONArray blocks = journal.optJSONArray("blocks");
        int first = journal.optInt("blockOffset");
        if (first == 0 && (blocks == null || blocks.length() == 0) && !journal.optString("answer").isEmpty()) {
            blocks = new JSONArray().put(new JSONObject().put("type", "text").put("text", journal.optString("answer")));
        }
        int count = first + (blocks == null ? 0 : blocks.length());
        journal.put("blockOffset", count).put("blocks", new JSONArray()).remove("answer");
        String normalized = journal.toString();
        db.checkpoint(id, normalized, bridgeView(engine, normalized, count), first, blocks, artifact);
        return normalized;
    }

    private static String recoverPendingArtifact(
        AgentGoalStore db, AgentGoalKernel engine, String id, String state
    ) throws Exception {
        JSONObject pending = new JSONObject(state).optJSONObject("pending");
        if (pending == null || !"write".equals(pending.optString("operation"))) return state;
        String fileId = fileId(id, state);
        AgentGoalStore.Artifact artifact = db.artifact(id, fileId, false);
        if (artifact != null && artifact.hasVerifiedBytes()) {
            String restored = engine.call("apply", state,
                new JSONObject().put("artifact", artifact.result()).toString());
            return commit(db, engine, id, restored, fileId);
        }
        if (artifact != null) db.discardStage(id, fileId);
        return state;
    }

    private static boolean resumable(String status) {
        return "paused".equals(status) || "blocked".equals(status) ||
            "partial".equals(status) || "failed".equals(status);
    }

    private static String fingerprint(String url, JSONObject input) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest((
            url + "\n" + input.optString("protocol") + "\n"
            + input.getJSONObject("body").optString("model")
        ).getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(bytes, Base64.NO_WRAP);
    }

    private static boolean matchesRoute(String old, Wire wire, JSONObject input) throws Exception {
        String endpoint = wire.endpoint().toString();
        if (old.equals(fingerprint(endpoint, input))) return true;
        if (!"gemini".equals(input.optString("protocol"))) return false;
        HttpUrl legacy = wire.endpoint().newBuilder()
            .encodedPath(wire.endpoint().encodedPath().replace(":streamGenerateContent", ":generateContent"))
            .removeAllQueryParameters("alt").build();
        return old.equals(fingerprint(legacy.toString(), input));
    }

    static String prepare(Context context, Ticket ticket, JSONObject input, boolean resume, boolean retryUnconfirmed) throws Exception {
        AgentGoalStore db = AgentGoalStore.open(context);
        String previous = db.state(ticket.id);
        if (resume && previous == null) return "checkpoint-missing";
        if (!resume && previous != null) return "already-exists";
        String identity = fingerprint(ticket.wire.endpoint().toString(), input);
        if (resume && !matchesRoute(new JSONObject(previous).optString("hostRoute"), ticket.wire, input)) return "provider-changed";
        AgentGoalKernel engine = new AgentGoalKernel(context);
        String prepared;
        if (resume) {
            previous = recoverPendingArtifact(db, engine, ticket.id, previous);
            String status = run(previous).optString("status");
            if ("running".equals(status)) {
                previous = engine.call("stop", previous, "interrupted", now());
                status = run(previous).optString("status");
            }
            if (!resumable(status)) return "already-finished";
            ticket.githubRetryAt = new JSONObject(previous).optLong("hostGithubRetryAt");
            JSONObject decision = new JSONObject().put("retryUnconfirmed", retryUnconfirmed)
                .put("requestLimit", input.getJSONObject("run").optLong("requestLimit"))
                .put("stream", input.getJSONObject("body").optBoolean("stream"));
            prepared = engine.call("resume", previous, now(), decision.toString());
            if (!"running".equals(run(prepared).optString("status"))) {
                commit(db, engine, ticket.id, prepared, null);
                return run(prepared).optString("reason", "interrupted");
            }
        } else {
            prepared = new JSONObject(engine.call("create", input.toString()))
                .put("hostRoute", identity).toString();
        }
        commit(db, engine, ticket.id, prepared, null);
        ticket.kernel = engine;
        ticket.protocol = input.optString("protocol");
        return null;
    }

    static void markUnavailable(Context context, Ticket ticket, String reason) {
        try {
            AgentGoalKernel engine = ticket.kernel;
            AgentGoalStore db = AgentGoalStore.open(context);
            String state = db.state(ticket.id);
            if (engine != null && state != null && "running".equals(run(state).optString("status"))) {
                state = recoverPendingArtifact(db, engine, ticket.id, state);
                String stopped = engine.call("stop", state, reason, now());
                commit(db, engine, ticket.id, stopped, null);
                recordSettlement(context, ticket.id, run(stopped));
                TaskNotifications.result(context, ticket.session, true, ticket.chinese, "attention");
            }
        } catch (Exception failure) {
            // Never log the exception: parser errors and transport exceptions can contain task content.
            DiagnosticsLog.warn(context, "chat", "agent.goal.checkpoint-unavailable", new JSObject());
        } finally {
            ticket.settled.complete(false);
            release(ticket);
        }
    }

    static String snapshot(Context context, String id) throws Exception {
        AgentGoalStore db = AgentGoalStore.open(context);
        String view = db.view(id);
        if (view == null) return null;
        Ticket resident = ACTIVE.get();
        if (resident != null && resident.id.equals(id)) {
            ModelActivity activity = resident.activity;
            return activity == null ? view : new JSONObject(view).put("activity", new JSONObject()
                .put("phase", activity.phase()).put("updatedAt", activity.updatedAt())).toString();
        }
        if (!"running".equals(run(view).optString("status"))) return view;
        // A persisted running job with no resident owner was interrupted, not completed.
        synchronized (AgentGoalService.class) {
            if (!active(id)) {
                String state = db.state(id);
                if (state != null && "running".equals(run(state).optString("status"))) {
                    AgentGoalKernel engine = new AgentGoalKernel(context);
                    state = recoverPendingArtifact(db, engine, id, state);
                    String stopped = engine.call("stop", state, "interrupted", now());
                    commit(db, engine, id, stopped, null);
                    recordSettlement(context, id, run(stopped));
                }
            }
        }
        return db.view(id);
    }

    static synchronized JSONObject pendingTool(Context context, String id) throws Exception {
        if (!validId(id) || active(id)) return null;
        String checkpoint = AgentGoalStore.open(context).state(id);
        if (checkpoint == null) return null;
        JSONObject state = new JSONObject(checkpoint);
        JSONObject pending = state.optJSONObject("pending");
        JSONObject run = state.getJSONObject("run");
        if (pending == null || !"foreground".equals(pending.optString("operation")) ||
            !"waiting-foreground".equals(run.optString("reason"))) return null;
        return new JSONObject().put("id", pending.getJSONObject("step").getString("id"))
            .put("name", pending.getString("tool")).put("args", pending.getJSONObject("args"));
    }

    private PendingIntent controlIntent(Ticket ticket, String action, int token) {
        Intent intent = new Intent(this, AgentGoalService.class)
            .setAction(action)
            .putExtra(EXTRA_ID, ticket.id);
        return PendingIntent.getService(this, token, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification notification(Ticket ticket) {
        ensureChannel(this, getSystemService(NotificationManager.class));
        PendingIntent open = TaskNotifications.open(this, ticket.session, "goal");
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, CHANNEL_ID) : new Notification.Builder(this);
        return builder.setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(ticket.chinese ? "FreeSeek 正在执行后台目标" : "FreeSeek is running a goal")
            .setContentText(ticket.chinese ? "打开原对话查看进度" : "Open the conversation to view progress")
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .addAction(new Notification.Action.Builder(
                null, ticket.chinese ? "暂停" : "Pause", controlIntent(ticket, ACTION_PAUSE, 24311)
            ).build())
            .addAction(new Notification.Action.Builder(
                null, ticket.chinese ? "停止" : "Stop", controlIntent(ticket, ACTION_END, 24312)
            ).build())
            .build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Ticket ticket = ACTIVE.get();
        String id = intent == null ? null : intent.getStringExtra(EXTRA_ID);
        if (ticket == null || !ticket.id.equals(id)) {
            if (running == null) stopSelf(startId);
            return START_NOT_STICKY;
        }
        String action = intent.getAction();
        if (ACTION_PAUSE.equals(action) || ACTION_END.equals(action)) {
            ticket.cancel(ACTION_END.equals(action) ? "end" : "pause");
            return START_NOT_STICKY;
        }
        if (!ACTION_START.equals(action) || running != null) return START_NOT_STICKY;
        try {
            Notification notice = notification(ticket);
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIFICATION_ID, notice);
            }
            running = ticket;
            PowerManager power = getSystemService(PowerManager.class);
            if (power != null) {
                ticket.wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, getPackageName() + ":agent-goal");
                ticket.wakeLock.setReferenceCounted(false);
            }
            schedule(() -> execute(ticket));
        } catch (RuntimeException denied) {
            running = null;
            schedule(() -> markUnavailable(getApplicationContext(), ticket, "system-timeout"));
            stopSelf(startId);
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onTimeout(int startId, int serviceType) {
        if (running != null) running.cancel("system-timeout");
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf(startId);
    }

    @Override
    public void onDestroy() {
        Ticket ticket = running;
        if (ticket != null) ticket.cancel("interrupted");
        if (ticket != null) ticket.releaseWake();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void execute(Ticket ticket) {
        Context context = getApplicationContext();
        AgentGoalStore db = AgentGoalStore.open(context);
        try {
            AgentGoalKernel engine = ticket.kernel;
            String state = db.state(ticket.id);
            if (state == null) return;
            while ("running".equals(run(state).optString("status"))) {
                String stopped = ticket.stop.get();
                if (stopped != null) {
                    state = engine.call("stop", state, stopped, now());
                    commit(db, engine, ticket.id, state, null);
                    break;
                }
                JSONObject transition = new JSONObject(engine.call("next", state, now()));
                String intended = transition.getJSONObject("state").toString();
                JSONObject effect = transition.optJSONObject("effect");
                if (effect == null) {
                    if (state.equals(intended)) {
                        intended = engine.call("stop", state, "interrupted", now());
                    }
                    state = commit(db, engine, ticket.id, intended, null);
                    continue;
                }
                // Checkpoint before issuing a potentially billable request or committing a file.
                state = commit(db, engine, ticket.id, intended, null);
                if (ticket.stop.get() != null) continue;
                long effectStarted = SystemClock.elapsedRealtime();
                ticket.renewWake();
                Observation observed = perform(ticket, db, state, effect);
                recordEffect(context, ticket, effect.optString("kind"), observed.json(),
                    SystemClock.elapsedRealtime() - effectStarted);
                if (ticket.stop.get() != null && observed.readyFile() == null
                    && !observed.json().optBoolean("confirmed") && !observed.json().has("content")) continue;
                String applied = engine.call("apply", state, observed.json().toString());
                if (ticket.stop.get() != null) {
                    applied = engine.call("stop", applied, ticket.stop.get(), now());
                }
                if (ticket.githubRetryAt > System.currentTimeMillis()) {
                    applied = new JSONObject(applied).put("hostGithubRetryAt", ticket.githubRetryAt).toString();
                }
                state = commit(db, engine, ticket.id, applied, observed.readyFile());
            }
            JSONObject settled = run(state);
            String status = settled.optString("status");
            ticket.settled.complete("paused".equals(status) || "stopped".equals(status));
            recordSettlement(context, ticket.id, settled);
            String stop = ticket.stop.get();
            if (!"pause".equals(stop) && !"end".equals(stop)) {
                TaskNotifications.result(context, ticket.session, true, ticket.chinese,
                    "completed".equals(status) ? "completed" : "attention");
            }
        } catch (Exception failure) {
            DiagnosticsLog.warn(context, "chat", "agent.goal.native-failed", new JSObject().put("reason", "storage"));
            markUnavailable(context, ticket, "storage");
        } finally {
            new android.os.Handler(getMainLooper()).post(() -> {
                ticket.settled.complete(false);
                ticket.releaseWake();
                release(ticket);
                if (running == ticket) {
                    running = null;
                    stopForeground(STOP_FOREGROUND_REMOVE);
                    stopSelf();
                }
            });
        }
    }

    private record Observation(JSONObject json, String readyFile) {}

    private Observation perform(Ticket ticket, AgentGoalStore db, String state, JSONObject effect) throws Exception {
        String kind = effect.optString("kind");
        if ("model".equals(kind)) {
            return new Observation(requestModel(ticket, effect.getJSONObject("body")), null);
        }
        if ("public".equals(kind)) {
            return new Observation(requestPublic(
                ticket, effect.optString("url"), effect.optBoolean("raw"),
                PUBLIC_TIMEOUT_MS
            ), null);
        }
        if ("save".equals(kind)) {
            String name = effect.optString("name");
            String mime = effect.optString("mimeType");
            int dot = name.lastIndexOf('.');
            String suffix = dot >= 0 ? name.substring(dot + 1) : "";
            String encoded = effect.optString("base64");
            if (!mime.equals(ARTIFACTS.get(suffix)) || name.length() > 90
                || name.matches(".*[\\x00-\\x1f/\\\\<>:\"|?*].*")
                || encoded.length() > ((AgentGoalStore.MAX_FILE_BYTES + 2) / 3) * 4) {
                return new Observation(new JSONObject().put("error", "artifact-invalid"), null);
            }
            String id = fileId(ticket.id, state);
            byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
            db.stageArtifact(ticket.id, id, name, mime, bytes);
            AgentGoalStore.Artifact staged = db.artifact(ticket.id, id, false);
            if (staged == null) throw new IllegalStateException("Agent artifact did not stage");
            return new Observation(new JSONObject().put("artifact", staged.result())
                .put("downloadedBytes", bytes.length), id);
        }
        return new Observation(new JSONObject().put("error", "unknown-effect"), null);
    }

    private static byte[] readBytes(InputStream stream, int limit) throws IOException {
        try (ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16_384];
            for (int count; (count = stream.read(buffer)) != -1; ) {
                if (bytes.size() + count > limit) throw new IOException("Response size limit");
                bytes.write(buffer, 0, count);
            }
            return bytes.toByteArray();
        }
    }

    private static JSONObject requestModel(Ticket ticket, JSONObject body) throws Exception {
        byte[] data = body.toString().getBytes(StandardCharsets.UTF_8);
        if (data.length > MAX_MODEL_BYTES) {
            return new JSONObject().put("error", "request-too-large").put("confirmed", true);
        }
        Request request = new Request.Builder()
            .url(ticket.wire.endpoint())
            .headers(ticket.wire.headers())
            .header("Accept", "text/event-stream, application/json")
            .post(RequestBody.create(data, JSON))
            .build();
        Call call = PROVIDER.newBuilder().readTimeout(MODEL_IDLE_MS, TimeUnit.MILLISECONDS).build().newCall(request);
        ticket.providerCall = call;
        ticket.activity = new ModelActivity("waiting", System.currentTimeMillis());
        if (ticket.stop.get() != null) call.cancel();
        try (Response response = call.execute()) {
            JSONObject result = new JSONObject().put("status", response.code()).put("confirmed", true);
            String requestId = response.header("x-request-id");
            if (requestId != null && RESPONSE_REQUEST_ID.matcher(requestId).matches()) {
                result.put("requestId", requestId);
            }
            if (response.body() == null) return result.put("error", "provider-empty");
            if (!response.isSuccessful()) {
                if (response.code() == 429) {
                    result.put("retryAt", retryAt(new JSONObject().put("retryAfter", response.header("Retry-After", ""))));
                }
                if (response.code() == 400 || response.code() == 422) {
                    String detail;
                    try (InputStream stream = response.body().byteStream()) {
                        detail = new String(readBytes(stream, 32_768), StandardCharsets.UTF_8);
                    } catch (IOException limit) {
                        detail = "";
                    }
                    if (TOOL_REJECTION.matcher(detail).find()) return result.put("error", "tools-unavailable");
                }
                return result.put("error", response.isRedirect() ? "provider-redirect" : "provider-http");
            }
            if (response.header("Content-Type", "").toLowerCase(Locale.ROOT).contains("text/event-stream")) {
                JSONObject collected = readModelStream(ticket, response.body().source());
                for (Iterator<String> keys = collected.keys(); keys.hasNext(); ) {
                    String key = keys.next();
                    result.put(key, collected.get(key));
                }
                return result;
            }
            try (InputStream stream = response.body().byteStream()) {
                byte[] bytes = readBytes(stream, MAX_MODEL_BYTES);
                return result.put("content", new String(bytes, StandardCharsets.UTF_8))
                    .put("downloadedBytes", bytes.length);
            }
        } catch (java.net.SocketTimeoutException timeoutFailure) {
            return new JSONObject().put("error", "provider-timeout").put("confirmed", false);
        } catch (IOException failure) {
            return new JSONObject().put("error", "provider-network").put("confirmed", false);
        } finally {
            ticket.providerCall = null;
            ticket.activity = null;
        }
    }

    private static JSONObject readModelStream(Ticket ticket, BufferedSource source) throws Exception {
        ticket.kernel.call("startModelStream", ticket.protocol);
        StringBuilder event = new StringBuilder();
        String failure = "provider-network";
        long progressAt = SystemClock.elapsedRealtime();
        int bytes = 0;
        try {
            while (!source.exhausted()) {
                String line = source.readUtf8LineStrict(MAX_MODEL_BYTES);
                bytes += line.getBytes(StandardCharsets.UTF_8).length + 1;
                if (bytes > MAX_MODEL_BYTES) { failure = "provider-stream"; break; }
                if (line.startsWith("data:")) {
                    if (event.length() > 0) event.append('\n');
                    event.append(line.substring(5));
                } else if (line.isEmpty() && event.length() > 0) {
                    String phase = ticket.kernel.call("readModelEvent", event.toString().trim());
                    event.setLength(0);
                    if ("complete".equals(phase)) break;
                    if (!phase.isEmpty()) {
                        progressAt = SystemClock.elapsedRealtime();
                        ticket.renewWake();
                        ModelActivity previous = ticket.activity;
                        long now = System.currentTimeMillis();
                        if (previous == null || !phase.equals(previous.phase()) || now - previous.updatedAt() >= 1_000) {
                            ticket.activity = new ModelActivity(phase, now);
                        }
                    }
                }
                if (SystemClock.elapsedRealtime() - progressAt >= MODEL_IDLE_MS) {
                    failure = "provider-timeout";
                    break;
                }
            }
        } catch (java.net.SocketTimeoutException stalled) {
            failure = "provider-timeout";
        } catch (IOException disconnected) {
            failure = "provider-network";
        } catch (RuntimeException invalid) {
            failure = "provider-stream";
        }
        JSONObject result = new JSONObject(ticket.kernel.call("finishModelStream", failure));
        return result.put("downloadedBytes", bytes);
    }

    private static long retryAt(JSONObject headers) {
        long now = System.currentTimeMillis();
        long until = now;
        if (headers != null) {
            String after = headers.optString("retryAfter");
            if (after.matches("[0-9]{1,9}")) {
                until = Math.max(until, now + Long.parseLong(after) * 1000);
            } else {
                try {
                    Date date = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss z", Locale.US).parse(after);
                    if (date != null) until = Math.max(until, date.getTime());
                } catch (Exception ignored) {
                    // Resume time is advisory. An invalid header uses bounded backoff.
                }
            }
            String reset = headers.optString("rateReset");
            if ("0".equals(headers.optString("rateRemaining")) && reset.matches("[0-9]{1,12}")) {
                until = Math.max(until, Long.parseLong(reset) * 1000);
            }
        }
        return until > now ? Math.min(until, now + 7 * 24 * 60 * 60_000L) : now + 60_000;
    }

    private static JSONObject requestPublic(Ticket ticket, String url, boolean raw, long timeout) throws Exception {
        HttpUrl target = HttpUrl.parse(url);
        boolean github = target != null && "api.github.com".equals(target.host());
        if (github && ticket.githubRetryAt > System.currentTimeMillis()) {
            return new JSONObject().put("error", "rate-limit").put("retryAt", ticket.githubRetryAt);
        }
        if (ticket.publicAttempts >= PUBLIC_ATTEMPTS) {
            return new JSONObject().put("error", "read-budget");
        }
        ticket.publicAttempts++;
        PublicWebPlugin.Transfer transfer = new PublicWebPlugin.Transfer();
        ticket.publicCall = transfer;
        if (ticket.stop.get() != null) transfer.cancel();
        try {
            JSObject fetched = PublicWebPlugin.fetch(
                url, raw, false, SystemClock.elapsedRealtime() + timeout, transfer
            );
            int status = fetched.optInt("status");
            JSONObject result = new JSONObject().put("status", status);
            if (fetched.has("error")) return result.put("error", fetched.optString("error"));
            if (status < 200 || status >= 300) {
                JSONObject headers = fetched.optJSONObject("headers");
                boolean limited = status == 429 || (status == 403 && headers != null &&
                    ("0".equals(headers.optString("rateRemaining")) || headers.has("retryAfter")));
                if (limited) {
                    long until = retryAt(headers);
                    if (github) ticket.githubRetryAt = until;
                    return result.put("error", "rate-limit").put("retryAt", until);
                }
                return result.put("error", "public-http");
            }
            String type = fetched.optString("contentType");
            String encoded = fetched.optString("bytes");
            if (encoded.isEmpty()) return result.put("error", "public-empty");
            Matcher charset = CHARSET.matcher(type);
            Charset decoding = StandardCharsets.UTF_8;
            if (charset.find()) {
                try {
                    decoding = Charset.forName(charset.group(1));
                } catch (IllegalArgumentException ignored) {
                    // Default to UTF-8 when a public endpoint declares an unknown charset.
                }
            }
            byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
            result.put("url", fetched.optString("url")).put("type", type)
                .put("downloadedBytes", bytes.length)
                .put("truncated", fetched.optBoolean("truncated"))
                .put("content", new String(bytes, decoding));
            JSONObject headers = fetched.optJSONObject("headers");
            Matcher next = NEXT.matcher(headers != null ? headers.optString("link") : "");
            if (next.find()) {
                HttpUrl link = HttpUrl.parse(next.group(1));
                HttpUrl source = HttpUrl.parse(url);
                if (link != null && source != null && "api.github.com".equals(link.host())
                    && "api.github.com".equals(source.host())) {
                    String page = link.queryParameter("page");
                    String current = source.queryParameter("page");
                    if (page != null && page.matches("[1-9][0-9]{0,3}")
                        && current != null && current.matches("[1-9][0-9]{0,3}")
                        && Integer.parseInt(page) == Integer.parseInt(current) + 1
                        && Integer.parseInt(page) <= 1000) {
                        result.put("nextPage", "p" + page);
                    }
                }
            }
            return result;
        } catch (IOException | IllegalArgumentException failure) {
            return new JSONObject().put("error", PublicWebPlugin.fetchError(transfer, failure));
        } finally {
            ticket.publicCall = null;
        }
    }
}
