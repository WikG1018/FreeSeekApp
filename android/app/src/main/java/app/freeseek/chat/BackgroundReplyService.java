package app.freeseek.chat;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import java.util.LinkedHashMap;

/** Holds the app while WebView requests are active. The web store still owns their results. */
public final class BackgroundReplyService extends Service {
    private static final String CHANNEL = "freeseek-background-replies";
    private static final int NOTICE_ID = 24314;
    private static final long WAKE_LIMIT = 35 * 60_000L;
    private static final LinkedHashMap<String, Work> active = new LinkedHashMap<>();
    private static BackgroundReplyService instance;
    private PowerManager.WakeLock lock;
    private boolean foreground;

    private record Work(String session, boolean agent, boolean chinese) {}

    // Plugin entry points and service lifecycle callbacks all run on the Android main thread.
    static boolean retain(Context context, String lease, String session, boolean agent, boolean chinese) {
        if (!AgentGoalService.validId(lease) || !TaskNotifications.validSession(session)) return false;
        if (active.containsKey(lease)) return true;
        active.put(lease, new Work(session, agent, chinese));
        try {
            if (instance == null) {
                ContextCompat.startForegroundService(context, new Intent(context, BackgroundReplyService.class));
            } else {
                instance.refresh();
            }
            DiagnosticsLog.record(context, "chat", "background.reply-retained",
                new JSObject().put("count", active.size()).put("agent", agent));
            return true;
        } catch (RuntimeException failure) {
            active.remove(lease);
            DiagnosticsLog.error(context, "chat", "background.reply-retain-failed", failure);
            return false;
        }
    }

    static void finish(Context context, String lease, String outcome) {
        Work work = active.remove(lease);
        if (work == null) return;
        BackgroundReplyService service = instance;
        if (service != null) {
            try { service.refresh(); }
            catch (RuntimeException failure) {
                DiagnosticsLog.error(context, "chat", "background.reply-update-failed", failure);
                service.release();
            }
        }
        TaskNotifications.result(context, work.session(), work.agent(), work.chinese(), outcome);
    }

    static void acknowledgeProgress(String lease) {
        if (active.containsKey(lease) && instance != null && instance.lock != null) {
            instance.lock.acquire(WAKE_LIMIT);
        }
    }

    static void releaseWebView() {
        active.clear();
        if (instance != null) instance.release();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        instance = this;
        try {
            // A very short reply may finish before this callback; acknowledge the foreground start first.
            refresh();
        } catch (RuntimeException failure) {
            DiagnosticsLog.error(this, "chat", "background.reply-start-failed", failure);
            release();
        }
        return START_NOT_STICKY;
    }

    private void refresh() {
        if (active.isEmpty() && foreground) {
            release();
            return;
        }
        Work latest = null;
        for (Work work : active.values()) latest = work;
        boolean chinese = latest != null && latest.chinese();
        String title = latest == null || active.size() > 1
            ? (chinese ? "FreeSeek 正在处理对话" : "FreeSeek is processing conversations")
            : latest.agent()
                ? (chinese ? "Agent 正在执行任务" : "Agent task running")
                : (chinese ? "FreeSeek 正在生成回复" : "FreeSeek is preparing a reply");
        Notification notification = TaskNotifications.builder(this, CHANNEL,
            chinese ? "后台回复与任务" : "Background replies and tasks", NotificationManager.IMPORTANCE_LOW)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(title)
            .setContentText(chinese ? "打开原对话查看进度" : "Open the conversation to view progress")
            .setContentIntent(TaskNotifications.open(this, latest == null ? null : latest.session(), "reply"))
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .build();
        if (foreground) {
            getSystemService(NotificationManager.class).notify(NOTICE_ID, notification);
        } else {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTICE_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTICE_ID, notification);
            }
            foreground = true;
        }
        if (active.isEmpty()) {
            release();
            return;
        }
        PowerManager power = getSystemService(PowerManager.class);
        if (power != null) {
            if (lock == null) {
                lock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, getPackageName() + ":background-reply");
                lock.setReferenceCounted(false);
            }
            lock.acquire(WAKE_LIMIT);
        }
    }

    private void release() {
        if (instance == this) instance = null;
        if (lock != null && lock.isHeld()) lock.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        foreground = false;
        stopSelf();
    }

    @Override public void onTimeout(int startId, int serviceType) {
        DiagnosticsLog.warn(this, "chat", "background.reply-timeout", new JSObject().put("count", active.size()));
        release();
    }

    @Override public void onDestroy() {
        if (instance == this) instance = null;
        if (lock != null && lock.isHeld()) lock.release();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
