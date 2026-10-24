package com.claude.house;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import android.util.Log;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import okhttp3.FormBody;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The non-light parts of a house scene, in native code so scene timers can run them with the
 * app closed: LG TV (on/off, app, volume), Samsung screen (on/off), Nest (mode, temperature,
 * Eco) and Wyze cameras (on/off). Logins come from the page (see LightsPlugin.setCreds).
 *
 * Scene parts: tv { power: "on"|"off", app?, volume? }, screen { power: "on"|"off" },
 * nest { mode: "HEAT"|"COOL"|"HEATCOOL"|"OFF"|"ECO", temp? (°C) }, cams { power: "on"|"off" }
 */
final class HouseActions {
    private static final String TAG = "HouseActions";
    private static final MediaType JSON = MediaType.get("application/json");
    private static final OkHttpClient web = new OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build();

    private HouseActions() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(Lifx.PREFS, Context.MODE_PRIVATE);
    }

    static JSONObject creds(Context ctx) {
        try {
            return new JSONObject(prefs(ctx).getString("creds", "{}"));
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    static void saveCreds(Context ctx, JSONObject c) {
        prefs(ctx).edit().putString("creds", c.toString()).apply();
    }

    /** Runs the device parts side by side. Blocking. Returns the names of the parts that failed. */
    static List<String> run(Context ctx, JSONObject scene) {
        JSONObject c = creds(ctx);
        List<String> failed = java.util.Collections.synchronizedList(new ArrayList<>());
        ExecutorService pool = Executors.newFixedThreadPool(4);
        part(pool, failed, "TV", scene.optJSONObject("tv"), (p) -> lgTv(c, p));
        part(pool, failed, "Samsung screen", scene.optJSONObject("screen"), (p) -> samsung(c, p));
        part(pool, failed, "Nest", scene.optJSONObject("nest"), (p) -> nest(ctx, c, p));
        part(pool, failed, "Cameras", scene.optJSONObject("cams"), (p) -> wyze(ctx, c, p));
        pool.shutdown();
        try {
            pool.awaitTermination(60, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {}
        return failed;
    }

    private interface Part { void run(JSONObject p) throws Exception; }

    private static void part(ExecutorService pool, List<String> failed, String name, JSONObject p, Part fn) {
        if (p == null) return;
        pool.execute(() -> {
            try {
                fn.run(p);
            } catch (Exception e) {
                Log.w(TAG, name, e);
                failed.add(name);
            }
        });
    }

    // ---- LG webOS TV ----

    private static void lgTv(JSONObject c, JSONObject p) throws Exception {
        String ip = c.optString("lgIp"), key = c.optString("lgKey"), mac = c.optString("lgMac");
        if (ip.isEmpty() || key.isEmpty()) throw new Exception("TV not set up");
        boolean on = "on".equals(p.optString("power"));
        if (!on) {
            WebSocket ws = lgConnect(ip, key, c.optString("lgManifest", "{}"), 5000);
            if (ws == null) return; // already off (doesn't answer)
            ws.send(req("ssap://system/turnOff", new JSONObject()));
            Thread.sleep(800);
            ws.close(1000, null);
            return;
        }
        WebSocket ws = lgConnect(ip, key, c.optString("lgManifest", "{}"), 4000);
        if (ws == null) {
            if (mac.isEmpty()) throw new Exception("TV MAC unknown");
            LanNet.wake(mac, ip.substring(0, ip.lastIndexOf('.')) + ".255");
            // Give it time to boot, then keep trying.
            for (int i = 0; i < 8 && ws == null; i++) {
                Thread.sleep(3000);
                ws = lgConnect(ip, key, c.optString("lgManifest", "{}"), 4000);
            }
            if (ws == null) throw new Exception("TV didn't wake");
        }
        if (!p.optString("app").isEmpty()) ws.send(req("ssap://system.launcher/launch", new JSONObject().put("id", p.optString("app"))));
        if (p.has("volume")) ws.send(req("ssap://audio/setVolume", new JSONObject().put("volume", p.optInt("volume"))));
        Thread.sleep(800);
        ws.close(1000, null);
    }

    private static String req(String uri, JSONObject payload) throws JSONException {
        return new JSONObject().put("id", "h" + System.nanoTime()).put("type", "request").put("uri", uri).put("payload", payload).toString();
    }

    /** Opens and registers with the saved key; null if the TV doesn't answer (off). */
    private static WebSocket lgConnect(String ip, String key, String manifest, long waitMs) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicBoolean ok = new AtomicBoolean(false);
        WebSocket ws = LanNet.client().newWebSocket(new Request.Builder().url("wss://" + ip + ":3001").build(), new WebSocketListener() {
            @Override
            public void onOpen(WebSocket w, Response r) {
                try {
                    JSONObject payload = new JSONObject().put("forcePairing", false).put("pairingType", "PROMPT")
                        .put("client-key", key).put("manifest", new JSONObject(manifest));
                    w.send(new JSONObject().put("id", "register").put("type", "register").put("payload", payload).toString());
                } catch (JSONException e) {
                    done.countDown();
                }
            }

            @Override
            public void onMessage(WebSocket w, String text) {
                if (text.contains("\"registered\"")) { ok.set(true); done.countDown(); }
            }

            @Override
            public void onFailure(WebSocket w, Throwable t, Response r) { done.countDown(); }
        });
        done.await(waitMs, TimeUnit.MILLISECONDS);
        if (!ok.get()) { ws.cancel(); return null; }
        return ws;
    }

    // ---- Samsung (Tizen) screen ----

    private static void samsung(JSONObject c, JSONObject p) throws Exception {
        String ip = c.optString("ssIp"), token = c.optString("ssToken"), mac = c.optString("ssMac");
        if (ip.isEmpty() || token.isEmpty()) throw new Exception("Screen not set up");
        boolean want = "on".equals(p.optString("power"));
        String state = "";
        try (Response r = LanNet.client().newBuilder().readTimeout(3, TimeUnit.SECONDS).build()
            .newCall(new Request.Builder().url("http://" + ip + ":8001/api/v2/").build()).execute()) {
            state = new JSONObject(r.body().string()).optJSONObject("device").optString("PowerState", "on");
        } catch (Exception e) {
            state = "unreachable";
        }
        if (want && "unreachable".equals(state)) {
            if (!mac.isEmpty()) LanNet.wake(mac, ip.substring(0, ip.lastIndexOf('.')) + ".255");
            return;
        }
        if (want == "on".equals(state)) return; // already as wanted
        if ("unreachable".equals(state)) return;  // off already
        String name = Base64.encodeToString("House".getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        CountDownLatch ready = new CountDownLatch(1);
        WebSocket ws = LanNet.client().newWebSocket(new Request.Builder()
            .url("wss://" + ip + ":8002/api/v2/channels/samsung.remote.control?name=" + name + "&token=" + token).build(), new WebSocketListener() {
            @Override
            public void onMessage(WebSocket w, String text) { if (text.contains("ms.channel.connect")) ready.countDown(); }

            @Override
            public void onFailure(WebSocket w, Throwable t, Response r) { ready.countDown(); }
        });
        if (!ready.await(6, TimeUnit.SECONDS)) { ws.cancel(); throw new Exception("Screen didn't answer"); }
        ws.send(new JSONObject().put("method", "ms.remote.control").put("params", new JSONObject()
            .put("Cmd", "Click").put("DataOfCmd", "KEY_POWER").put("Option", "false").put("TypeOfRemote", "SendRemoteKey")).toString());
        Thread.sleep(600);
        ws.close(1000, null);
    }

    // ---- Nest (Google Smart Device Management) ----

    private static void nest(Context ctx, JSONObject c, JSONObject p) throws Exception {
        String project = c.optString("nestProject"), refresh = c.optString("nestRefresh");
        if (project.isEmpty() || refresh.isEmpty()) throw new Exception("Nest not set up");
        String access;
        try (Response r = web.newCall(new Request.Builder().url("https://oauth2.googleapis.com/token").post(new FormBody.Builder()
            .add("client_id", c.optString("nestClient")).add("client_secret", c.optString("nestSecret"))
            .add("refresh_token", refresh).add("grant_type", "refresh_token").build()).build()).execute()) {
            access = new JSONObject(r.body().string()).optString("access_token");
        }
        if (access.isEmpty()) throw new Exception("Nest sign-in expired");
        String base = "https://smartdevicemanagement.googleapis.com/v1/";
        String device = null;
        try (Response r = web.newCall(new Request.Builder().url(base + "enterprises/" + project + "/devices")
            .header("Authorization", "Bearer " + access).build()).execute()) {
            JSONArray ds = new JSONObject(r.body().string()).optJSONArray("devices");
            for (int i = 0; ds != null && i < ds.length(); i++) {
                if ("sdm.devices.types.THERMOSTAT".equals(ds.getJSONObject(i).optString("type"))) { device = ds.getJSONObject(i).optString("name"); break; }
            }
        }
        if (device == null) throw new Exception("No thermostat");
        String mode = p.optString("mode");
        if ("ECO".equals(mode)) {
            nestCmd(base, device, access, "ThermostatEco.SetMode", new JSONObject().put("mode", "MANUAL_ECO"));
            return;
        }
        nestCmd(base, device, access, "ThermostatEco.SetMode", new JSONObject().put("mode", "OFF"));
        if (!mode.isEmpty()) nestCmd(base, device, access, "ThermostatMode.SetMode", new JSONObject().put("mode", mode));
        if (p.has("temp")) {
            double t = p.optDouble("temp");
            if ("HEAT".equals(mode)) nestCmd(base, device, access, "ThermostatTemperatureSetpoint.SetHeat", new JSONObject().put("heatCelsius", t));
            else if ("COOL".equals(mode)) nestCmd(base, device, access, "ThermostatTemperatureSetpoint.SetCool", new JSONObject().put("coolCelsius", t));
            else if ("HEATCOOL".equals(mode)) nestCmd(base, device, access, "ThermostatTemperatureSetpoint.SetRange",
                new JSONObject().put("heatCelsius", t - 1).put("coolCelsius", t + 1));
        }
    }

    private static void nestCmd(String base, String device, String access, String cmd, JSONObject params) throws Exception {
        String body = new JSONObject().put("command", "sdm.devices.commands." + cmd).put("params", params).toString();
        try (Response r = web.newCall(new Request.Builder().url(base + device + ":executeCommand")
            .header("Authorization", "Bearer " + access).post(RequestBody.create(body, JSON)).build()).execute()) {
            // Eco OFF when it's already off, or a mode it doesn't support, comes back as 400: not worth failing the scene.
            if (!r.isSuccessful() && r.code() != 400) throw new Exception("Nest " + r.code());
        }
    }

    // ---- Wyze cameras ----

    private static final String WYZE = "https://api.wyzecam.com/app";
    private static final String WYZE_VER = "2.50.6.9";

    private static void wyze(Context ctx, JSONObject c, JSONObject p) throws Exception {
        String access = c.optString("wyzeAccess");
        JSONArray cams = c.optJSONArray("wyzeCams");
        if (access.isEmpty() || cams == null) throw new Exception("Wyze not set up");
        String action = "on".equals(p.optString("power")) ? "power_on" : "power_off";
        for (int i = 0; i < cams.length(); i++) {
            JSONObject cam = cams.getJSONObject(i);
            JSONObject body = new JSONObject().put("provider_key", cam.optString("model")).put("instance_id", cam.optString("mac"))
                .put("action_key", action).put("action_params", new JSONObject()).put("custom_string", "");
            JSONObject res = wyzePost(ctx, c, "/v2/auto/run_action", body);
            if (!"1".equals(res.optString("code"))) throw new Exception("Wyze " + res.optString("code"));
        }
    }

    private static JSONObject wyzePost(Context ctx, JSONObject c, String path, JSONObject body) throws Exception {
        JSONObject res = wyzeOnce(c, path, body);
        if ("2001".equals(res.optString("code")) && !c.optString("wyzeRefresh").isEmpty()) {
            JSONObject r = wyzeOnce(c, "/user/refresh_token", new JSONObject().put("refresh_token", c.optString("wyzeRefresh")));
            JSONObject d = r.optJSONObject("data");
            if (d != null && !d.optString("access_token").isEmpty()) {
                // Remember which token the page had, so a later sync from the page doesn't undo this refresh.
                if (c.optString("wyzeRefreshFrom").isEmpty()) c.put("wyzeRefreshFrom", c.optString("wyzeRefresh"));
                c.put("wyzeAccess", d.optString("access_token"));
                if (!d.optString("refresh_token").isEmpty()) c.put("wyzeRefresh", d.optString("refresh_token"));
                saveCreds(ctx, c);
                res = wyzeOnce(c, path, body);
            }
        }
        return res;
    }

    private static JSONObject wyzeOnce(JSONObject c, String path, JSONObject body) throws Exception {
        boolean action = path.contains("run_action");
        JSONObject b = new JSONObject(body.toString())
            .put("sc", action ? "01dd431d098546f9baf5233724fa2ee2" : "9f275790cab94a72bd206c8876429f3c")
            .put("sv", action ? "2c0edc06d4c5465b8c55af207144f0d9" : "e1fe392906d54888a9b99b88de4162d7")
            .put("ts", System.currentTimeMillis()).put("phone_id", c.optString("wyzePhone", UUID.randomUUID().toString()))
            .put("access_token", c.optString("wyzeAccess")).put("app_name", "com.hualai.WyzeCam")
            .put("app_version", WYZE_VER).put("app_ver", "com.hualai.WyzeCam___" + WYZE_VER).put("phone_system_type", 1);
        try (Response r = web.newCall(new Request.Builder().url(WYZE + path).header("User-Agent", "wyze_android_" + WYZE_VER)
            .post(RequestBody.create(b.toString(), JSON)).build()).execute()) {
            return new JSONObject(r.body().string());
        }
    }
}
