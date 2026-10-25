package com.claude.house;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.util.Base64;
import android.util.Log;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.concurrent.TimeUnit;
import okhttp3.FormBody;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Nest in the background:
 * - every ~15 min: save inside temperature and humidity (history chart) and check the humidity alert;
 * - every ~2 min (only with ring alerts on): pull doorbell events from your Pub/Sub subscription
 *   and notify (ring, person, motion). Google only sends events to Pub/Sub, so the app fetches them.
 *
 * Settings ("nestWatch" in prefs): { ring, motion, humOn, humLow, humHigh }; subscription in creds.nestSub.
 */
final class NestWatch {
    static final String ACTION_TICK = "com.claude.house.NEST_TICK";
    static final String ACTION_RING = "com.claude.house.NEST_RING";
    private static final String TAG = "NestWatch";
    private static final String SDM = "https://smartdevicemanagement.googleapis.com/v1/";
    private static final long KEEP = 8 * 86_400_000L;   // 8 days of history
    private static final long RING_EVERY = 2 * 60_000L;
    private static final OkHttpClient web = new OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).build();

    private NestWatch() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(Lifx.PREFS, Context.MODE_PRIVATE);
    }

    static JSONObject settings(Context ctx) {
        try {
            return new JSONObject(prefs(ctx).getString("nestWatch", "{}"));
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    static void save(Context ctx, JSONObject s) {
        prefs(ctx).edit().putString("nestWatch", s.toString()).apply();
        schedule(ctx);
    }

    static JSONArray history(Context ctx) {
        try {
            return new JSONArray(prefs(ctx).getString("nestHistory", "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    private static boolean signedIn(Context ctx) {
        return !HouseActions.creds(ctx).optString("nestRefresh").isEmpty();
    }

    private static PendingIntent intent(Context ctx, String action, int code) {
        Intent i = new Intent(ctx, ActionReceiver.class).setAction(action);
        return PendingIntent.getBroadcast(ctx, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Called on change, app start and boot. */
    static void schedule(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        PendingIntent tick = intent(ctx, ACTION_TICK, 7), ring = intent(ctx, ACTION_RING, 8);
        am.cancel(tick);
        am.cancel(ring);
        if (!signedIn(ctx)) return;
        am.setInexactRepeating(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + AlarmManager.INTERVAL_FIFTEEN_MINUTES,
            AlarmManager.INTERVAL_FIFTEEN_MINUTES, tick);
        if (ringWanted(ctx)) ringAt(ctx, System.currentTimeMillis() + RING_EVERY);
    }

    private static boolean ringWanted(Context ctx) {
        JSONObject s = settings(ctx);
        return (s.optBoolean("ring") || s.optBoolean("motion") || HomeAuto.doorWanted(ctx)) && !HouseActions.creds(ctx).optString("nestSub").isEmpty();
    }

    private static void ringAt(Context ctx, long at) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        PendingIntent pi = intent(ctx, ACTION_RING, 8);
        if (android.os.Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
    }

    // ---- Google sign-in ----

    /** A fresh access token (cached until shortly before it expires). Blocking. */
    static String token(Context ctx) throws Exception {
        long exp = prefs(ctx).getLong("nestAccessExp", 0);
        String cached = prefs(ctx).getString("nestAccess", "");
        if (!cached.isEmpty() && exp > System.currentTimeMillis() + 60_000) return cached;
        JSONObject c = HouseActions.creds(ctx);
        try (Response r = web.newCall(new Request.Builder().url("https://oauth2.googleapis.com/token").post(new FormBody.Builder()
            .add("client_id", c.optString("nestClient")).add("client_secret", c.optString("nestSecret"))
            .add("refresh_token", c.optString("nestRefresh")).add("grant_type", "refresh_token").build()).build()).execute()) {
            JSONObject j = new JSONObject(r.body().string());
            String access = j.optString("access_token");
            if (access.isEmpty()) throw new Exception("Nest sign-in expired");
            prefs(ctx).edit().putString("nestAccess", access).putLong("nestAccessExp", System.currentTimeMillis() + j.optLong("expires_in", 3600) * 1000).apply();
            return access;
        }
    }

    private static JSONObject get(String url, String token) throws Exception {
        try (Response r = web.newCall(new Request.Builder().url(url).header("Authorization", "Bearer " + token).build()).execute()) {
            JSONObject j = new JSONObject(r.body().string());
            if (!r.isSuccessful()) throw new Exception(j.optJSONObject("error") != null ? j.getJSONObject("error").optString("message") : "HTTP " + r.code());
            return j;
        }
    }

    private static JSONObject post(String url, String token, JSONObject body) throws Exception {
        try (Response r = web.newCall(new Request.Builder().url(url).header("Authorization", "Bearer " + token)
            .post(RequestBody.create(body.toString(), MediaType.get("application/json"))).build()).execute()) {
            String text = r.body() == null ? "" : r.body().string();
            JSONObject j = text.isEmpty() ? new JSONObject() : new JSONObject(text);
            if (!r.isSuccessful()) throw new Exception(j.optJSONObject("error") != null ? j.getJSONObject("error").optString("message") : "HTTP " + r.code());
            return j;
        }
    }

    // ---- Every 15 min: history + humidity alert ----

    /** Blocking. Returns the reading saved, or null. */
    static JSONArray tick(Context ctx) {
        if (!signedIn(ctx)) return null;
        try {
            String token = token(ctx);
            JSONObject list = get(SDM + "enterprises/" + HouseActions.creds(ctx).optString("nestProject") + "/devices", token);
            JSONArray devices = list.optJSONArray("devices");
            JSONObject names = new JSONObject();
            JSONArray point = null;
            for (int i = 0; devices != null && i < devices.length(); i++) {
                JSONObject d = devices.getJSONObject(i);
                JSONObject traits = d.optJSONObject("traits");
                JSONObject info = traits == null ? null : traits.optJSONObject("sdm.devices.traits.Info");
                String name = info == null ? "" : info.optString("customName");
                if (name.isEmpty() && d.optJSONArray("parentRelations") != null && d.getJSONArray("parentRelations").length() > 0) {
                    name = d.getJSONArray("parentRelations").getJSONObject(0).optString("displayName");
                }
                names.put(d.optString("name"), name);
                if ("sdm.devices.types.THERMOSTAT".equals(d.optString("type")) && traits != null) saveState(ctx, d.optString("name"), traits);
                if (point == null && "sdm.devices.types.THERMOSTAT".equals(d.optString("type")) && traits != null) {
                    JSONObject t = traits.optJSONObject("sdm.devices.traits.Temperature"), h = traits.optJSONObject("sdm.devices.traits.Humidity");
                    if (t != null && t.has("ambientTemperatureCelsius")) {
                        point = new JSONArray().put(System.currentTimeMillis())
                            .put(Math.round(t.optDouble("ambientTemperatureCelsius") * 10) / 10.0)
                            .put(h == null ? JSONObject.NULL : (Object) Math.round(h.optDouble("ambientHumidityPercent")));
                    }
                }
            }
            prefs(ctx).edit().putString("nestNames", names.toString()).apply();
            if (point != null) {
                addPoint(ctx, point);
                humidityCheck(ctx, point);
            }
            return point;
        } catch (Exception e) {
            Log.w(TAG, "tick", e);
            return null;
        }
    }

    private static synchronized void addPoint(Context ctx, JSONArray point) throws JSONException {
        JSONArray old = history(ctx), next = new JSONArray();
        long cutoff = System.currentTimeMillis() - KEEP;
        long last = 0;
        for (int i = 0; i < old.length(); i++) {
            JSONArray p = old.getJSONArray(i);
            if (p.getLong(0) >= cutoff) { next.put(p); last = p.getLong(0); }
        }
        // Opening the app also saves a reading: keep at most one every 10 minutes.
        if (point.getLong(0) - last < 10 * 60_000L) return;
        next.put(point);
        prefs(ctx).edit().putString("nestHistory", next.toString()).apply();
    }

    private static void humidityCheck(Context ctx, JSONArray point) {
        JSONObject s = settings(ctx);
        if (!s.optBoolean("humOn") || point.isNull(2)) return;
        int hum = point.optInt(2), low = s.optInt("humLow", 30), high = s.optInt("humHigh", 60);
        String state = hum < low ? "low" : hum > high ? "high" : "ok";
        String was = prefs(ctx).getString("humState", "ok");
        prefs(ctx).edit().putString("humState", state).apply();
        if (state.equals(was) || "ok".equals(state)) return; // tell once, until it's back in range
        notify(ctx, "nest", "Nest alerts", NotificationManager.IMPORTANCE_DEFAULT, 30,
            "low".equals(state) ? "The house is dry" : "The house is humid",
            "Humidity is " + hum + "% (you asked to be told below " + low + "% or above " + high + "%).");
    }

    // ---- Every ~2 min: doorbell events from Pub/Sub ----

    static void ring(Context ctx) {
        if (!ringWanted(ctx) || !signedIn(ctx)) return;
        try {
            pullOnce(ctx);
        } catch (Exception e) {
            Log.w(TAG, "ring", e);
        } finally {
            ringAt(ctx, System.currentTimeMillis() + RING_EVERY);
        }
    }

    /** Pulls and acknowledges waiting events; notifies the wanted ones. Returns how many events came. Blocking. */
    static int pullOnce(Context ctx) throws Exception {
        String sub = HouseActions.creds(ctx).optString("nestSub").trim();
        String token = token(ctx);
        JSONObject r = post("https://pubsub.googleapis.com/v1/" + sub + ":pull", token, new JSONObject().put("maxMessages", 20));
        JSONArray msgs = r.optJSONArray("receivedMessages");
        if (msgs == null || msgs.length() == 0) return 0;
        JSONObject s = settings(ctx);
        JSONObject names;
        try {
            names = new JSONObject(prefs(ctx).getString("nestNames", "{}"));
        } catch (JSONException e) {
            names = new JSONObject();
        }
        JSONArray acks = new JSONArray();
        long now = System.currentTimeMillis();
        for (int i = 0; i < msgs.length(); i++) {
            JSONObject m = msgs.getJSONObject(i);
            acks.put(m.optString("ackId"));
            JSONObject msg = m.optJSONObject("message");
            if (msg == null) continue;
            JSONObject data = new JSONObject(new String(Base64.decode(msg.optString("data"), Base64.DEFAULT), StandardCharsets.UTF_8));
            // Skip events older than 10 minutes (the phone was off, or alerts were just turned on).
            long at = parseTime(data.optString("timestamp"));
            if (at > 0 && now - at > 10 * 60_000L) continue;
            JSONObject update = data.optJSONObject("resourceUpdate");
            JSONObject events = update == null ? null : update.optJSONObject("events");
            if (events == null) continue;
            String device = names.optString(update.optString("name"), "Doorbell");
            if (device.isEmpty()) device = "Doorbell";
            for (Iterator<String> it = events.keys(); it.hasNext(); ) {
                String ev = it.next();
                if (ev.endsWith("DoorbellChime.Chime") || ev.endsWith("CameraPerson.Person")) {
                    String kind = ev.endsWith("Chime") ? "ring" : "person";
                    HomeAuto.doorbell(ctx, kind);
                    lastRing(ctx, kind, device, at > 0 ? at : now, update.optString("name"), events.optJSONObject(ev), token);
                }
                if (ev.endsWith("DoorbellChime.Chime") && s.optBoolean("ring")) {
                    notify(ctx, "door", "Doorbell", NotificationManager.IMPORTANCE_HIGH, (int) (at % 100000) + 1000, "Someone's at the door", device + ": the doorbell rang");
                } else if (ev.endsWith("CameraPerson.Person") && s.optBoolean("motion")) {
                    notify(ctx, "door", "Doorbell", NotificationManager.IMPORTANCE_HIGH, (int) (at % 100000) + 2000, "Person at the door", device + " sees someone");
                } else if (ev.endsWith("CameraMotion.Motion") && s.optBoolean("motion")) {
                    notify(ctx, "door", "Doorbell", NotificationManager.IMPORTANCE_DEFAULT, (int) (at % 100000) + 3000, "Motion", device + " saw motion");
                }
            }
        }
        if (acks.length() > 0) post("https://pubsub.googleapis.com/v1/" + sub + ":acknowledge", token, new JSONObject().put("ackIds", acks));
        return msgs.length();
    }

    // ---- Thermostat state (widget, Quick Settings tile, Home overview) ----

    /** { at, name, temp, hum, mode, eco, heat, cool, scale: "CELSIUS"|"FAHRENHEIT", hvac } */
    static JSONObject state(Context ctx) {
        try {
            return new JSONObject(prefs(ctx).getString("nestState", "{}"));
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    private static void saveState(Context ctx, String name, JSONObject traits) {
        try {
            JSONObject t = traits.optJSONObject("sdm.devices.traits.Temperature"), h = traits.optJSONObject("sdm.devices.traits.Humidity"),
                mode = traits.optJSONObject("sdm.devices.traits.ThermostatMode"), eco = traits.optJSONObject("sdm.devices.traits.ThermostatEco"),
                sp = traits.optJSONObject("sdm.devices.traits.ThermostatTemperatureSetpoint"), set = traits.optJSONObject("sdm.devices.traits.Settings"),
                hvac = traits.optJSONObject("sdm.devices.traits.ThermostatHvac");
            JSONObject s = new JSONObject().put("at", System.currentTimeMillis()).put("name", name);
            if (t != null && t.has("ambientTemperatureCelsius")) s.put("temp", t.optDouble("ambientTemperatureCelsius"));
            if (h != null && h.has("ambientHumidityPercent")) s.put("hum", h.optDouble("ambientHumidityPercent"));
            if (mode != null) s.put("mode", mode.optString("mode"));
            if (eco != null) s.put("eco", eco.optString("mode"));
            if (sp != null && sp.has("heatCelsius")) s.put("heat", sp.optDouble("heatCelsius"));
            if (sp != null && sp.has("coolCelsius")) s.put("cool", sp.optDouble("coolCelsius"));
            if (set != null) s.put("scale", set.optString("temperatureScale", "CELSIUS"));
            if (hvac != null) s.put("hvac", hvac.optString("status"));
            prefs(ctx).edit().putString("nestState", s.toString()).apply();
        } catch (JSONException ignored) {}
    }

    /** Fresh state now (and redraw the Nest widgets). Blocking. */
    static JSONObject refresh(Context ctx) {
        tick(ctx);
        Widgets.redrawNest(ctx);
        return state(ctx);
    }

    /** One step warmer (+1) or cooler (-1): 0.5 °C, or 1 °F with Fahrenheit. Blocking. */
    static JSONObject adjust(Context ctx, int dir) throws Exception {
        JSONObject s = state(ctx);
        if (s.optString("name").isEmpty()) s = refresh(ctx);
        String name = s.optString("name"), mode = s.optString("mode");
        if (name.isEmpty()) throw new Exception("No thermostat");
        if ("MANUAL_ECO".equals(s.optString("eco"))) throw new Exception("Nest is in Eco");
        boolean f = "FAHRENHEIT".equals(s.optString("scale"));
        double step = f ? 5.0 / 9 : 0.5;
        String token = token(ctx);
        String url = SDM + name + ":executeCommand";
        if ("HEAT".equals(mode)) {
            double v = round(s.optDouble("heat", 20) + dir * step, f);
            post(url, token, cmd("ThermostatTemperatureSetpoint.SetHeat", new JSONObject().put("heatCelsius", v)));
            s.put("heat", v);
        } else if ("COOL".equals(mode)) {
            double v = round(s.optDouble("cool", 24) + dir * step, f);
            post(url, token, cmd("ThermostatTemperatureSetpoint.SetCool", new JSONObject().put("coolCelsius", v)));
            s.put("cool", v);
        } else if ("HEATCOOL".equals(mode)) {
            double hv = round(s.optDouble("heat", 20) + dir * step, f), cv = round(s.optDouble("cool", 24) + dir * step, f);
            post(url, token, cmd("ThermostatTemperatureSetpoint.SetRange", new JSONObject().put("heatCelsius", hv).put("coolCelsius", cv)));
            s.put("heat", hv).put("cool", cv);
        } else {
            throw new Exception("Nest is off");
        }
        prefs(ctx).edit().putString("nestState", s.toString()).apply();
        Widgets.redrawNest(ctx);
        return s;
    }

    /** Eco on (away) or off. Blocking. */
    static void eco(Context ctx, boolean on) throws Exception {
        JSONObject s = state(ctx);
        if (s.optString("name").isEmpty()) s = refresh(ctx);
        if (s.optString("name").isEmpty()) throw new Exception("No thermostat");
        post(SDM + s.optString("name") + ":executeCommand", token(ctx), cmd("ThermostatEco.SetMode", new JSONObject().put("mode", on ? "MANUAL_ECO" : "OFF")));
        prefs(ctx).edit().putString("nestState", s.put("eco", on ? "MANUAL_ECO" : "OFF").toString()).apply();
        Widgets.redrawNest(ctx);
    }

    private static JSONObject cmd(String c, JSONObject params) throws JSONException {
        return new JSONObject().put("command", "sdm.devices.commands." + c).put("params", params);
    }

    /** Keeps setpoints on the thermostat's own steps: 0.5 °C, or whole °F. */
    private static double round(double c, boolean f) {
        if (f) return (Math.round(c * 9 / 5 + 32) - 32) * 5 / 9.0;
        return Math.round(c * 2) / 2.0;
    }

    // ---- Last doorbell ring, with a picture when the doorbell offers one ----

    /** { at, kind: "ring"|"person", device } and the picture in files/doorbell.jpg */
    static JSONObject lastRing(Context ctx) {
        try {
            return new JSONObject(prefs(ctx).getString("lastRing", "{}"));
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    private static void lastRing(Context ctx, String kind, String device, long at, String deviceName, JSONObject ev, String token) {
        try {
            JSONObject r = new JSONObject().put("at", at).put("kind", kind).put("device", device).put("image", false);
            // Older Nest doorbells give a still for each event (newer ones don't: then there's no picture).
            String eventId = ev == null ? "" : ev.optString("eventId");
            if (!eventId.isEmpty()) {
                try {
                    JSONObject res = post(SDM + deviceName + ":executeCommand", token, cmd("CameraEventImage.GenerateImage", new JSONObject().put("eventId", eventId)));
                    JSONObject results = res.optJSONObject("results");
                    if (results != null && !results.optString("url").isEmpty()) {
                        try (Response img = web.newCall(new Request.Builder().url(results.optString("url") + "?width=640")
                            .header("Authorization", "Basic " + results.optString("token")).build()).execute()) {
                            if (img.isSuccessful()) {
                                java.io.File tmp = new java.io.File(ctx.getFilesDir(), "doorbell.tmp");
                                try (java.io.FileOutputStream out = new java.io.FileOutputStream(tmp)) { out.write(img.body().bytes()); }
                                if (tmp.renameTo(new java.io.File(ctx.getFilesDir(), "doorbell.jpg"))) r.put("image", true);
                            }
                        }
                    }
                } catch (Exception e) {
                    Log.w(TAG, "doorbell image", e);
                }
            }
            prefs(ctx).edit().putString("lastRing", r.toString()).apply();
            Widgets.redrawDoorbell(ctx);
        } catch (JSONException ignored) {}
    }

    private static long parseTime(String iso) {
        try {
            if (android.os.Build.VERSION.SDK_INT >= 26) return java.time.Instant.parse(iso).toEpochMilli();
        } catch (Exception ignored) {}
        return 0;
    }

    private static void notify(Context ctx, String channel, String channelName, int importance, int id, String title, String text) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm.getNotificationChannel(channel) == null) nm.createNotificationChannel(new NotificationChannel(channel, channelName, importance));
        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        android.app.Notification n = new android.app.Notification.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_stat_wifi)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
            .setContentIntent(PendingIntent.getActivity(ctx, 31, open, PendingIntent.FLAG_IMMUTABLE))
            .build();
        try {
            nm.notify(id, n);
        } catch (SecurityException ignored) {}
    }
}
