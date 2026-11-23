package app.freeseek.chat;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.PersistableBundle;
import java.util.UUID;

/** Inexact, durable reminders. Opening one returns to the saved Agent conversation. */
public final class AgentReminderService extends JobService {
    private static final String CHANNEL = "freeseek-agent-reminders";
    private static final String ROUTE = "app.freeseek.chat.REMIND_AGENT";
    private static final long DAILY_MS = 86_400_000L;

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences("agent-reminders", Context.MODE_PRIVATE);
    }

    static synchronized int code(Context context, String session) {
        SharedPreferences state = preferences(context);
        int id = state.getInt("job:" + session, 0);
        if (id != 0) return id;
        int next = state.getInt("next", 20_000) + 1;
        state.edit().putInt("next", next).putInt("job:" + session, next).apply();
        return next;
    }

    static boolean notifications(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        return manager != null && manager.areNotificationsEnabled()
                && (Build.VERSION.SDK_INT < 33
                    || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED);
    }

    static synchronized boolean schedule(Context context, String session, long at, boolean repeat, boolean chinese) {
        PersistableBundle args = new PersistableBundle();
        args.putString("session", session);
        args.putLong("at", at);
        args.putBoolean("repeat", repeat);
        args.putBoolean("zh", chinese);
        int id = code(context, session);
        JobInfo job = new JobInfo.Builder(id, new ComponentName(context, AgentReminderService.class))
                .setMinimumLatency(Math.max(0L, at - System.currentTimeMillis()))
                .setPersisted(true).setExtras(args).build();
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        return scheduler != null && scheduler.schedule(job) == JobScheduler.RESULT_SUCCESS;
    }

    static JobInfo pending(Context context, String session) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        int id = preferences(context).getInt("job:" + session, 0);
        return id == 0 || scheduler == null ? null : scheduler.getPendingJob(id);
    }

    static synchronized void cancel(Context context, String session) {
        int id = preferences(context).getInt("job:" + session, 0);
        if (id != 0) {
            JobScheduler scheduler = context.getSystemService(JobScheduler.class);
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (scheduler != null) scheduler.cancel(id);
            if (manager != null) manager.cancel(id);
        }
        preferences(context).edit().remove("job:" + session).remove("route:" + session).apply();
    }

    static synchronized void cancelAll(Context context) {
        for (String key : preferences(context).getAll().keySet()) {
            if (key.startsWith("job:")) cancel(context, key.substring(4));
        }
    }

    static synchronized String consume(Context context, Intent intent) {
        if (intent == null || !ROUTE.equals(intent.getAction())) return null;
        String session = intent.getStringExtra("agentSession");
        String token = intent.getStringExtra("agentToken");
        if (!WorkspaceFilesPlugin.token(session) || !WorkspaceFilesPlugin.token(token)) return null;
        SharedPreferences state = preferences(context);
        if (!token.equals(state.getString("route:" + session, ""))) return null;
        state.edit().remove("route:" + session).apply();
        return session;
    }

    @Override public boolean onStartJob(JobParameters params) {
        synchronized (AgentReminderService.class) {
            deliver(params);
        }
        return false;
    }

    private void deliver(JobParameters params) {
        PersistableBundle input = params.getExtras();
        String session = input.getString("session");
        if (!WorkspaceFilesPlugin.token(session)
                || preferences(this).getInt("job:" + session, 0) != params.getJobId()) return;
        boolean chinese = input.getBoolean("zh");
        if (notifications(this)) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                Notification.Builder builder;
                if (Build.VERSION.SDK_INT >= 26) {
                    manager.createNotificationChannel(new NotificationChannel(
                            CHANNEL, chinese ? "Agent 任务提醒" : "Agent task reminders", NotificationManager.IMPORTANCE_DEFAULT));
                    builder = new Notification.Builder(this, CHANNEL);
                } else {
                    builder = new Notification.Builder(this);
                }
                String token = UUID.randomUUID().toString();
                preferences(this).edit().putString("route:" + session, token).apply();
                Intent open = new Intent(this, MainActivity.class).setAction(ROUTE)
                        .putExtra("agentSession", session).putExtra("agentToken", token);
                PendingIntent click = PendingIntent.getActivity(this, params.getJobId(), open,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                Notification message = builder
                        .setSmallIcon(android.R.drawable.ic_dialog_info)
                        .setContentTitle(chinese ? "可以继续 Agent 任务了" : "Your Agent task is ready to resume")
                        .setContentText(chinese ? "点这里回到对话" : "Open the conversation")
                        .setContentIntent(click).setAutoCancel(true).build();
                manager.notify(params.getJobId(), message);
            }
        }
        if (input.getBoolean("repeat")) {
            long at = input.getLong("at") + DAILY_MS;
            while (at <= System.currentTimeMillis()) at += DAILY_MS;
            long next = at;
            new android.os.Handler(getMainLooper()).post(() -> {
                synchronized (AgentReminderService.class) {
                    if (preferences(this).getInt("job:" + session, 0) != params.getJobId()) return;
                    JobInfo current = pending(this, session);
                    if (current != null && current.getExtras().getLong("at") > input.getLong("at")) return;
                    try { schedule(this, session, next, true, chinese); }
                    catch (IllegalStateException ignored) {}
                }
            });
        }
    }

    @Override public boolean onStopJob(JobParameters params) { return false; }
}
