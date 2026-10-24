package com.claude.house;

import java.util.Iterator;
import java.util.concurrent.TimeUnit;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The lights part of a scene through LIFX's cloud (api.lifx.com), for when the phone isn't on
 * the home Wi-Fi and can't reach the bulbs directly. Needs a personal token from cloud.lifx.com.
 */
final class LifxCloud {
    private static final OkHttpClient http = new OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build();

    private LifxCloud() {}

    /** Same scene format as Lifx.runCustom. Blocking; throws if LIFX didn't accept it. */
    static void run(String token, JSONObject scene, int fadeMs) throws Exception {
        JSONObject wanted = scene.optJSONObject("lights");
        if (wanted == null) return;
        double duration = (fadeMs > 0 ? fadeMs : 800) / 1000.0;
        JSONArray states = new JSONArray();
        // "Every light" first, so lights set one by one win.
        if (wanted.has("*")) states.put(state("all", wanted.getJSONObject("*"), duration));
        for (Iterator<String> it = wanted.keys(); it.hasNext(); ) {
            String id = it.next();
            if (!"*".equals(id)) states.put(state("id:" + id, wanted.getJSONObject(id), duration));
        }
        if (states.length() == 0) return;
        String body = new JSONObject().put("states", states).toString();
        try (Response r = http.newCall(new Request.Builder().url("https://api.lifx.com/v1/lights/states")
            .header("Authorization", "Bearer " + token)
            .put(RequestBody.create(body, MediaType.get("application/json"))).build()).execute()) {
            if (!r.isSuccessful()) throw new Exception("LIFX cloud " + r.code());
        }
    }

    private static JSONObject state(String selector, JSONObject s, double duration) throws Exception {
        JSONObject st = new JSONObject().put("selector", selector).put("duration", duration);
        if ("off".equals(s.optString("mode"))) return st.put("power", "off");
        st.put("power", "on");
        if (s.has("bri")) st.put("brightness", Math.max(1, Math.min(100, s.optInt("bri"))) / 100.0);
        if (s.has("hue") && s.optInt("sat", 0) > 0) st.put("color", "hue:" + s.optInt("hue") + " saturation:" + s.optInt("sat") / 100.0);
        else if (s.optInt("kelvin", 0) > 0) st.put("color", "kelvin:" + s.optInt("kelvin"));
        return st;
    }
}
