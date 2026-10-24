package com.claude.house;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;
import java.util.TimeZone;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * House scenes and the timers that run them, kept here (not only in the page) so a timer can run
 * with the app closed.
 *
 * Scene: { id, name, icon, lights: { <bulb id> | "*": { mode, bri, kelvin?, hue?, sat? } },
 *          tv?, screen?, nest?, cams? }  (device parts: see HouseActions)
 * Timer: { id, scene: "custom:<id>", when: "time"|"sunrise"|"sunset", minutes (after midnight, for
 *          "time"), offset (minutes, for sun times), days: [1-7, Calendar.SUNDAY = 1], fade (s), on }
 */
final class SceneTimers {
    static final String ACTION = "com.claude.house.SCENE_TIMER";

    private SceneTimers() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(Lifx.PREFS, Context.MODE_PRIVATE);
    }

    // The scenes the app starts with. They're ordinary scenes: edit or delete them like your own.
    private static JSONArray builtIns() {
        try {
            return new JSONArray()
                .put(builtIn("bright", "Bright", "sun", new JSONObject().put("mode", "on").put("bri", 100).put("kelvin", 4000)))
                .put(builtIn("movie", "Movie", "tv", new JSONObject().put("mode", "on").put("bri", 12).put("kelvin", 2200)))
                .put(builtIn("night", "Night light", "moon", new JSONObject().put("mode", "on").put("bri", 3).put("kelvin", 1500)))
                .put(builtIn("off", "All off", "power", new JSONObject().put("mode", "off")));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    private static JSONObject builtIn(String id, String name, String icon, JSONObject every) throws JSONException {
        return new JSONObject().put("id", id).put("name", name).put("icon", icon).put("lights", new JSONObject().put("*", every));
    }

    /** Your scenes; the first time, the built-in ones go in front of any you already made. */
    static JSONArray scenes(Context ctx) {
        JSONArray mine = array(ctx, "scenes");
        if (!prefs(ctx).getBoolean("scenesSeeded", false)) {
            mine = withBuiltIns(mine);
            prefs(ctx).edit().putBoolean("scenesSeeded", true).putString("scenes", mine.toString()).apply();
        }
        return mine;
    }

    /** Adds back any built-in scene that's missing (Settings → Bring back built-in scenes). */
    static JSONArray restoreBuiltIns(Context ctx) {
        JSONArray all = withBuiltIns(array(ctx, "scenes"));
        saveScenes(ctx, all);
        return all;
    }

    private static JSONArray withBuiltIns(JSONArray mine) {
        JSONArray out = new JSONArray();
        JSONArray b = builtIns();
        for (int i = 0; i < b.length(); i++) if (find(mine, b.optJSONObject(i).optString("id")) == null) out.put(b.optJSONObject(i));
        for (int i = 0; i < mine.length(); i++) out.put(mine.optJSONObject(i));
        return out;
    }

    static JSONArray timers(Context ctx) { return array(ctx, "timers"); }

    private static JSONArray array(Context ctx, String key) {
        try {
            return new JSONArray(prefs(ctx).getString(key, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    static void saveScenes(Context ctx, JSONArray scenes) {
        prefs(ctx).edit().putBoolean("scenesSeeded", true).putString("scenes", scenes.toString()).apply();
    }

    static void saveTimers(Context ctx, JSONArray timers) {
        prefs(ctx).edit().putString("timers", timers.toString()).apply();
        schedule(ctx);
    }

    private static JSONObject find(JSONArray all, String id) {
        for (int i = 0; i < all.length(); i++) {
            JSONObject s = all.optJSONObject(i);
            if (s != null && id.equals(s.optString("id"))) return s;
        }
        return null;
    }

    /** Runs a whole house scene: lights first, then the other devices. Blocking. Returns what failed. */
    static List<String> runScene(Context ctx, JSONObject scene, int fadeMs) {
        List<String> failed = new ArrayList<>();
        if (scene.optJSONObject("lights") != null) {
            // Away from the home Wi-Fi the bulbs can't be reached directly: use the LIFX cloud if set up.
            String token = HouseActions.creds(ctx).optString("lifxToken");
            if (!Presence.atHome(ctx) && !token.isEmpty()) {
                try {
                    LifxCloud.run(token, scene, fadeMs);
                } catch (Exception e) {
                    failed.add("Lights");
                }
            } else if (!Lifx.runCustom(ctx, scene, fadeMs)) {
                failed.add("Lights");
            }
        }
        failed.addAll(HouseActions.run(ctx, scene));
        return failed;
    }

    /** Runs a scene by its timer name: "custom:<id>", or an older timer's built-in name. */
    static void run(Context ctx, String which, int fadeMs) {
        String id = which.startsWith("custom:") ? which.substring(7) : which;
        JSONObject s = find(scenes(ctx), id);
        if (s != null) runScene(ctx, s, fadeMs);
        else if (!which.startsWith("custom:")) Lifx.scene(ctx, which, fadeMs);
    }

    // ---- Sunrise / sunset ----

    static void setLocation(Context ctx, double lat, double lon) {
        prefs(ctx).edit().putFloat("lat", (float) lat).putFloat("lon", (float) lon).putBoolean("hasLocation", true).apply();
        schedule(ctx);
    }

    /**
     * Sunrise or sunset (epoch ms) on the given local day, or 0 if the sun doesn't rise/set there
     * that day. The usual almanac formula (zenith 90.833°), good to a minute or two.
     */
    static long sunTime(Calendar localDay, double lat, double lon, boolean rise) {
        int n = localDay.get(Calendar.DAY_OF_YEAR);
        double lngHour = lon / 15;
        double t = n + ((rise ? 6 : 18) - lngHour) / 24;
        double m = 0.9856 * t - 3.289;
        double l = norm(m + 1.916 * Math.sin(Math.toRadians(m)) + 0.020 * Math.sin(Math.toRadians(2 * m)) + 282.634, 360);
        double ra = norm(Math.toDegrees(Math.atan(0.91764 * Math.tan(Math.toRadians(l)))), 360);
        ra = (ra + Math.floor(l / 90) * 90 - Math.floor(ra / 90) * 90) / 15;
        double sinDec = 0.39782 * Math.sin(Math.toRadians(l));
        double cosDec = Math.cos(Math.asin(sinDec));
        double cosH = (Math.cos(Math.toRadians(90.833)) - sinDec * Math.sin(Math.toRadians(lat))) / (cosDec * Math.cos(Math.toRadians(lat)));
        if (cosH > 1 || cosH < -1) return 0;
        double h = (rise ? 360 - Math.toDegrees(Math.acos(cosH)) : Math.toDegrees(Math.acos(cosH))) / 15;
        double ut = norm(h + ra - 0.06571 * t - 6.622 - lngHour, 24);
        Calendar c = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
        c.clear();
        c.set(localDay.get(Calendar.YEAR), localDay.get(Calendar.MONTH), localDay.get(Calendar.DAY_OF_MONTH));
        long at = c.getTimeInMillis() + Math.round(ut * 3600_000);
        // The UTC hour wraps at midnight: move a day so the result lands on the asked local day.
        Calendar local = Calendar.getInstance(localDay.getTimeZone());
        local.setTimeInMillis(at);
        int diff = dayIndex(localDay) - dayIndex(local);
        return at + diff * 86_400_000L;
    }

    private static int dayIndex(Calendar c) {
        return c.get(Calendar.YEAR) * 400 + c.get(Calendar.DAY_OF_YEAR);
    }

    private static double norm(double v, double max) {
        v %= max;
        return v < 0 ? v + max : v;
    }

    /** When a timer next fires (epoch ms) after `after`, or 0 if it's off. */
    static long nextFire(Context ctx, JSONObject t, long after) {
        if (!t.optBoolean("on", true)) return 0;
        JSONArray days = t.optJSONArray("days");
        boolean every = days == null || days.length() == 0;
        String when = t.optString("when", "time");
        boolean sun = "sunrise".equals(when) || "sunset".equals(when);
        if (sun && !prefs(ctx).getBoolean("hasLocation", false)) return 0;
        double lat = prefs(ctx).getFloat("lat", 0), lon = prefs(ctx).getFloat("lon", 0);
        Calendar day = Calendar.getInstance();
        day.setTimeInMillis(after);
        for (int i = 0; i < 9; i++) {
            if (every || has(days, day.get(Calendar.DAY_OF_WEEK))) {
                long at;
                if (sun) {
                    long s = sunTime(day, lat, lon, "sunrise".equals(when));
                    at = s == 0 ? 0 : s + t.optInt("offset", 0) * 60_000L;
                    at -= at % 60_000; // on the minute
                } else {
                    Calendar c = (Calendar) day.clone();
                    int m = t.optInt("minutes", 0);
                    c.set(Calendar.HOUR_OF_DAY, m / 60);
                    c.set(Calendar.MINUTE, m % 60);
                    c.set(Calendar.SECOND, 0);
                    c.set(Calendar.MILLISECOND, 0);
                    at = c.getTimeInMillis();
                }
                if (at > after) return at;
            }
            day.add(Calendar.DAY_OF_MONTH, 1);
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
            long at = nextFire(ctx, t, now);
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
