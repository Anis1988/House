package com.claude.house;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;

/** Bridge from the web UI to the LIFX bulbs, the bedtime alarm and app housekeeping. */
@CapacitorPlugin(name = "Lights")
public class LightsPlugin extends Plugin {
    // Scans take seconds; keep them off the command queue so taps stay instant.
    private final ExecutorService scans = Executors.newSingleThreadExecutor();
    private final ExecutorService commands = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        Bedtime.schedule(getContext());
        SceneTimers.schedule(getContext());
        Presence.register(getContext());
        NestWatch.schedule(getContext());
        WifiLog.schedule(getContext());
        VacationMode.schedule(getContext());
        // The app was opened: check home/away now instead of waiting for the next background check.
        new Thread(() -> Presence.evaluate(getContext())).start();
    }

    // ---- Your own scenes and scene timers ----

    @PluginMethod
    public void getScenes(PluginCall call) {
        try {
            JSObject r = new JSObject();
            r.put("scenes", new JSArray(SceneTimers.scenes(getContext()).toString()));
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** { scenes: [...] } replaces the whole list. */
    @PluginMethod
    public void setScenes(PluginCall call) {
        SceneTimers.saveScenes(getContext(), call.getArray("scenes", new JSArray()));
        Widgets.redrawAll(getContext());
        call.resolve();
    }

    // House scenes can wait on a TV waking up; keep that off the light command queue.
    private final ExecutorService house = Executors.newCachedThreadPool();

    /** { scene: {...}, fade?: seconds } runs a house scene (saved or not, for "Try it"). → { failed: [part names] } */
    @PluginMethod
    public void runScene(PluginCall call) {
        JSObject scene = call.getObject("scene");
        int fade = call.getInt("fade", 0);
        if (scene == null) {
            call.reject("No scene");
            return;
        }
        house.execute(() -> {
            java.util.List<String> failed = SceneTimers.runScene(getContext(), scene, fade * 1000);
            LightsWidget.redraw(getContext());
            JSObject r = new JSObject();
            r.put("failed", new JSArray(failed));
            call.resolve(r);
        });
    }

    /** Puts the built-in scenes back if any were deleted. → { scenes } */
    @PluginMethod
    public void restoreScenes(PluginCall call) {
        try {
            JSObject r = new JSObject();
            r.put("scenes", new JSArray(SceneTimers.restoreBuiltIns(getContext()).toString()));
            Widgets.redrawAll(getContext());
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** { creds: {...} } logins for the TV, screen, Nest and Wyze, so timers can use them with the app closed. */
    @PluginMethod
    public void setCreds(PluginCall call) {
        JSObject c = call.getObject("creds");
        if (c != null) {
            // Keep a Wyze token the native side refreshed since the page last saw it.
            org.json.JSONObject old = HouseActions.creds(getContext());
            if (old.optString("wyzeRefresh").length() > 0 && c.optString("wyzeRefresh").equals(old.optString("wyzeRefreshFrom"))) {
                c.put("wyzeAccess", old.optString("wyzeAccess"));
                c.put("wyzeRefresh", old.optString("wyzeRefresh"));
                c.put("wyzeRefreshFrom", old.optString("wyzeRefreshFrom"));
            }
            HouseActions.saveCreds(getContext(), c);
            NestWatch.schedule(getContext());
        }
        call.resolve();
    }

    // ---- Vacation mode ----

    @PluginMethod
    public void getVacation(PluginCall call) {
        try {
            JSObject r = new JSObject(VacationMode.settings(getContext()).toString());
            r.put("next", VacationMode.next(getContext()));
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** { on, from: "sunset" | minutes, until: minutes } */
    @PluginMethod
    public void setVacation(PluginCall call) {
        try {
            org.json.JSONObject s = new org.json.JSONObject()
                .put("on", Boolean.TRUE.equals(call.getBoolean("on", false)))
                .put("until", call.getInt("until", 23 * 60 + 30));
            Object from = call.getData().opt("from");
            s.put("from", from instanceof Number ? ((Number) from).intValue() : (Object) "sunset");
            VacationMode.save(getContext(), s);
            Widgets.redrawAll(getContext());
            getVacation(call);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** { lat, lon } for sunrise and sunset timers. */
    @PluginMethod
    public void setLocation(PluginCall call) {
        SceneTimers.setLocation(getContext(), call.getDouble("lat", 0.0), call.getDouble("lon", 0.0));
        call.resolve();
    }

    @PluginMethod
    public void getTimers(PluginCall call) {
        try {
            JSObject r = new JSObject();
            r.put("timers", new JSArray(SceneTimers.timers(getContext()).toString()));
            r.put("next", getContext().getSharedPreferences(Lifx.PREFS, 0).getLong("timerAt", 0));
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** { timers: [...] } replaces the whole list and arms the next alarm. */
    @PluginMethod
    public void setTimers(PluginCall call) {
        SceneTimers.saveTimers(getContext(), call.getArray("timers", new JSArray()));
        getTimers(call);
    }

    private JSObject lights(Map<String, Lifx.Light> lights) throws Exception {
        JSObject r = new JSObject();
        r.put("lights", new JSArray(Lifx.toJson(lights).toString()));
        r.put("subnet", Lifx.subnet(getContext()));
        return r;
    }

    /** Bulbs from the last scan, instantly. */
    @PluginMethod
    public void cached(PluginCall call) {
        try {
            call.resolve(lights(Lifx.cached(getContext())));
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** { timeout?: ms, range?: "192.168.50" } */
    @PluginMethod
    public void scan(PluginCall call) {
        int timeout = call.getInt("timeout", 2500);
        String range = call.getString("range", null);
        scans.execute(() -> {
            try {
                Map<String, Lifx.Light> found = Lifx.scan(getContext(), timeout, range);
                LightsWidget.redraw(getContext());
                call.resolve(lights(found));
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void forget(PluginCall call) {
        Lifx.forget(getContext());
        LightsWidget.redraw(getContext());
        call.resolve();
    }

    /** ids: list of bulb ids, or missing for all. */
    private static List<String> ids(PluginCall call) {
        JSArray a = call.getArray("ids", null);
        if (a == null) return null;
        List<String> out = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) out.add(a.optString(i));
        return out;
    }

    private void done(PluginCall call, int confirmed) {
        LightsWidget.redraw(getContext());
        JSObject r = new JSObject();
        r.put("confirmed", confirmed);
        call.resolve(r);
    }

    /** { ids?, on, duration? } */
    @PluginMethod
    public void power(PluginCall call) {
        List<String> ids = ids(call);
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", true));
        int duration = call.getInt("duration", on ? 300 : 500);
        commands.execute(() -> done(call, Lifx.setPower(getContext(), ids, on, duration)));
    }

    /** { ids?, hue?: 0-360, sat?: 0-100, bri?: 0-100, kelvin?, duration? }; missing values are kept. */
    @PluginMethod
    public void color(PluginCall call) {
        List<String> ids = ids(call);
        Double hue = call.getDouble("hue"), sat = call.getDouble("sat"), bri = call.getDouble("bri");
        int h = hue == null ? -1 : (int) Math.round(((hue % 360 + 360) % 360) / 360.0 * 65535);
        int s = sat == null ? -1 : (int) Math.round(Math.max(0, Math.min(100, sat)) / 100.0 * 65535);
        int b = bri == null ? -1 : (int) Math.round(Math.max(0, Math.min(100, bri)) / 100.0 * 65535);
        int k = call.getInt("kelvin", 0);
        int duration = call.getInt("duration", 200);
        commands.execute(() -> done(call, Lifx.setColor(getContext(), ids, h, s, b, k, duration)));
    }

    /** { name: "movie" | "night" | "bright" | "on" | "off" } */
    @PluginMethod
    public void scene(PluginCall call) {
        String name = call.getString("name", "");
        commands.execute(() -> {
            Lifx.scene(getContext(), name);
            done(call, 0);
        });
    }

    @PluginMethod
    public void getBedtime(PluginCall call) {
        JSObject r = new JSObject();
        r.put("on", Bedtime.enabled(getContext()));
        r.put("minutes", Bedtime.minutes(getContext()));
        r.put("next", Bedtime.next(getContext()));
        call.resolve(r);
    }

    /** { on, minutes } — minutes after midnight. */
    @PluginMethod
    public void setBedtime(PluginCall call) {
        Bedtime.set(getContext(), Boolean.TRUE.equals(call.getBoolean("on", false)), call.getInt("minutes", 23 * 60 + 30));
        Widgets.redrawAll(getContext());
        getBedtime(call);
    }

    @PluginMethod
    public void appVersion(PluginCall call) {
        JSObject r = new JSObject();
        try {
            PackageInfo p = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            r.put("version", p.versionName);
        } catch (Exception e) {
            r.put("version", "0");
        }
        call.resolve(r);
    }

    // Release downloads, and the sign-up / sign-in pages the device setups send you to.
    private static final String[] OPEN_OK = {
        "https://github.com/Anis1988/House/",
        "https://nestservices.google.com/",
        "https://console.nest.google.com/",
        "https://console.cloud.google.com/",
        "https://developers.google.com/nest/",
        "https://developer-api-console.wyze.com/",
        "https://cloud.lifx.com/",
    };

    /** Opens a link in the browser; only the links above. */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        boolean ok = false;
        for (String prefix : OPEN_OK) ok |= url.startsWith(prefix);
        if (!ok) {
            call.reject("Link not allowed");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    /** The page's theme switch, so the system bars match. */
    @PluginMethod
    public void setTheme(PluginCall call) {
        boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", true));
        if (getActivity() instanceof MainActivity) {
            MainActivity activity = (MainActivity) getActivity();
            activity.runOnUiThread(() -> activity.setThemeDark(dark));
        }
        call.resolve();
    }
}
