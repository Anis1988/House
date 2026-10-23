package com.claude.house;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import java.util.Calendar;

/** Daily "Bedtime": turns every light off at a chosen time, through an exact alarm. */
final class Bedtime {
    static final String ACTION = "com.claude.house.BEDTIME";

    private Bedtime() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(Lifx.PREFS, Context.MODE_PRIVATE);
    }

    static boolean enabled(Context ctx) {
        return prefs(ctx).getBoolean("bedtimeOn", false);
    }

    /** Minutes after midnight; defaults to 11:30 PM. */
    static int minutes(Context ctx) {
        return prefs(ctx).getInt("bedtimeAt", 23 * 60 + 30);
    }

    static void set(Context ctx, boolean on, int minutes) {
        prefs(ctx).edit().putBoolean("bedtimeOn", on).putInt("bedtimeAt", minutes).apply();
        schedule(ctx);
    }

    /** Next run (epoch ms), or 0 when off. */
    static long next(Context ctx) {
        if (!enabled(ctx)) return 0;
        int m = minutes(ctx);
        Calendar c = Calendar.getInstance();
        c.set(Calendar.HOUR_OF_DAY, m / 60);
        c.set(Calendar.MINUTE, m % 60);
        c.set(Calendar.SECOND, 0);
        c.set(Calendar.MILLISECOND, 0);
        if (c.getTimeInMillis() <= System.currentTimeMillis() + 30_000) c.add(Calendar.DAY_OF_MONTH, 1);
        return c.getTimeInMillis();
    }

    /** (Re)arms the next run; called on change, after each run, at boot and on app start. */
    static void schedule(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        Intent i = new Intent(ctx, ActionReceiver.class).setAction(ACTION);
        PendingIntent pi = PendingIntent.getBroadcast(ctx, 1, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        am.cancel(pi);
        long at = next(ctx);
        if (at == 0) return;
        // Exact when the phone allows it (USE_EXACT_ALARM on Android 13+), otherwise close to it.
        if (android.os.Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        } else {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        }
    }
}
