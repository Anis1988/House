package com.claude.house;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import java.util.Calendar;
import java.util.concurrent.TimeUnit;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The paired PC (House PC helper, pc-helper/ in the repo) for the PC widget, the Quick Settings
 * tile and "turn on at a set time". The first paired PC from the app (creds.pcList).
 *
 * Turn on at ("pcWake" in prefs): { on, minutes, days: [1 = Sunday … 7], mac, broadcast, name }.
 * Last known state ("pcState"): { online, uptime, at }.
 */
final class PcLink {
    static final String ACTION_WAKE = "com.claude.house.PC_WAKE";
    private static final int PORT = 47801;
    private static final OkHttpClient http = new OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS).readTimeout(4, TimeUnit.SECONDS).build();

    private PcLink() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(Lifx.PREFS, Context.MODE_PRIVATE);
    }

    /** { mac, ip, name, key } or null when no PC is paired. */
    static JSONObject pc(Context ctx) {
        JSONArray l = HouseActions.creds(ctx).optJSONArray("pcList");
        return l != null && l.length() > 0 ? l.optJSONObject(0) : null;
    }

    static JSONObject state(Context ctx) {
        try {
            return new JSONObject(prefs(ctx).getString("pcState", "{}"));
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    /** Asks the PC; saves and returns { online, uptime, at }. Blocking. */
    static JSONObject refresh(Context ctx) {
        JSONObject pc = pc(ctx), s = new JSONObject();
        try {
            s.put("at", System.currentTimeMillis()).put("online", false);
            if (pc != null) {
                try (Response r = http.newCall(new Request.Builder().url("http://" + pc.optString("ip") + ":" + PORT + "/status")
                    .header("X-House-Key", pc.optString("key")).build()).execute()) {
                    if (r.isSuccessful()) s.put("online", true).put("uptime", new JSONObject(r.body().string()).optLong("uptime"));
                } catch (Exception ignored) {}
            }
        } catch (JSONException ignored) {}
        prefs(ctx).edit().putString("pcState", s.toString()).apply();
        return s;
    }

    /** sleep, lock, shutdown, restart, cancel. Blocking. */
    static void cmd(Context ctx, String action) throws Exception {
        JSONObject pc = pc(ctx);
        if (pc == null) throw new Exception("No PC paired");
        try (Response r = http.newCall(new Request.Builder().url("http://" + pc.optString("ip") + ":" + PORT + "/cmd")
            .header("X-House-Key", pc.optString("key"))
            .post(RequestBody.create(new JSONObject().put("action", action).toString(), MediaType.get("application/json"))).build()).execute()) {
            if (!r.isSuccessful()) throw new Exception("The PC said no (" + r.code() + ")");
        } catch (java.io.IOException e) {
            throw new Exception("The PC isn't answering");
        }
        if ("sleep".equals(action) || "shutdown".equals(action)) {
            prefs(ctx).edit().putString("pcState", new JSONObject().put("online", false).put("at", System.currentTimeMillis()).toString()).apply();
        }
    }

    /** Wake-on-LAN, a few times (one packet can get lost). Blocking. */
    static void wake(Context ctx) throws Exception {
        JSONObject pc = pc(ctx);
        if (pc == null) throw new Exception("No PC paired");
        String ip = pc.optString("ip");
        String broadcast = ip.contains(".") ? ip.substring(0, ip.lastIndexOf('.')) + ".255" : "255.255.255.255";
        for (int i = 0; i < 3; i++) {
            LanNet.wake(pc.optString("mac"), broadcast);
            Thread.sleep(300);
        }
    }

    // ---- Turn on at a set time ----

    static JSONObject wakeSettings(Context ctx) {
        try {
            return new JSONObject(prefs(ctx).getString("pcWake", "{\"on\":false,\"minutes\":420,\"days\":[]}"));
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    static void saveWake(Context ctx, JSONObject s) {
        prefs(ctx).edit().putString("pcWake", s.toString()).apply();
        schedule(ctx);
    }

    private static PendingIntent wakeIntent(Context ctx) {
        Intent i = new Intent(ctx, ActionReceiver.class).setAction(ACTION_WAKE);
        return PendingIntent.getBroadcast(ctx, 14, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** When it next turns the PC on, or 0. */
    static long next(Context ctx) {
        JSONObject s = wakeSettings(ctx);
        if (!s.optBoolean("on") || s.optString("mac").isEmpty()) return 0;
        JSONArray days = s.optJSONArray("days");
        int minutes = s.optInt("minutes", 420);
        Calendar c = Calendar.getInstance();
        c.set(Calendar.SECOND, 0);
        c.set(Calendar.MILLISECOND, 0);
        c.set(Calendar.HOUR_OF_DAY, minutes / 60);
        c.set(Calendar.MINUTE, minutes % 60);
        for (int i = 0; i < 8; i++) {
            boolean dayOk = days == null || days.length() == 0;
            for (int j = 0; days != null && j < days.length(); j++) if (days.optInt(j) == c.get(Calendar.DAY_OF_WEEK)) dayOk = true;
            if (dayOk && c.getTimeInMillis() > System.currentTimeMillis() + 5_000) return c.getTimeInMillis();
            c.add(Calendar.DAY_OF_MONTH, 1);
        }
        return 0;
    }

    static void schedule(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        am.cancel(wakeIntent(ctx));
        long at = next(ctx);
        if (at == 0) return;
        if (android.os.Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, wakeIntent(ctx));
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, wakeIntent(ctx));
    }

    /** The alarm: send the wake-up from the home Wi-Fi (it can't reach the PC from outside). Blocking. */
    static void fireWake(Context ctx) {
        try {
            JSONObject s = wakeSettings(ctx);
            if (Presence.atHome(ctx)) {
                String b = s.optString("broadcast", "255.255.255.255");
                for (int i = 0; i < 3; i++) {
                    LanNet.wake(s.optString("mac"), b);
                    Thread.sleep(300);
                }
            }
        } catch (Exception ignored) {
        } finally {
            schedule(ctx);
        }
    }
}
