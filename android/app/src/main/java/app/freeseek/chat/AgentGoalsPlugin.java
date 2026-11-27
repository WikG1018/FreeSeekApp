package app.freeseek.chat;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.net.Uri;
import android.provider.Settings;
import java.lang.ref.WeakReference;
import android.util.Base64;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.Lifecycle;
import androidx.lifecycle.LifecycleOwner;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

@CapacitorPlugin(name = "AgentGoals", permissions = {
    @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public final class AgentGoalsPlugin extends Plugin {
    private static final int MAX_INPUT_CHARS = 5 * 1024 * 1024;
    private static final int FILE_CHUNK = 48 * 1024;
    private static final ExecutorService BRIDGE = Executors.newFixedThreadPool(2);
    private static volatile WeakReference<AgentGoalsPlugin> listener = new WeakReference<>(null);

    @Override public void load() {
        listener = new WeakReference<>(this);
    }

    @Override protected void handleOnDestroy() {
        if (listener.get() == this) listener.clear();
    }

    static void goalActivityChanged() {
        new Handler(Looper.getMainLooper()).post(() -> {
            AgentGoalsPlugin plugin = listener.get();
            if (plugin != null) plugin.notifyListeners("goalActivity", activeGoalState());
        });
    }

    private static JSObject activeGoalState() {
        String session = AgentGoalService.activeSession();
        return new JSObject().put("sessionId", session == null ? JSONObject.NULL : session);
    }

    @PluginMethod public void activeGoal(PluginCall call) {
        call.resolve(activeGoalState());
    }

    @PluginMethod public void pauseForAccessChange(PluginCall call) {
        AgentGoalService.pauseForAccessChange();
        call.resolve();
    }

    @PluginMethod public void retainReply(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve(new JSObject().put("retained", false));
            return;
        }
        activity.runOnUiThread(() -> {
            Context context = activity.getApplicationContext();
            boolean agent = Boolean.TRUE.equals(call.getBoolean("agent"));
            boolean activityVisible = visible(activity);
            if (!activityVisible) {
                DiagnosticsLog.warn(context, "chat", "background.reply-retain-skipped",
                    new JSObject().put("reason", "not-foreground").put("agent", agent));
            }
            call.resolve(new JSObject().put("liveProgressAvailable", LiveTaskProgress.supported())
                .put("retained", activityVisible && BackgroundReplyService.retain(context, call.getString("lease"),
                    call.getString("sessionId"), agent, Boolean.TRUE.equals(call.getBoolean("chinese")))));
        });
    }

    @PluginMethod public void finishReply(PluginCall call) {
        Context context = getContext().getApplicationContext();
        new Handler(Looper.getMainLooper()).post(() -> {
            BackgroundReplyService.finish(context, call.getString("lease"), call.getString("outcome"));
            call.resolve();
        });
    }

    @PluginMethod public void replyProgress(PluginCall call) {
        LiveTaskProgress.Phase phase = LiveTaskProgress.Phase.fromWire(call.getString("phase"));
        LiveTaskProgress.State progress = phase == null || !LiveTaskProgress.supported() ? null
            : LiveTaskProgress.State.of(phase, call.getInt("step", 0), call.getInt("total", 0));
        new Handler(Looper.getMainLooper()).post(() -> {
            BackgroundReplyService.acknowledgeProgress(call.getString("lease"), progress);
            call.resolve();
        });
    }

    @PluginMethod public void viewingSession(PluginCall call) {
        TaskNotifications.viewing(getContext(), call.getString("sessionId"));
        call.resolve();
    }

    @PluginMethod public void forgetNotices(PluginCall call) {
        String session = call.getString("sessionId");
        if (Boolean.TRUE.equals(call.getBoolean("all")) || TaskNotifications.validSession(session)) {
            TaskNotifications.forget(getContext(), session);
        }
        call.resolve();
    }

    @PluginMethod public void noticeStatus(PluginCall call) {
        Context context = getContext();
        JSObject status = new JSObject().put("granted", TaskNotifications.resultsAllowed(context));
        if (LiveTaskProgress.supported()) status
            .put("liveProgressEnabled", LiveTaskProgress.enabled(context))
            .put("liveProgressAllowed", LiveTaskProgress.permitted(context));
        call.resolve(status);
    }

    @PluginMethod public void setLiveProgress(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null || !LiveTaskProgress.supported()) {
            call.reject("Live progress unavailable");
            return;
        }
        Context context = getContext().getApplicationContext();
        new Handler(Looper.getMainLooper()).post(() -> {
            if (!LiveTaskProgress.saveEnabled(context, enabled)) {
                call.reject("Could not save live progress setting");
                return;
            }
            LiveTaskProgress.refreshNotifications();
            noticeStatus(call);
        });
    }

    /**
     * 仅申请通知权限，不跳系统设置页。
     * 用于「首次安装或升级后」主动弹出系统授权对话框；
     * 用户已明确拒绝（DENIED）时不再骚扰，交给设置页的按钮处理。
     */
    @PluginMethod public void requestNotices(PluginCall call) {
        Activity activity = getActivity();
        if (!visible(activity) || Build.VERSION.SDK_INT < 33) {
            // 33 以下没有运行时权限，直接返回当前状态
            noticeStatus(call);
            return;
        }
        PermissionState state = getPermissionState("notifications");
        if (state == PermissionState.PROMPT || state == PermissionState.PROMPT_WITH_RATIONALE) {
            requestPermissionForAlias("notifications", call, "noticePermission");
            return;
        }
        noticeStatus(call);
    }

    @PluginMethod public void noticeSettings(PluginCall call) {
        Activity activity = getActivity();
        if (!visible(activity)) { noticeStatus(call); return; }
        if (Build.VERSION.SDK_INT >= 33 && (getPermissionState("notifications") == PermissionState.PROMPT
            || getPermissionState("notifications") == PermissionState.PROMPT_WITH_RATIONALE)) {
            requestPermissionForAlias("notifications", call, "noticePermission");
            return;
        }
        try {
            Intent settings = Build.VERSION.SDK_INT >= 26
                ? new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName())
                : new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.parse("package:" + activity.getPackageName()));
            activity.startActivity(settings);
            noticeStatus(call);
        } catch (RuntimeException failure) {
            call.reject("notification settings unavailable");
        }
    }

    @PermissionCallback private void noticePermission(PluginCall call) {
        noticeStatus(call);
    }

    private static boolean visible(Activity activity) {
        return activity != null && !activity.isFinishing() && !activity.isDestroyed()
            && activity instanceof LifecycleOwner
            && ((LifecycleOwner) activity).getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED);
    }

    private void permissionResult(PluginCall call) {
        call.resolve(new JSObject().put("granted", AgentGoalService.notificationsAllowed(getContext())));
    }

    @PluginMethod
    public void permission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && visible(getActivity())
            && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationPermission");
        } else {
            permissionResult(call);
        }
    }

    @PermissionCallback
    private void notificationPermission(PluginCall call) {
        permissionResult(call);
    }

    private static void startResult(PluginCall call, String reason) {
        JSObject response = new JSObject().put("started", reason == null);
        if (reason != null) response.put("reason", reason);
        call.resolve(response);
    }

    @PluginMethod
    public void start(PluginCall call) {
        Activity activity = getActivity();
        Context context = getContext().getApplicationContext();
        String id = call.getString("id", "");
        JSObject wire = call.getObject("wire");
        JSObject input = call.getObject("input");
        boolean resume = Boolean.TRUE.equals(call.getBoolean("resume", false));
        boolean retryUnconfirmed = Boolean.TRUE.equals(call.getBoolean("retryUnconfirmed", false));
        if (!AgentGoalService.validId(id) || wire == null || input == null || input.toString().length() > MAX_INPUT_CHARS) {
            startResult(call, "invalid-request");
            return;
        }
        JSONObject run = input.optJSONObject("run");
        int minutes = run == null ? 0 : run.optInt("budgetMinutes");
        int requests = minutes == 5 ? 12 : minutes == 15 ? 40 : minutes == 30 ? 80 : 0;
        if (run == null || !id.equals(run.optString("id")) || !"goal".equals(run.optString("mode"))
            || requests <= 0 || run.optInt("budgetRequests") != requests
            || input.optJSONObject("body") == null
            || !input.optString("protocol").matches("openai|anthropic|responses|gemini")) {
            startResult(call, "invalid-request");
            return;
        }
        if (!visible(activity)) {
            startResult(call, "foreground-required");
            return;
        }
        AgentGoalService.Wire endpoint;
        try {
            endpoint = AgentGoalService.Wire.read(wire);
        } catch (Exception invalid) {
            startResult(call, "invalid-provider");
            return;
        }
        String session = call.getString("sessionId");
        boolean chinese = Boolean.TRUE.equals(call.getBoolean("chinese"));
        AgentGoalService.Ticket ticket = AgentGoalService.reserve(id, endpoint,
            TaskNotifications.validSession(session) ? session : null, chinese);
        if (ticket == null) {
            startResult(call, "busy");
            return;
        }
        AgentGoalService.schedule(() -> {
            if (ticket.stop.get() != null) {
                AgentGoalService.release(ticket);
                startResult(call, "stopped");
                return;
            }
            String reason;
            try {
                reason = AgentGoalService.prepare(context, ticket, input, resume, retryUnconfirmed);
            } catch (Exception unavailable) {
                // The diagnostics logger extracts bounded exception metadata without retaining its text.
                DiagnosticsLog.error(context, "chat", "agent.goal.prepare-failed", unavailable);
                reason = "engine-unavailable";
            }
            if (reason != null) {
                AgentGoalService.release(ticket);
                startResult(call, reason);
                return;
            }
            activity.runOnUiThread(() -> {
                if (ticket.stop.get() != null) {
                    AgentGoalService.schedule(() -> AgentGoalService.markUnavailable(context, ticket, ticket.stop.get()));
                    startResult(call, "stopped");
                    return;
                }
                String blocked = !visible(activity) ? "foreground-required" : null;
                if (blocked != null) {
                    AgentGoalService.schedule(() -> AgentGoalService.markUnavailable(context, ticket, blocked));
                    startResult(call, blocked);
                    return;
                }
                try {
                    Intent start = new Intent(context, AgentGoalService.class)
                        .setAction(AgentGoalService.ACTION_START)
                        .putExtra(AgentGoalService.EXTRA_ID, id);
                    ContextCompat.startForegroundService(context, start);
                    startResult(call, null);
                } catch (RuntimeException denied) {
                    AgentGoalService.schedule(() ->
                        AgentGoalService.markUnavailable(context, ticket, "system-timeout")
                    );
                    startResult(call, "system-timeout");
                }
            });
        });
    }

    @PluginMethod
    public void pendingTool(PluginCall call) {
        String id = call.getString("id", "");
        Context context = getContext().getApplicationContext();
        BRIDGE.execute(() -> {
            try {
                JSONObject tool = AgentGoalService.pendingTool(context, id);
                JSObject result = new JSObject();
                if (tool != null) result.put("tool", tool);
                call.resolve(result);
            } catch (Exception unavailable) {
                call.reject("Saved step unavailable", "GOAL_TOOL");
            }
        });
    }

    @PluginMethod
    public void snapshot(PluginCall call) {
        String id = call.getString("id", "");
        int offset = call.getInt("offset", 0);
        Context context = getContext().getApplicationContext();
        BRIDGE.execute(() -> {
            try {
                String value = AgentGoalService.validId(id) ? AgentGoalService.snapshot(context, id) : null;
                JSObject result = new JSObject();
                if (value != null) {
                    JSONObject view = AgentGoalStore.open(context).transcriptPage(id, new JSONObject(value), offset);
                    result.put("snapshot", view);
                }
                call.resolve(result);
            } catch (Exception unavailable) {
                call.reject("Agent snapshot unavailable", "GOAL_SNAPSHOT");
            }
        });
    }

    @PluginMethod
    public void control(PluginCall call) {
        String id = call.getString("id", "");
        String action = call.getString("action", "");
        if (!AgentGoalService.validId(id) || !("pause".equals(action) || "end".equals(action))) {
            call.resolve(new JSObject().put("changed", false));
            return;
        }
        Context context = getContext().getApplicationContext();
        AgentGoalService.Ticket pending = AgentGoalService.control(id, action);
        BRIDGE.execute(() -> {
            boolean changed;
            try {
                changed = pending == null ? AgentGoalService.stopInactive(context, id, action)
                    : pending.settled.get(10, TimeUnit.SECONDS);
            } catch (Exception unconfirmed) {
                changed = false;
            }
            call.resolve(new JSObject().put("changed", changed));
        });
    }

    @PluginMethod
    public void forget(PluginCall call) {
        String id = call.getString("id");
        boolean all = Boolean.TRUE.equals(call.getBoolean("all"));
        Context context = getContext().getApplicationContext();
        if ((all ? call.getData().has("id") : !AgentGoalService.validId(id))
            || !AgentGoalService.beginForget(id)) {
            call.resolve(new JSObject().put("deleted", false));
            return;
        }
        Runnable retire = () -> {
            boolean deleted;
            try {
                deleted = AgentGoalService.forget(context, id);
            } catch (Exception unavailable) {
                DiagnosticsLog.error(context, "chat", "agent.goal.native-forget-failed", unavailable);
                deleted = false;
            }
            call.resolve(new JSObject().put("deleted", deleted));
        };
        if (AgentGoalService.forgetWaitsForWorker(id)) AgentGoalService.schedule(retire);
        else BRIDGE.execute(retire);
    }

    @PluginMethod
    public void file(PluginCall call) {
        String id = call.getString("id", "");
        String fileId = call.getString("fileId", "");
        Integer offset = call.getInt("offset", 0);
        if (!AgentGoalService.validId(id) || !fileId.matches("[A-Za-z0-9_-]{1,120}")
            || offset == null || offset < 0 || offset > AgentGoalStore.MAX_FILE_BYTES) {
            call.reject("Invalid Agent artifact request", "INVALID_ARTIFACT");
            return;
        }
        Context context = getContext().getApplicationContext();
        BRIDGE.execute(() -> {
            try {
                AgentGoalStore.Artifact result = AgentGoalStore.open(context).artifact(id, fileId, true);
                if (result == null || !result.file().isFile() || result.file().length() != result.size()
                    || offset > result.size()) throw new IOException("Agent artifact unavailable");
                int count = (int) Math.min(FILE_CHUNK, result.size() - offset);
                byte[] data = new byte[count];
                try (RandomAccessFile stream = new RandomAccessFile(result.file(), "r")) {
                    stream.seek(offset);
                    stream.readFully(data);
                }
                JSObject response = new JSObject().put("base64", Base64.encodeToString(data, Base64.NO_WRAP));
                response.put("nextOffset", offset + count);
                call.resolve(response);
            } catch (Exception unavailable) {
                call.reject("Agent artifact unavailable", "GOAL_ARTIFACT");
            }
        });
    }
}
