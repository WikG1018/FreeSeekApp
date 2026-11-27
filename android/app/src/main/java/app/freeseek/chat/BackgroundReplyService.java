package app.freeseek.chat;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import java.util.LinkedHashMap;
import java.util.Objects;

/** Holds the app while WebView requests are active. The web store still owns their results. */
public final class BackgroundReplyService extends Service {
    private static final String CHANNEL = "freeseek-background-replies";
    private static final int NOTICE_ID = 24314;
    private static final long WAKE_LIMIT = 35 * 60_000L;
    private static final LinkedHashMap<String, Work> active = new LinkedHashMap<>();
    private static BackgroundReplyService instance;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable refreshAppearance = this::refreshSafely;
    private PowerManager.WakeLock lock;
    private boolean foreground;
    private Work shownWork;
    private LiveTaskProgress.State shownProgress;
    private int shownCount;
    private long lastPostedAt;

    private static final class Work {
        final String lease;
        final String session;
        final boolean agent;
        final boolean chinese;
        LiveTaskProgress.State progress = LiveTaskProgress.WAITING;
        PendingIntent open;
        boolean dismissed;

        Work(String lease, String session, boolean agent, boolean chinese) {
            this.lease = lease;
            this.session = session;
            this.agent = agent;
            this.chinese = chinese;
        }
    }

    // Plugin entry points and service lifecycle callbacks all run on the Android main thread.
    static boolean retain(Context context, String lease, String session, boolean agent, boolean chinese) {
        if (!AgentGoalService.validId(lease) || !TaskNotifications.validSession(session)) return false;
        if (active.containsKey(lease)) return true;
        active.put(lease, new Work(lease, session, agent, chinese));
        try {
            if (instance == null) {
                ContextCompat.startForegroundService(context, new Intent(context, BackgroundReplyService.class));
            } else {
                instance.refresh();
            }
            TaskNotifications.clearResult(context, session);
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
        TaskNotifications.result(context, work.session, work.agent, work.chinese, outcome);
    }

    static void acknowledgeProgress(String lease, LiveTaskProgress.State progress) {
        Work work = active.get(lease);
        if (work == null) return;
        BackgroundReplyService service = instance;
        if (service != null && service.lock != null) service.lock.acquire(WAKE_LIMIT);
        if (progress != null && !progress.equals(work.progress)) {
            work.progress = progress;
            if (service != null && !work.dismissed && !TaskNotifications.appVisible && service.shownWork == work) {
                long elapsed = SystemClock.elapsedRealtime() - service.lastPostedAt;
                service.main.removeCallbacks(service.refreshAppearance);
                service.main.postDelayed(service.refreshAppearance, Math.max(0, LiveTaskProgress.REFRESH_INTERVAL_MS - elapsed));
            }
        }
    }

    static void presentationChanged() {
        if (instance != null && LiveTaskProgress.supported()) instance.refreshSafely();
    }

    static void dismissProgress(String lease) {
        Work work = active.get(lease);
        if (work == null) return;
        work.dismissed = true;
        if (instance != null && instance.shownWork == work) instance.shownProgress = null;
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

    private void refreshSafely() {
        try { refresh(); }
        catch (RuntimeException failure) {
            DiagnosticsLog.error(this, "chat", "background.reply-progress-failed", failure);
        }
    }

    private void refresh() {
        main.removeCallbacks(refreshAppearance);
        if (active.isEmpty() && foreground) {
            release();
            return;
        }
        Work latest = null;
        for (Work work : active.values()) latest = work;
        LiveTaskProgress.State progress = null;
        long now = SystemClock.elapsedRealtime();
        if (latest != null && !latest.dismissed && LiveTaskProgress.showOutsideApp(this)) {
            progress = latest.progress;
        }
        if (foreground && shownWork == latest && shownCount == active.size() && Objects.equals(shownProgress, progress)) return;

        boolean chinese = latest != null && latest.chinese;
        String title = progress != null
            ? (latest.agent ? (chinese ? "Agent 任务" : "Agent task") : (chinese ? "FreeSeek 回复" : "FreeSeek reply"))
            : latest == null || active.size() > 1
            ? (chinese ? "FreeSeek 正在处理对话" : "FreeSeek is processing conversations")
            : latest.agent
                ? (chinese ? "Agent 正在执行任务" : "Agent task running")
                : (chinese ? "FreeSeek 正在生成回复" : "FreeSeek is preparing a reply");
        if (latest != null && latest.open == null) latest.open = TaskNotifications.open(this, latest.session, "reply");
        Notification.Builder builder = TaskNotifications.builder(this, CHANNEL,
            chinese ? "后台回复与任务" : "Background replies and tasks", NotificationManager.IMPORTANCE_LOW)
            .setSmallIcon(R.drawable.freeseek_notification_mark)
            .setContentTitle(title)
            .setContentText(chinese ? "打开原对话查看进度" : "Open the conversation to view progress")
            .setContentIntent(latest == null ? TaskNotifications.open(this, null, "reply") : latest.open)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setOnlyAlertOnce(true)
            .setOngoing(true);
        if (progress != null) LiveTaskProgress.decorate(this, builder, progress, chinese, latest.lease, false);
        Notification notification = builder.build();
        if (foreground) {
            getSystemService(NotificationManager.class).notify(NOTICE_ID, notification);
        } else {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTICE_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTICE_ID, notification);
            }
            foreground = true;
            DiagnosticsLog.record(this, "chat", "background.reply-service-started",
                new JSObject().put("count", active.size()).put("appVisible", TaskNotifications.appVisible));
        }
        if (progress != null && (shownProgress == null || shownWork != latest)) {
            DiagnosticsLog.record(this, "chat", "background.reply-live-requested",
                new JSObject().put("agent", latest.agent).put("phase", progress.phase().name()));
        }
        shownWork = latest;
        shownCount = active.size();
        shownProgress = progress;
        lastPostedAt = now;
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
        main.removeCallbacks(refreshAppearance);
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
        main.removeCallbacks(refreshAppearance);
        if (instance == this) instance = null;
        if (lock != null && lock.isHeld()) lock.release();
        DiagnosticsLog.record(this, "chat", "background.reply-service-ended",
            new JSObject().put("count", active.size()).put("appVisible", TaskNotifications.appVisible));
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
