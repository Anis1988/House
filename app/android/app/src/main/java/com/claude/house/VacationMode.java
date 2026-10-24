package com.claude.house;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Vacation mode: during an evening window (from sunset or a set time, until a set time), lights
 * come on and go off at random, so the house looks lived-in. Each step turns one random light on
 * or off, then waits 10–35 minutes. At the end of the window every light it turned on goes off.
 * Away from the home Wi-Fi the lights go through the LIFX cloud (SceneTimers.runScene).
 *
 * Settings ("vacation" in prefs): { on, from: "sunset" | minutes after midnight, until: minutes }
 */
final class VacationMode {
    static final String ACTION = "com.claude.house.VACATION";
    private static final Random rnd = new Random();

    private VacationMode() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(Lifx.PREFS, Context.MODE_PRIVATE);
    }

    static JSONObject settings(Context ctx) {
        try {
            return new JSONObject(prefs(ctx).getString("vacation", "{\"on\":false,\"from\":\"sunset\",\"until\":1410}"));
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    static void save(Context ctx, JSONObject s) {
        prefs(ctx).edit().putString("vacation", s.toString()).apply();
        if (!s.optBoolean("on")) allOff(ctx);
        schedule(ctx);
    }

    private static PendingIntent intent(Context ctx) {
        Intent i = new Intent(ctx, ActionReceiver.class).setAction(ACTION);
        return PendingIntent.getBroadcast(ctx, 10, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Today's window [start, end] in epoch ms (end may be after midnight), or null. */
    static long[] window(Context ctx, Calendar day) {
        JSONObject s = settings(ctx);
        long start;
        if ("sunset".equals(s.optString("from", "sunset"))) {
            float lat = prefs(ctx).getFloat("lat", 0), lon = prefs(ctx).getFloat("lon", 0);
            start = prefs(ctx).getBoolean("hasLocation", false) ? SceneTimers.sunTime(day, lat, lon, false) : 0;
            if (start == 0) start = at(day, 19 * 60); // no city set: 7 PM
        } else {
            start = at(day, s.optInt("from", 19 * 60));
        }
        long end = at(day, s.optInt("until", 23 * 60 + 30));
        if (end <= start) end += 86_400_000L; // until after midnight
        return new long[] {start, end};
    }

    private static long at(Calendar day, int minutes) {
        Calendar c = (Calendar) day.clone();
        c.set(Calendar.HOUR_OF_DAY, minutes / 60);
        c.set(Calendar.MINUTE, minutes % 60);
        c.set(Calendar.SECOND, 0);
        c.set(Calendar.MILLISECOND, 0);
        return c.getTimeInMillis();
    }

    /** The window we're in now, or the next one. */
    private static long[] currentOrNext(Context ctx) {
        long now = System.currentTimeMillis();
        Calendar day = Calendar.getInstance();
        day.add(Calendar.DAY_OF_MONTH, -1); // yesterday's window may still be running past midnight
        for (int i = 0; i < 3; i++) {
            long[] w = window(ctx, day);
            if (w[1] > now) return w;
            day.add(Calendar.DAY_OF_MONTH, 1);
        }
        return null;
    }

    /** Called on change, after each step, app start and boot. */
    static void schedule(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        am.cancel(intent(ctx));
        if (!settings(ctx).optBoolean("on")) return;
        long[] w = currentOrNext(ctx);
        if (w == null) return;
        long now = System.currentTimeMillis();
        long next = now < w[0] ? w[0] : Math.min(w[1], now + (10 + rnd.nextInt(26)) * 60_000L);
        prefs(ctx).edit().putLong("vacationNext", next).apply();
        if (android.os.Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, intent(ctx));
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, intent(ctx));
    }

    static long next(Context ctx) {
        return settings(ctx).optBoolean("on") ? prefs(ctx).getLong("vacationNext", 0) : 0;
    }

    /** One step. Blocking. */
    static void step(Context ctx) {
        try {
            if (!settings(ctx).optBoolean("on")) return;
            long[] w = currentOrNext(ctx);
            long now = System.currentTimeMillis();
            if (w == null || now < w[0] - 60_000) return;
            if (now >= w[1] - 60_000) { allOff(ctx); return; }
            Map<String, Lifx.Light> lights = Lifx.cached(ctx);
            if (lights.isEmpty()) return;
            Set<String> mine = new HashSet<>(prefs(ctx).getStringSet("vacationOn", new HashSet<>()));
            List<String> ids = new ArrayList<>(lights.keySet());
            String id = ids.get(rnd.nextInt(ids.size()));
            // Keep it believable: one or two lights on at a time, rarely none.
            boolean turnOn = mine.size() == 0 || (!mine.contains(id) && mine.size() < 2 && rnd.nextBoolean());
            if (!turnOn && !mine.isEmpty() && !mine.contains(id)) id = mine.iterator().next();
            JSONObject light = turnOn ? new JSONObject().put("mode", "on").put("bri", 55 + rnd.nextInt(40)) : new JSONObject().put("mode", "off");
            SceneTimers.runScene(ctx, new JSONObject().put("lights", new JSONObject().put(id, light)), 2000);
            if (turnOn) mine.add(id); else mine.remove(id);
            prefs(ctx).edit().putStringSet("vacationOn", mine).apply();
        } catch (JSONException ignored) {
        } finally {
            schedule(ctx);
        }
    }

    /** Turns off every light vacation mode turned on. Blocking. */
    static void allOff(Context ctx) {
        Set<String> mine = prefs(ctx).getStringSet("vacationOn", new HashSet<>());
        if (mine.isEmpty()) return;
        try {
            JSONObject ls = new JSONObject();
            for (String id : mine) ls.put(id, new JSONObject().put("mode", "off"));
            JSONObject scene = new JSONObject().put("lights", ls);
            new Thread(() -> SceneTimers.runScene(ctx, scene, 3000)).start();
        } catch (JSONException ignored) {}
        prefs(ctx).edit().putStringSet("vacationOn", new HashSet<>()).apply();
    }
}
