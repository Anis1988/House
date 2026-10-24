package com.claude.house;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Your own scenes and the timers that run any scene at a time of day on chosen days.
 * Kept here (not only in the page) so a timer can run with the app closed.
 *
 * Scene: { id, name, icon, lights: { <bulb id>: { mode, bri, kelvin?, hue?, sat? } } }
 * Timer: { id, scene: "custom:<id>" | "bright" | "movie" | "night" | "off" | "on",
 *          minutes (after midnight), days: [1-7, Calendar.SUNDAY = 1], fade (seconds), on }
 */
final class SceneTimers {
    static final String ACTION = "com.claude.house.SCENE_TIMER";

    private SceneTimers() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(Lifx.PREFS, Context.MODE_PRIVATE);
    }

    static JSONArray scenes(Context ctx) { return array(ctx, "scenes"); }
    static JSONArray timers(Context ctx) { return array(ctx, "timers"); }

    private static JSONArray array(Context ctx, String key) {
        try {
            return new JSONArray(prefs(ctx).getString(key, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    static void saveScenes(Context ctx, JSONArray scenes) {
        prefs(ctx).edit().putString("scenes", scenes.toString()).apply();
    }

    static void saveTimers(Context ctx, JSONArray timers) {
        prefs(ctx).edit().putString("timers", timers.toString()).apply();
        schedule(ctx);
    }

    static JSONObject findScene(Context ctx, String id) {
        JSONArray all = scenes(ctx);
        for (int i = 0; i < all.length(); i++) {
            JSONObject s = all.optJSONObject(i);
            if (s != null && id.equals(s.optString("id"))) return s;
        }
        return null;
    }

    /** Runs a scene by its timer name: "custom:<id>" or a built-in. */
    static void run(Context ctx, String which, int fadeMs) {
        if (which.startsWith("custom:")) {
            JSONObject s = findScene(ctx, which.substring(7));
            if (s != null) Lifx.runCustom(ctx, s, fadeMs);
        } else {
            Lifx.scene(ctx, which, fadeMs);
        }
    }

    /** When a timer next fires (epoch ms) after `after`, or 0 if it's off or has no days. */
    static long nextFire(JSONObject t, long after) {
        if (!t.optBoolean("on", true)) return 0;
        JSONArray days = t.optJSONArray("days");
        boolean every = days == null || days.length() == 0;
        int m = t.optInt("minutes", 0);
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(after);
        c.set(Calendar.HOUR_OF_DAY, m / 60);
        c.set(Calendar.MINUTE, m % 60);
        c.set(Calendar.SECOND, 0);
        c.set(Calendar.MILLISECOND, 0);
        for (int i = 0; i < 8; i++) {
            if (c.getTimeInMillis() > after && (every || has(days, c.get(Calendar.DAY_OF_WEEK)))) return c.getTimeInMillis();
            c.add(Calendar.DAY_OF_MONTH, 1);
        }
        return 0;
    }

    private static boolean has(JSONArray a, int v) {
        for (int i = 0; i < a.length(); i++) if (a.optInt(i) == v) return true;
        return false;
    }

    private static PendingIntent intent(Context ctx) {
        Intent i = new Intent(ctx, ActionReceiver.class).setAction(ACTION);
        return PendingIntent.getBroadcast(ctx, 3, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * One alarm for the earliest timer. The ids due at that moment are saved, so the run still
     * happens if the alarm fires a little late. Called on change, after each run, at boot.
     */
    static long schedule(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        PendingIntent pi = intent(ctx);
        am.cancel(pi);
        JSONArray all = timers(ctx);
        long now = System.currentTimeMillis(), best = 0;
        JSONArray due = new JSONArray();
        for (int i = 0; i < all.length(); i++) {
            JSONObject t = all.optJSONObject(i);
            if (t == null) continue;
            long at = nextFire(t, now);
            if (at == 0) continue;
            if (best == 0 || at < best) { best = at; due = new JSONArray(); }
            if (at == best) due.put(t.optString("id"));
        }
        prefs(ctx).edit().putLong("timerAt", best).putString("timerDue", due.toString()).apply();
        if (best == 0) return 0;
        if (android.os.Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, best, pi);
        } else {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, best, pi);
        }
        return best;
    }

    /** The alarm went off: run the timers that were due, then arm the next one. Blocking. */
    static void fire(Context ctx) {
        List<JSONObject> run = new ArrayList<>();
        try {
            JSONArray due = new JSONArray(prefs(ctx).getString("timerDue", "[]"));
            JSONArray all = timers(ctx);
            for (int i = 0; i < all.length(); i++) {
                JSONObject t = all.optJSONObject(i);
                if (t == null || !t.optBoolean("on", true)) continue;
                for (int j = 0; j < due.length(); j++) if (due.optString(j).equals(t.optString("id"))) run.add(t);
            }
        } catch (JSONException ignored) {}
        if (!run.isEmpty()) {
            // Fresh addresses and on/off state first, so fades start from what the bulbs really show.
            Lifx.scan(ctx, 1500, null);
            for (JSONObject t : run) run(ctx, t.optString("scene"), t.optInt("fade", 0) * 1000);
        }
        schedule(ctx);
    }
}
