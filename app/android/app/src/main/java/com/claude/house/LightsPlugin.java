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
