package app.freeseek.chat;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;

/** Presents the current phase of user-started work without sharing conversation content. */
final class LiveTaskProgress {
    private static final String PREFERENCES = "freeseek-notification-preferences";
    private static final String ENABLED = "live-progress";
    private static final String REPLY = "reply";
    private static final String GOAL = "goal";
    static final long REFRESH_INTERVAL_MS = 750L;

    enum Phase {
        WAITING("等待中", "Waiting", "正在等待模型", "Waiting for the model"),
        THINKING("思考中", "Think", "模型正在思考", "Model is thinking"),
        ATTACHMENTS("读附件", "Files", "正在准备附件", "Preparing attachments"),
        COMPRESSING("压缩中", "Context", "正在压缩聊天历史", "Compressing chat history"),
        SEARCHING("查资料", "Search", "正在搜索资料", "Searching for information"),
        READING("阅读中", "Read", "正在读取资料", "Reading sources"),
        WORKING("执行中", "Running", "正在执行任务", "Working on the task"),
        SAVING("保存中", "Saving", "正在保存成果", "Saving the result"),
        WRITING("生成中", "Writing", "正在生成回复", "Writing the reply");

        final String shortZh, shortEn, detailZh, detailEn;

        Phase(String shortZh, String shortEn, String detailZh, String detailEn) {
            this.shortZh = shortZh;
            this.shortEn = shortEn;
            this.detailZh = detailZh;
            this.detailEn = detailEn;
        }

        static Phase fromWire(String key) {
            if (key == null) return null;
            return switch (key) {
                case "waiting" -> WAITING;
                case "thinking" -> THINKING;
                case "attachments" -> ATTACHMENTS;
                case "compressing" -> COMPRESSING;
                case "searching" -> SEARCHING;
                case "reading" -> READING;
                case "working", "tool-input" -> WORKING;
                case "saving" -> SAVING;
                case "writing" -> WRITING;
                default -> null;
            };
        }
    }

    record State(Phase phase, int step, int total) {
        static State of(Phase phase, int step, int total) {
            boolean hasStep = step > 0 && step <= total && total <= 999;
            return new State(phase, hasStep ? step : 0, hasStep ? total : 0);
        }

        State withPhase(Phase next) { return new State(next, step, total); }

        String chip(boolean chinese) {
            return step > 0 ? step + "/" + total : (chinese ? phase.shortZh : phase.shortEn);
        }

        String detail(boolean chinese) {
            String action = chinese ? phase.detailZh : phase.detailEn;
            if (step == 0) return action;
            return chinese ? "第 " + step + "/" + total + " 步 · " + action
                : "Step " + step + " of " + total + " · " + action;
        }
    }

    static final State WAITING = State.of(Phase.WAITING, 0, 0);
    static final State WORKING = State.of(Phase.WORKING, 0, 0);

    private LiveTaskProgress() {}

    static boolean supported() {
        return Build.VERSION.SDK_INT >= 36 && Build.VERSION.SDK_INT_FULL >= Build.VERSION_CODES_FULL.BAKLAVA_1;
    }

    static boolean enabled(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getBoolean(ENABLED, true);
    }

    static boolean saveEnabled(Context context, boolean enabled) {
        SharedPreferences preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        boolean previous = preferences.getBoolean(ENABLED, true);
        if (previous == enabled || preferences.edit().putBoolean(ENABLED, enabled).commit()) return true;
        preferences.edit().putBoolean(ENABLED, previous).apply();
        return false;
    }

    static boolean permitted(Context context) {
        if (!supported() || !TaskNotifications.permitted(context)) return false;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        try { return manager != null && manager.canPostPromotedNotifications(); }
        catch (SecurityException unavailable) { return false; }
    }

    static boolean showOutsideApp(Context context) {
        return supported() && !TaskNotifications.appVisible && enabled(context) && permitted(context);
    }

    static void refreshNotifications() {
        BackgroundReplyService.presentationChanged();
        AgentGoalService.presentationChanged();
    }

    static void decorate(Context context, Notification.Builder builder, State state,
                         boolean chinese, String workId, boolean goal) {
        if (!supported()) return;
        String owner = goal ? GOAL : REPLY;
        Intent dismiss = new Intent(context, DismissReceiver.class)
            .setData(Uri.parse("freeseek-progress:" + owner + ":" + workId))
            .putExtra("owner", owner)
            .putExtra("work", workId);
        builder.setContentText(state.detail(chinese))
            .setStyle(new Notification.ProgressStyle().setProgressIndeterminate(true))
            .setShortCriticalText(state.chip(chinese))
            .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            .setRequestPromotedOngoing(true)
            .setDeleteIntent(PendingIntent.getBroadcast(context, 0, dismiss, PendingIntent.FLAG_IMMUTABLE));
    }

    public static final class DismissReceiver extends BroadcastReceiver {
        @Override public void onReceive(Context context, Intent intent) {
            if (intent == null) return;
            String work = intent.getStringExtra("work");
            String owner = intent.getStringExtra("owner");
            if (REPLY.equals(owner)) BackgroundReplyService.dismissProgress(work);
            if (GOAL.equals(owner)) AgentGoalService.dismissProgress(work);
        }
    }
}
