package com.claude.house;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Timed scenes: a scene with "offAfter" (minutes) turns the lights it switched on back off after
 * that long, even with the app closed. Running the same scene again restarts its countdown.
 *
 * Pending ("sceneOffs" in prefs): [{ scene, name, at, ids: [bulb ids] }]
 */
final class SceneOffs {
    static final String ACTION = "com.claude.house.SCENE_OFF";

    private SceneOffs() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(Lifx.PREFS, Context.MODE_PRIVATE);
    }

    static JSONArray pending(Context ctx) {
        try {
            return new JSONArray(prefs(ctx).getString("sceneOffs", "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    private static void save(Context ctx, JSONArray list) {
        prefs(ctx).edit().putString("sceneOffs", list.toString()).apply();
        schedule(ctx);
    }

    /**
     * After any scene ran: lights it set leave other scenes' countdowns (so Bright after Movie-eat
     * stays on), and if it's timed, remember which lights it turned on and when they go off.
     */
    static void after(Context ctx, JSONObject scene) {
        JSONObject wanted = scene.optJSONObject("lights");
        if (wanted == null) return;
        String id = scene.optString("id");
        JSONObject every = wanted.optJSONObject("*");
        JSONArray on = new JSONArray();
        java.util.Set<String> touched = new java.util.HashSet<>();
        for (Map.Entry<String, Lifx.Light> e : Lifx.cached(ctx).entrySet()) {
            JSONObject s = wanted.optJSONObject(e.getKey());
            if (s == null) s = every;
            String mode = s == null ? "" : s.optString("mode");
            if ("on".equals(mode) || "off".equals(mode)) touched.add(e.getKey());
            if ("on".equals(mode)) on.put(e.getKey());
        }
        JSONArray before = pending(ctx), list = new JSONArray();
        try {
            for (int i = 0; i < before.length(); i++) {
                JSONObject p = before.getJSONObject(i);
                if (!id.isEmpty() && id.equals(p.optString("scene"))) continue;
                JSONArray ids = p.optJSONArray("ids"), left = new JSONArray();
                for (int j = 0; ids != null && j < ids.length(); j++) if (!touched.contains(ids.getString(j))) left.put(ids.getString(j));
                if (left.length() > 0) list.put(p.put("ids", left));
            }
            int minutes = scene.optInt("offAfter", 0);
            if (minutes > 0 && !id.isEmpty() && on.length() > 0) {
                list.put(new JSONObject().put("scene", id).put("name", scene.optString("name"))
                    .put("at", System.currentTimeMillis() + minutes * 60_000L).put("ids", on));
            }
        } catch (JSONException ignored) {}
        if (!list.toString().equals(before.toString())) save(ctx, list);
    }

    static void cancel(Context ctx, String sceneId) {
        save(ctx, without(pending(ctx), sceneId));
    }

    private static JSONArray without(JSONArray list, String sceneId) {
        JSONArray out = new JSONArray();
        for (int i = 0; i < list.length(); i++) {
            JSONObject p = list.optJSONObject(i);
            if (p != null && !sceneId.equals(p.optString("scene"))) out.put(p);
        }
        return out;
    }

    private static PendingIntent intent(Context ctx) {
        Intent i = new Intent(ctx, ActionReceiver.class).setAction(ACTION);
        return PendingIntent.getBroadcast(ctx, 11, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** One exact alarm for the soonest countdown. Called on change, after each run, at boot. */
    static void schedule(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        am.cancel(intent(ctx));
        long next = 0;
        JSONArray list = pending(ctx);
        for (int i = 0; i < list.length(); i++) {
            long at = list.optJSONObject(i).optLong("at");
            if (next == 0 || at < next) next = at;
        }
        if (next == 0) return;
        if (android.os.Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, intent(ctx));
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, intent(ctx));
    }

    /** The alarm went off: turn off the lights of every countdown that's done. Blocking. */
    static void fire(Context ctx) {
        JSONArray list = pending(ctx), keep = new JSONArray();
        JSONObject off = new JSONObject();
        long now = System.currentTimeMillis();
        try {
            for (int i = 0; i < list.length(); i++) {
                JSONObject p = list.getJSONObject(i);
                if (p.optLong("at") > now + 5_000) { keep.put(p); continue; }
                JSONArray ids = p.optJSONArray("ids");
                for (int j = 0; ids != null && j < ids.length(); j++) off.put(ids.getString(j), new JSONObject().put("mode", "off"));
            }
            // A light another countdown still needs stays on.
            for (int i = 0; i < keep.length(); i++) {
                JSONArray ids = keep.getJSONObject(i).optJSONArray("ids");
                for (int j = 0; ids != null && j < ids.length(); j++) off.remove(ids.getString(j));
            }
        } catch (JSONException ignored) {}
        prefs(ctx).edit().putString("sceneOffs", keep.toString()).apply();
        if (off.length() > 0) {
            try {
                // Not through runScene: that would also drop these lights from the countdowns kept above.
                JSONObject scene = new JSONObject().put("lights", off);
                String token = HouseActions.creds(ctx).optString("lifxToken");
                if (!Presence.atHome(ctx) && !token.isEmpty()) LifxCloud.run(token, scene, 3000);
                else Lifx.runCustom(ctx, scene, 3000);
            } catch (Exception ignored) {}
        }
        schedule(ctx);
        Widgets.redrawAll(ctx);
    }

    /** For the page: { sceneId: epoch ms when its lights go off }. */
    static JSONObject countdowns(Context ctx) {
        JSONObject out = new JSONObject();
        JSONArray list = pending(ctx);
        try {
            for (int i = 0; i < list.length(); i++) out.put(list.getJSONObject(i).optString("scene"), list.getJSONObject(i).optLong("at"));
        } catch (JSONException ignored) {}
        return out;
    }
}
