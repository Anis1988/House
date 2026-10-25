package com.claude.house;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;
import androidx.core.content.ContextCompat;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The Lights widgets: drawing each one for its current size, and what their buttons do.
 * Buttons send explicit broadcasts to ActionReceiver (not exported), which calls handle().
 */
final class Widgets {
    static final String ACTION = "com.claude.house.WIDGET_TAP";

    private Widgets() {}

    static final Class<?>[] PROVIDERS = {
        ToggleWidget.class, OneLightWidget.class, ScenesWidget.class, RoomsWidget.class, BrightWidget.class, AwayWidget.class,
    };

    // ---- Taps ----

    private static PendingIntent tap(Context ctx, String op, String arg) {
        Intent i = new Intent(ctx, ActionReceiver.class).setAction(ACTION).putExtra("op", op).putExtra("arg", arg);
        int code = (op + "|" + arg).hashCode();
        return PendingIntent.getBroadcast(ctx, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent open(Context ctx) {
        return PendingIntent.getActivity(ctx, 200, new Intent(ctx, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
    }

    /** A widget button was tapped. Blocking. */
    static void handle(Context ctx, String op, String arg) {
        Map<String, Lifx.Light> lights = Lifx.cached(ctx);
        try {
            switch (op) {
                case "all": {
                    boolean anyOn = false;
                    for (Lifx.Light l : lights.values()) anyOn |= l.on;
                    Lifx.setPower(ctx, null, !anyOn, anyOn ? 800 : 400);
                    break;
                }
                case "light": {
                    Lifx.Light l = lights.get(arg);
                    if (l != null) Lifx.setPower(ctx, java.util.Collections.singletonList(arg), !l.on, 400);
                    break;
                }
                case "room": {
                    List<String> ids = new ArrayList<>();
                    boolean anyOn = false;
                    for (Lifx.Light l : lights.values()) if (arg.equals(group(l))) { ids.add(l.id); anyOn |= l.on; }
                    if (!ids.isEmpty()) Lifx.setPower(ctx, ids, !anyOn, anyOn ? 800 : 400);
                    break;
                }
                case "scene": {
                    JSONArray all = SceneTimers.scenes(ctx);
                    for (int i = 0; i < all.length(); i++) {
                        JSONObject s = all.getJSONObject(i);
                        if (arg.equals(s.optString("id"))) { SceneTimers.runScene(ctx, s, 0); break; }
                    }
                    break;
                }
                case "bri": {
                    // Brighter/darker in steps of 20 for the lights that are on (all of them if none are).
                    List<String> ids = new ArrayList<>();
                    for (Lifx.Light l : lights.values()) if (l.on) ids.add(l.id);
                    boolean wasOff = ids.isEmpty();
                    if (wasOff) ids.addAll(lights.keySet());
                    int now = wasOff ? 0 : avgPct(lights);
                    int next = Math.max(5, Math.min(100, ("up".equals(arg) ? now + 20 : now - 20) / 5 * 5));
                    if (wasOff && !"up".equals(arg)) break;
                    Lifx.setColor(ctx, ids, -1, -1, Lifx.pct(next), -1, 300);
                    if (wasOff) Lifx.setPower(ctx, ids, true, 300);
                    break;
                }
                case "vacation": {
                    JSONObject v = VacationMode.settings(ctx);
                    v.put("on", !v.optBoolean("on"));
                    VacationMode.save(ctx, v);
                    break;
                }
                case "bedtime":
                    Bedtime.set(ctx, !Bedtime.enabled(ctx), Bedtime.minutes(ctx));
                    break;
                default:
                    break;
            }
        } catch (Exception ignored) {}
        redrawAll(ctx);
    }

    private static String group(Lifx.Light l) {
        return l.group == null || l.group.isEmpty() ? "Other" : l.group;
    }

    private static int avgPct(Map<String, Lifx.Light> lights) {
        int n = 0, sum = 0;
        for (Lifx.Light l : lights.values()) if (l.on) { n++; sum += Math.round(l.bri / 65535f * 100); }
        return n == 0 ? 0 : Math.round(sum / (float) n);
    }

    // ---- Drawing ----

    /** Redraws every Lights widget on the home screen (after any change to the lights). */
    static void redrawAll(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        for (Class<?> cls : PROVIDERS) {
            for (int id : mgr.getAppWidgetIds(new ComponentName(ctx, cls))) draw(ctx, mgr, cls, id);
        }
        LightsWidget.redrawOnly(ctx);
    }

    static void draw(Context ctx, AppWidgetManager mgr, Class<?> cls, int id) {
        Bundle o = mgr.getAppWidgetOptions(id);
        int w = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250), h = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 110);
        RemoteViews v;
        if (cls == ToggleWidget.class) v = toggle(ctx);
        else if (cls == OneLightWidget.class) v = one(ctx, id);
        else if (cls == ScenesWidget.class) v = scenes(ctx, w, h);
        else if (cls == RoomsWidget.class) v = rooms(ctx, h);
        else if (cls == BrightWidget.class) v = bright(ctx);
        else v = away(ctx);
        mgr.updateAppWidget(id, v);
    }

    /** A widget drawn for a given size without placing it (for checking layouts). */
    static RemoteViews preview(Context ctx, String kind, int w, int h) {
        switch (kind) {
            case "one": {
                Map<String, Lifx.Light> ls = Lifx.cached(ctx);
                if (!ls.isEmpty()) ctx.getSharedPreferences(Lifx.PREFS, Context.MODE_PRIVATE).edit().putString("wone_-1", ls.keySet().iterator().next()).apply();
                return one(ctx, -1);
            }
            case "scenes": return scenes(ctx, w, h);
            case "rooms": return rooms(ctx, h);
            case "bright": return bright(ctx);
            case "away": return away(ctx);
            default: return toggle(ctx);
        }
    }

    private static int color(Context ctx, int res) {
        return ContextCompat.getColor(ctx, res);
    }

    private static RemoteViews toggle(Context ctx) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_toggle);
        Map<String, Lifx.Light> lights = Lifx.cached(ctx);
        int on = 0;
        for (Lifx.Light l : lights.values()) if (l.on) on++;
        v.setImageViewResource(R.id.wl_badge, on > 0 ? R.drawable.wl_badge : R.drawable.wl_badge_off);
        v.setTextViewText(R.id.wl_name, "Lights");
        v.setTextViewText(R.id.wl_state, lights.isEmpty() ? "Open app" : on == 0 ? "All off" : on == lights.size() ? "All on" : on + " on");
        v.setOnClickPendingIntent(R.id.wl_root, lights.isEmpty() ? open(ctx) : tap(ctx, "all", ""));
        return v;
    }

