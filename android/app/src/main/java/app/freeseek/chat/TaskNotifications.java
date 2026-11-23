package app.freeseek.chat;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import com.getcapacitor.JSObject;
import java.util.UUID;

final class TaskNotifications {
    private static final String ACTION = "app.freeseek.chat.OPEN_TASK_CHAT";
    private static final String RESULTS = "freeseek-task-results";
    private static final int RESULT_ID = 24316;
    static volatile boolean appVisible;
    private static volatile String visibleSession;

    private TaskNotifications() {}

    static boolean validSession(String id) {
        return id != null && !id.trim().isEmpty() && id.length() <= 256
            && id.chars().noneMatch(Character::isISOControl);
    }

    private static SharedPreferences routes(Context context) {
        return context.getSharedPreferences("agent-notification-routes", Context.MODE_PRIVATE);
    }

    private static String routeKey(String kind, String session) { return kind + ":" + session; }

    static PendingIntent open(Context context, String session, String kind) {
        Intent intent = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (validSession(session)) {
            String nonce = UUID.randomUUID().toString();
            // 同步落盘：通知发出后进程可能很快被系统回收，apply 的异步写入会丢，
            // 用户点通知时就找不到这个会话（表现为回到空白的新对话页）。
            routes(context).edit().putString(routeKey(kind, session), nonce).commit();
            intent.setAction(ACTION)
                .setData(Uri.parse("freeseek-task:" + nonce))
                .putExtra("session", session)
                .putExtra("kind", kind)
                .putExtra("nonce", nonce);
        }
        return PendingIntent.getActivity(context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static String consume(Context context, Intent intent) {
        if (intent == null || !ACTION.equals(intent.getAction())) return null;
        String session = intent.getStringExtra("session");
        String kind = intent.getStringExtra("kind");
        String nonce = intent.getStringExtra("nonce");
        if (!validSession(session) || nonce == null || !("result".equals(kind) || "reply".equals(kind) || "goal".equals(kind))) {
            return null;
        }
        SharedPreferences receipts = routes(context);
        String key = routeKey(kind, session);
        if (!nonce.equals(receipts.getString(key, null))) {
            DiagnosticsLog.warn(context, "chat", "notice-route.dropped", new JSObject()
                .put("kind", kind).put("reason", "nonce"));
            return null;
        }
        // 收到结果类通知时保留 nonce：用户可能再点一次同一条通知，
        // 不能因为消费过就把它变成无效入口；会话真正打开后由 viewing() 清理。
        return session;
    }

    static void viewing(Context context, String session) {
        visibleSession = validSession(session) ? session : null;
        if (visibleSession != null && appVisible) clearResult(context, visibleSession);
    }

    static void clearResult(Context context, String session) {
        routes(context).edit().remove(routeKey("result", session)).apply();
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(session, RESULT_ID);
    }

    static void forget(Context context, String session) {
        if (session != null) {
            clearResult(context, session);
            routes(context).edit().remove(routeKey("reply", session)).remove(routeKey("goal", session)).apply();
            return;
        }
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) {
            for (String key : routes(context).getAll().keySet()) {
                if (key.startsWith("result:")) manager.cancel(key.substring("result:".length()), RESULT_ID);
            }
        }
        routes(context).edit().clear().apply();
    }

    static boolean permitted(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        return manager != null && manager.areNotificationsEnabled()
            && (Build.VERSION.SDK_INT < 33
                || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED);
    }

    static boolean resultsAllowed(Context context) {
        if (!permitted(context)) return false;
        if (Build.VERSION.SDK_INT < 26) return true;
        NotificationChannel channel = context.getSystemService(NotificationManager.class).getNotificationChannel(RESULTS);
        return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    static Notification.Builder builder(Context context, String channel, String label, int importance) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (manager != null && manager.getNotificationChannel(channel) == null) {
                NotificationChannel config = new NotificationChannel(channel, label, importance);
                config.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
                manager.createNotificationChannel(config);
            }
            return new Notification.Builder(context, channel);
        }
        return new Notification.Builder(context);
    }

    static void result(Context context, String session, boolean agent, boolean chinese, String outcome) {
        if (!validSession(session) || (appVisible && session.equals(visibleSession))) return;
        if (!"completed".equals(outcome) && !"attention".equals(outcome)) return;
        if (!resultsAllowed(context)) {
            DiagnosticsLog.record(context, "chat", "background.notice-skipped",
                new JSObject().put("reason", "notification-permission"));
            return;
        }
        try {
            boolean done = "completed".equals(outcome);
            String title = chinese
                ? (done ? (agent ? "Agent 任务已完成" : "回复已完成") : (agent ? "Agent 任务需要查看" : "回复需要查看"))
                : (done ? (agent ? "Agent task complete" : "Reply ready") : (agent ? "Agent task needs attention" : "Reply needs attention"));
            Notification notice = builder(context, RESULTS, chinese ? "回复与任务结果" : "Replies and task results",
                NotificationManager.IMPORTANCE_DEFAULT)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(title)
                .setContentText(chinese ? "点这里回到原对话" : "Tap to return to the conversation")
                .setContentIntent(open(context, session, "result"))
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setAutoCancel(true)
                .build();
            context.getSystemService(NotificationManager.class).notify(session, RESULT_ID, notice);
            DiagnosticsLog.record(context, "chat", "background.notice-posted", new JSObject().put("status", outcome));
        } catch (RuntimeException failure) {
            DiagnosticsLog.error(context, "chat", "background.notice-failed", failure);
        }
    }
}
