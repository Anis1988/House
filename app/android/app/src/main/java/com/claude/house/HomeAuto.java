package com.claude.house;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Small automations between devices, with the app closed:
 * - Doorbell lights: a ring or a person at the door (Nest events, pulled every ~2 min) turns on
 *   the chosen lights for a few minutes, only after dark if wanted. Lights already on stay on.
 * - TV movie mode: when the LG TV turns on (checked every ~2 min while at home), the chosen
 *   lights that are on dim; when it turns off they go back to how they were.
 *
 * Settings ("auto" in prefs):
 * { door: { on, lights: [ids], minutes, dark, ring, person }, movie: { on, lights: [ids], bri, dark } }
 */
final class HomeAuto {
    static final String ACTION_TV = "com.claude.house.TV_WATCH";
    private static final long TV_EVERY = 2 * 60_000L;

    private HomeAuto() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(Lifx.PREFS, Context.MODE_PRIVATE);
    }

    static JSONObject settings(Context ctx) {
        try {
            return new JSONObject(prefs(ctx).getString("auto", "{}"));
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    static void save(Context ctx, JSONObject s) {
        prefs(ctx).edit().putString("auto", s.toString()).apply();
        schedule(ctx);
        NestWatch.schedule(ctx); // doorbell lights need the event pull
    }

    static boolean doorWanted(Context ctx) {
        JSONObject d = settings(ctx).optJSONObject("door");
        return d != null && d.optBoolean("on") && d.optJSONArray("lights") != null && d.optJSONArray("lights").length() > 0;
    }

    /** Between sunset and sunrise (your city from Lights → Settings; otherwise 6 pm – 7 am). */
    static boolean isDark(Context ctx) {
        SharedPreferences p = prefs(ctx);
        Calendar now = Calendar.getInstance();
        if (!p.getBoolean("hasLocation", false)) {
            int h = now.get(Calendar.HOUR_OF_DAY);
            return h >= 18 || h < 7;
        }
        double lat = p.getFloat("lat", 0), lon = p.getFloat("lon", 0);
        long rise = SceneTimers.sunTime(now, lat, lon, true), set = SceneTimers.sunTime(now, lat, lon, false);
        long t = now.getTimeInMillis();
        if (rise == 0 || set == 0) return false;
        return t < rise || t > set - 20 * 60_000L; // dusk counts
    }

    private static List<String> ids(JSONObject o) {
        List<String> out = new ArrayList<>();
        JSONArray a = o == null ? null : o.optJSONArray("lights");
        for (int i = 0; a != null && i < a.length(); i++) out.add(a.optString(i));
        return out;
    }

    // ---- Doorbell lights ----

    /** A ring ("ring") or a person ("person") at the door. Blocking. */
    static void doorbell(Context ctx, String kind) {
        JSONObject d = settings(ctx).optJSONObject("door");
        if (d == null || !d.optBoolean("on")) return;
        if (!d.optBoolean(kind, true)) return;
        if (d.optBoolean("dark", true) && !isDark(ctx)) return;
        if (!Presence.atHome(ctx) && HouseActions.creds(ctx).optString("lifxToken").isEmpty()) return;
        // Lights that are off, plus the ones a doorbell already turned on (their time starts again).
        java.util.Set<String> ours = SceneOffs.lightsOf(ctx, "doorbell");
        Map<String, Lifx.Light> now = Lifx.cached(ctx);
        JSONObject lights = new JSONObject();
        try {
            for (String id : ids(d)) {
                Lifx.Light l = now.get(id);
                if (l != null && l.on && !ours.contains(id)) continue;
                lights.put(id, new JSONObject().put("mode", "on").put("bri", 100));
            }
            if (lights.length() == 0) return;
            JSONObject scene = new JSONObject().put("id", "doorbell").put("name", "Doorbell lights")
                .put("offAfter", Math.max(1, d.optInt("minutes", 5))).put("lights", lights);
            SceneTimers.runScene(ctx, scene, 0);
            Widgets.redrawAll(ctx);
        } catch (JSONException ignored) {}
    }

    // ---- TV movie mode ----

    private static PendingIntent tvIntent(Context ctx) {
        Intent i = new Intent(ctx, ActionReceiver.class).setAction(ACTION_TV);
        return PendingIntent.getBroadcast(ctx, 13, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Every ~2 min while movie mode is on and the TV is set up. Inexact (cheap on battery). */
    static void schedule(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        am.cancel(tvIntent(ctx));
        JSONObject m = settings(ctx).optJSONObject("movie");
        JSONObject c = HouseActions.creds(ctx);
        if (m == null || !m.optBoolean("on") || c.optString("lgIp").isEmpty() || c.optString("lgKey").isEmpty()) return;
        am.setInexactRepeating(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + TV_EVERY, TV_EVERY, tvIntent(ctx));
    }

    /** One check: dim when the TV came on, put back when it went off. Blocking. */
    static synchronized void tvCheck(Context ctx) {
        JSONObject m = settings(ctx).optJSONObject("movie");
        if (m == null || !m.optBoolean("on") || !Presence.atHome(ctx)) return;
        boolean on = HouseActions.lgIsOn(ctx);
        boolean was = prefs(ctx).getBoolean("tvWasOn", false);
        if (on == was) return;
        prefs(ctx).edit().putBoolean("tvWasOn", on).apply();
        if (on) {
            if (m.optBoolean("dark", true) && !isDark(ctx)) return;
            dim(ctx, m);
        } else {
            restore(ctx);
        }
        Widgets.redrawAll(ctx);
    }

    private static void dim(Context ctx, JSONObject m) {
        Map<String, Lifx.Light> now = Lifx.scan(ctx, 1200, null);
        if (now.isEmpty()) now = Lifx.cached(ctx);
        int pct = Math.max(1, Math.min(100, m.optInt("bri", 20)));
        JSONObject saved = new JSONObject();
        List<String> dimIds = new ArrayList<>();
        try {
            for (String id : ids(m)) {
                Lifx.Light l = now.get(id);
                if (l == null || !l.on || Math.round(l.bri / 65535f * 100) <= pct) continue;
                saved.put(id, l.bri);
                dimIds.add(id);
            }
        } catch (JSONException ignored) {}
        if (dimIds.isEmpty()) return;
        Lifx.setColor(ctx, dimIds, -1, -1, Lifx.pct(pct), -1, 2000);
        prefs(ctx).edit().putString("movieSaved", saved.toString()).putInt("movieBri", pct).apply();
    }

    /** Lights you changed in the meantime (off, or another brightness) are left alone. */
    private static void restore(Context ctx) {
        JSONObject saved;
        try {
            saved = new JSONObject(prefs(ctx).getString("movieSaved", "{}"));
        } catch (JSONException e) {
            return;
        }
        prefs(ctx).edit().remove("movieSaved").apply();
        if (saved.length() == 0) return;
        int pct = prefs(ctx).getInt("movieBri", 20);
        Map<String, Lifx.Light> now = Lifx.scan(ctx, 1200, null);
        if (now.isEmpty()) now = Lifx.cached(ctx);
        for (Iterator<String> it = saved.keys(); it.hasNext(); ) {
            String id = it.next();
            Lifx.Light l = now.get(id);
            if (l == null || !l.on || Math.abs(Math.round(l.bri / 65535f * 100) - pct) > 3) continue;
            Lifx.setColor(ctx, java.util.Collections.singletonList(id), -1, -1, saved.optInt(id), -1, 2000);
        }
    }
}