    static String oneLightId(Context ctx, int widgetId) {
        return ctx.getSharedPreferences(Lifx.PREFS, Context.MODE_PRIVATE).getString("wone_" + widgetId, "");
    }

    private static RemoteViews one(Context ctx, int widgetId) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_one);
        Lifx.Light l = Lifx.cached(ctx).get(oneLightId(ctx, widgetId));
        if (l == null) {
            v.setTextViewText(R.id.wl_name, "One light");
            v.setTextViewText(R.id.wl_state, "Tap to pick");
            v.setImageViewResource(R.id.wl_badge, R.drawable.wl_badge_off);
            Intent pick = new Intent(ctx, OneLightConfig.class).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
            v.setOnClickPendingIntent(R.id.wl_root, PendingIntent.getActivity(ctx, 300 + widgetId, pick, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            return v;
        }
        v.setTextViewText(R.id.wl_name, l.label);
        v.setTextViewText(R.id.wl_state, l.on ? Math.round(l.bri / 65535f * 100) + "%" : "Off");
        v.setImageViewResource(R.id.wl_badge, l.on ? R.drawable.wl_badge : R.drawable.wl_badge_off);
        v.setOnClickPendingIntent(R.id.wl_root, tap(ctx, "light", l.id));
        return v;
    }

    private static final int[] S = {R.id.wl_s0, R.id.wl_s1, R.id.wl_s2, R.id.wl_s3, R.id.wl_s4, R.id.wl_s5, R.id.wl_s6, R.id.wl_s7};
    private static final int[] SB = {R.id.wl_sb0, R.id.wl_sb1, R.id.wl_sb2, R.id.wl_sb3, R.id.wl_sb4, R.id.wl_sb5, R.id.wl_sb6, R.id.wl_sb7};
    private static final int[] SI = {R.id.wl_si0, R.id.wl_si1, R.id.wl_si2, R.id.wl_si3, R.id.wl_si4, R.id.wl_si5, R.id.wl_si6, R.id.wl_si7};
    private static final int[] ST = {R.id.wl_st0, R.id.wl_st1, R.id.wl_st2, R.id.wl_st3, R.id.wl_st4, R.id.wl_st5, R.id.wl_st6, R.id.wl_st7};

    /** A scene's icon colour (picked in the app; built-ins have their own), as its badge drawable. */
    static int badge(JSONObject scene) {
        String c = scene.optString("color");
        if (c.isEmpty()) {
            switch (scene.optString("id")) {
                case "bright": c = "amber"; break;
                case "movie": c = "violet"; break;
                case "night": c = "coral"; break;
                case "off": c = "grey"; break;
            }
        }
        switch (c) {
            case "amber": return R.drawable.wl_badge_amber;
            case "coral": return R.drawable.wl_badge_coral;
            case "pink": return R.drawable.wl_badge_pink;
            case "violet": return R.drawable.wl_badge_violet;
            case "blue": return R.drawable.wl_badge_blue;
            case "teal": return R.drawable.wl_badge_teal;
            case "green": return R.drawable.wl_badge_green;
            case "grey": return R.drawable.wl_badge_grey;
            default: return R.drawable.wl_badge;
        }
    }

    static int icon(String name) {
        switch (name == null ? "" : name) {
            case "bulb": return R.drawable.wl_bulb;
            case "sun": return R.drawable.wl_sun;
            case "moon": return R.drawable.wl_moon;
            case "tv": return R.drawable.wl_tv;
            case "leaf": return R.drawable.wl_leaf;
            case "flame": return R.drawable.wl_flame;
            case "home": return R.drawable.wl_home;
            case "bell": return R.drawable.wl_bell;
            case "power": return R.drawable.wl_power;
            case "drop": return R.drawable.wl_drop;
            default: return R.drawable.wl_star;
        }
    }

    /** Scenes: as many buttons as fit (4 per row, 2 rows when the widget is tall enough). */
    private static RemoteViews scenes(Context ctx, int w, int h) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_scenes);
        JSONArray all = SceneTimers.scenes(ctx);
        int cols = Math.max(1, Math.min(4, w / 70)), rows = h >= 150 ? 2 : 1;
        v.setViewVisibility(R.id.wl_head, h >= 100 ? View.VISIBLE : View.GONE);
        v.setViewVisibility(R.id.wl_row1, rows == 2 ? View.VISIBLE : View.GONE);
        v.setTextViewText(R.id.wl_status, all.length() == 0 ? "Make scenes in the app" : "");
        for (int i = 0; i < 8; i++) {
            int col = i % 4, row = i / 4, index = row * cols + col;
            boolean show = col < cols && row < rows && index < all.length();
            v.setViewVisibility(S[i], col < cols && row < rows ? (show ? View.VISIBLE : View.INVISIBLE) : View.GONE);
            if (!show) continue;
            JSONObject s = all.optJSONObject(index);
            v.setTextViewText(ST[i], s.optString("name"));
            v.setImageViewResource(SI[i], icon(s.optString("icon")));
            v.setImageViewResource(SB[i], badge(s));
            v.setOnClickPendingIntent(S[i], tap(ctx, "scene", s.optString("id")));
        }
        v.setOnClickPendingIntent(R.id.wl_head, open(ctx));
        return v;
    }

    private static final int[] R_ROW = {R.id.wl_r0, R.id.wl_r1, R.id.wl_r2, R.id.wl_r3, R.id.wl_r4};
    private static final int[] R_ICON = {R.id.wl_ri0, R.id.wl_ri1, R.id.wl_ri2, R.id.wl_ri3, R.id.wl_ri4};
    private static final int[] R_NAME = {R.id.wl_rn0, R.id.wl_rn1, R.id.wl_rn2, R.id.wl_rn3, R.id.wl_rn4};
    private static final int[] R_STATE = {R.id.wl_rs0, R.id.wl_rs1, R.id.wl_rs2, R.id.wl_rs3, R.id.wl_rs4};

    /** Rooms: one row per room, as many as fit the height. */
    private static RemoteViews rooms(Context ctx, int h) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_rooms);
        Map<String, int[]> rooms = new TreeMap<>(); // room → {on, total}
        for (Lifx.Light l : Lifx.cached(ctx).values()) {
            int[] c = rooms.computeIfAbsent(group(l), k -> new int[2]);
            if (l.on) c[0]++;
            c[1]++;
        }
        int fit = Math.max(1, Math.min(5, (h - 40) / 48));
        List<String> names = new ArrayList<>(rooms.keySet());
        int totalOn = 0;
        for (int[] c : rooms.values()) totalOn += c[0];
        v.setTextViewText(R.id.wl_status, rooms.isEmpty() ? "Open the app to find lights" : totalOn == 0 ? "all off" : totalOn + " on");
        v.setViewVisibility(R.id.wl_head, h >= 90 ? View.VISIBLE : View.GONE);
        for (int i = 0; i < 5; i++) {
            boolean show = i < fit && i < names.size();
            v.setViewVisibility(R_ROW[i], show ? View.VISIBLE : View.GONE);
            if (!show) continue;
            String room = names.get(i);
            int[] c = rooms.get(room);
            v.setTextViewText(R_NAME[i], room);
            v.setTextViewText(R_STATE[i], c[0] == 0 ? "off" : c[0] == c[1] ? "on" : c[0] + " of " + c[1]);
            v.setInt(R_ROW[i], "setBackgroundResource", c[0] > 0 ? R.drawable.wl_tile_on : R.drawable.wl_tile);
            v.setInt(R_ICON[i], "setColorFilter", color(ctx, c[0] > 0 ? R.color.w_on : R.color.w_fg_muted));
            v.setOnClickPendingIntent(R_ROW[i], tap(ctx, "room", room));
        }
        v.setOnClickPendingIntent(R.id.wl_head, open(ctx));
        return v;
    }

    private static RemoteViews bright(Context ctx) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_bright);
        Map<String, Lifx.Light> lights = Lifx.cached(ctx);
        int on = 0;
        for (Lifx.Light l : lights.values()) if (l.on) on++;
        v.setTextViewText(R.id.wl_status, lights.isEmpty() ? "Open the app to find lights" : on == 0 ? "all off" : on + " of " + lights.size() + " on");
        v.setTextViewText(R.id.wl_pct, on == 0 ? "Off" : avgPct(lights) + "%");
        v.setInt(R.id.wl_pow, "setBackgroundResource", on > 0 ? R.drawable.wl_tile_on : R.drawable.wl_tile);
        int fg = color(ctx, R.color.w_fg);
        v.setInt(R.id.wl_pow_i, "setColorFilter", on > 0 ? color(ctx, R.color.w_on) : fg);
        v.setInt(R.id.wl_down_i, "setColorFilter", fg);
        v.setInt(R.id.wl_up_i, "setColorFilter", fg);
        v.setOnClickPendingIntent(R.id.wl_pow, tap(ctx, "all", ""));
        v.setOnClickPendingIntent(R.id.wl_down, tap(ctx, "bri", "down"));
        v.setOnClickPendingIntent(R.id.wl_up, tap(ctx, "bri", "up"));
        v.setOnClickPendingIntent(R.id.wl_head, open(ctx));
        return v;
    }

    private static String clock(Context ctx, int minutes) {
        java.util.Calendar c = java.util.Calendar.getInstance();
        c.set(java.util.Calendar.HOUR_OF_DAY, minutes / 60);
        c.set(java.util.Calendar.MINUTE, minutes % 60);
        return android.text.format.DateFormat.getTimeFormat(ctx).format(c.getTime());
    }

    private static RemoteViews away(Context ctx) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_away);
        JSONObject vac = VacationMode.settings(ctx);
        boolean vOn = vac.optBoolean("on");
        Object from = vac.opt("from");
        String start = from instanceof Number ? clock(ctx, ((Number) from).intValue()) : "sunset";
        v.setTextViewText(R.id.wl_vac_s, vOn ? "From " + start + " until " + clock(ctx, vac.optInt("until", 1410)) : "Random lights while you're away");
        v.setTextViewText(R.id.wl_vac_t, vOn ? "ON" : "OFF");
        v.setInt(R.id.wl_vac, "setBackgroundResource", vOn ? R.drawable.wl_tile_on : R.drawable.wl_tile);
        v.setInt(R.id.wl_vac_i, "setColorFilter", color(ctx, vOn ? R.color.w_on : R.color.w_fg_muted));
        boolean bOn = Bedtime.enabled(ctx);
        v.setTextViewText(R.id.wl_bed_s, bOn ? "All lights off at " + clock(ctx, Bedtime.minutes(ctx)) : "Every light off at a set time");
        v.setTextViewText(R.id.wl_bed_t, bOn ? "ON" : "OFF");
        v.setInt(R.id.wl_bed, "setBackgroundResource", bOn ? R.drawable.wl_tile_on : R.drawable.wl_tile);
        v.setInt(R.id.wl_bed_i, "setColorFilter", color(ctx, bOn ? R.color.w_on : R.color.w_fg_muted));
        v.setOnClickPendingIntent(R.id.wl_vac, tap(ctx, "vacation", ""));
        v.setOnClickPendingIntent(R.id.wl_bed, tap(ctx, "bedtime", ""));
        return v;
    }
}
