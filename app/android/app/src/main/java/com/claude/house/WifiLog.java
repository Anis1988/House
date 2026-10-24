package com.claude.house;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Wi-Fi logs:
 * - Device history: when each device joined and left (from the background Wi-Fi check). A device
 *   counts as gone after two checks in a row without it, since scans can miss a sleepy one.
 * - Internet outages: while on the home Wi-Fi, the internet is checked about every 5 minutes;
 *   each outage is kept with its start and end.
 */
final class WifiLog {
    static final String ACTION_NET_CHECK = "com.claude.house.INTERNET_CHECK";
    private static final long KEEP = 14 * 86_400_000L;
    private static final long OUTAGE_EVERY = 5 * 60_000L;
    private static final OkHttpClient http = new OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS).readTimeout(6, TimeUnit.SECONDS).build();

    private WifiLog() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(Lifx.PREFS, Context.MODE_PRIVATE);
    }

    private static JSONArray array(Context ctx, String key) {
        try {
            return new JSONArray(prefs(ctx).getString(key, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    static JSONArray deviceLog(Context ctx) { return array(ctx, "deviceLog"); }
    static JSONArray outages(Context ctx) { return array(ctx, "outages"); }

    static void clear(Context ctx) {
        prefs(ctx).edit().remove("deviceLog").remove("devState").remove("outages").apply();
    }

    // ---- Device history ----

    static synchronized void devices(Context ctx, Map<String, JSONObject> now) {
        JSONObject state;
        try {
            state = new JSONObject(prefs(ctx).getString("devState", "{}"));
        } catch (JSONException e) {
            state = new JSONObject();
        }
        boolean first = state.length() == 0;
        JSONArray log = deviceLog(ctx);
        long t = System.currentTimeMillis();
        try {
            for (Map.Entry<String, JSONObject> e : now.entrySet()) {
                JSONObject st = state.optJSONObject(e.getKey());
                String name = e.getValue().optString("name");
                if (name.isEmpty()) name = e.getValue().optString("vendor");
                if (st == null) st = new JSONObject().put("on", false);
                if (!st.optBoolean("on") && !first) log.put(entry(t, e.getKey(), name, e.getValue().optString("ip"), "joined"));
                st.put("on", true).put("misses", 0).put("name", name).put("ip", e.getValue().optString("ip"));
                state.put(e.getKey(), st);
            }
            for (Iterator<String> it = state.keys(); it.hasNext(); ) {
                String key = it.next();
                if (now.containsKey(key)) continue;
                JSONObject st = state.getJSONObject(key);
                if (!st.optBoolean("on")) continue;
                int misses = st.optInt("misses") + 1;
                st.put("misses", misses);
                if (misses >= 2) {
                    st.put("on", false);
                    log.put(entry(t, key, st.optString("name"), st.optString("ip"), "left"));
                }
            }
        } catch (JSONException ignored) {}
        prefs(ctx).edit().putString("devState", state.toString()).putString("deviceLog", trim(log).toString()).apply();
    }

    private static JSONObject entry(long t, String key, String name, String ip, String event) throws JSONException {
        return new JSONObject().put("at", t).put("key", key).put("name", name).put("ip", ip).put("event", event);
    }

    private static JSONArray trim(JSONArray log) {
        JSONArray out = new JSONArray();
        long cutoff = System.currentTimeMillis() - KEEP;
        int start = Math.max(0, log.length() - 600);
        for (int i = start; i < log.length(); i++) {
            JSONObject e = log.optJSONObject(i);
            if (e != null && e.optLong("at", e.optLong("start")) >= cutoff) out.put(e);
        }
        return out;
    }

    // ---- Internet outages ----

    static boolean outageWatchOn(Context ctx) {
        return WifiWatch.settings(ctx).optBoolean("outages");
    }

    private static PendingIntent outageIntent(Context ctx) {
        Intent i = new Intent(ctx, ActionReceiver.class).setAction(ACTION_NET_CHECK);
        return PendingIntent.getBroadcast(ctx, 9, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Called on change, app start and boot. */
    static void schedule(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        am.cancel(outageIntent(ctx));
        if (!outageWatchOn(ctx)) return;
        long at = System.currentTimeMillis() + OUTAGE_EVERY;
        if (android.os.Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, outageIntent(ctx));
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, outageIntent(ctx));
    }

    /** True if the internet answers (Google's "no content" check page; 3 tries). Blocking. */
    static boolean internetUp() {
        for (int i = 0; i < 3; i++) {
            try (Response r = http.newCall(new Request.Builder().url("https://www.google.com/generate_204").build()).execute()) {
                if (r.code() == 204 || r.isSuccessful()) return true;
            } catch (Exception ignored) {}
            try {
                Thread.sleep(1500);
            } catch (InterruptedException ignored) {}
        }
        return false;
    }

    /** One check: only on the home Wi-Fi (away, the phone's own data doesn't say anything about home). Blocking. */
    static synchronized void checkInternet(Context ctx) {
        try {
            if (!outageWatchOn(ctx)) return;
            JSONArray list = outages(ctx);
            JSONObject open = list.length() > 0 && list.optJSONObject(list.length() - 1).isNull("end") ? list.optJSONObject(list.length() - 1) : null;
            long t = System.currentTimeMillis();
            if (!Presence.atHome(ctx)) {
                // Left home during an outage: close it at the last check, end unknown.
                if (open != null) open.put("end", prefs(ctx).getLong("netCheckedAt", t)).put("unsure", true);
            } else if (internetUp()) {
                if (open != null) open.put("end", t);
            } else if (open == null) {
                // It went down some time since the last good check: count from halfway.
                long last = prefs(ctx).getLong("netCheckedAt", t);
                list.put(new JSONObject().put("start", t - Math.min(t - last, OUTAGE_EVERY) / 2).put("end", JSONObject.NULL));
            }
            prefs(ctx).edit().putString("outages", trim(list).toString()).putLong("netCheckedAt", t).apply();
        } catch (JSONException ignored) {
        } finally {
            schedule(ctx);
        }
    }
}
