package com.claude.house;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.util.Log;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Background Wi-Fi check every ~15 minutes (only while it's turned on):
 * - New device alert: a notification when a device not seen before joins.
 * - Who's home: phones marked as people; when someone arrives, or the last person leaves,
 *   a scene can run. Someone counts as gone after two checks in a row without their phone,
 *   because sleeping phones skip a check now and then.
 * With the router signed in, devices are known by MAC (reliable); otherwise by address.
 *
 * Settings ("watch" in prefs): { alerts, people: [{ key, name }], arrive: "custom:<id>", leave: "custom:<id>" }
 */
final class WifiWatch {
    static final String ACTION = "com.claude.house.WIFI_CHECK";
    private static final String TAG = "WifiWatch";
    private static final String CHANNEL = "wifi";

    private WifiWatch() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(Lifx.PREFS, Context.MODE_PRIVATE);
    }

    static JSONObject settings(Context ctx) { return obj(ctx, "watch"); }
    static JSONObject presence(Context ctx) { return obj(ctx, "presence"); }

    private static JSONObject obj(Context ctx, String key) {
        try {
            return new JSONObject(prefs(ctx).getString(key, "{}"));
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    static void save(Context ctx, JSONObject s) {
        prefs(ctx).edit().putString("watch", s.toString()).apply();
        schedule(ctx);
        Presence.register(ctx);
        WifiLog.schedule(ctx);
    }

    private static boolean wanted(Context ctx) {
        JSONObject s = settings(ctx);
        JSONArray people = s.optJSONArray("people");
        return s.optBoolean("alerts") || s.optBoolean("history") || s.optBoolean("flashNew") || (people != null && people.length() > 0);
    }

    private static PendingIntent intent(Context ctx) {
        Intent i = new Intent(ctx, ActionReceiver.class).setAction(ACTION);
        return PendingIntent.getBroadcast(ctx, 4, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * Inexact on purpose: Android batches it with other wake-ups, so it costs little battery.
     * Every ~5 minutes with the router signed in and people to watch (one quick question to the
     * router), otherwise every ~15 (a network sweep). "everyMin" in the settings overrides it.
     */
    static void schedule(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        PendingIntent pi = intent(ctx);
        am.cancel(pi);
        if (!wanted(ctx)) return;
        JSONArray people = settings(ctx).optJSONArray("people");
        int chosen = settings(ctx).optInt("everyMin", 0);
        long every = chosen > 0 ? chosen * 60_000L
            : Asus.signedIn(ctx) && people != null && people.length() > 0 ? 5 * 60_000L : AlarmManager.INTERVAL_FIFTEEN_MINUTES;
        am.setInexactRepeating(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + every, every, pi);
    }

    // True when the last check knew exactly which phones are on the Wi-Fi right now (the router's
    // connected-devices list). Then one miss is enough to call someone gone.
    private static volatile boolean liveCheck;

    /** What's on the network now: key (MAC, or address without the router) → { name, ip }. Blocking. */
    static Map<String, JSONObject> online(Context ctx) {
        Map<String, JSONObject> out = new HashMap<>();
        JSONObject c = HouseActions.creds(ctx);
        liveCheck = false;
        if (!c.optString("routerPass").isEmpty()) {
            try {
                boolean live = false;
                for (JSONObject d : routerClients(ctx, c)) {
                    live |= d.optBoolean("live");
                    if (d.optBoolean("online")) out.put(d.optString("mac").toLowerCase(), d);
                }
                liveCheck = live;
                return out;
            } catch (Exception e) {
                Log.w(TAG, "router", e);
            }
        }
        String subnet = c.optString("scanRange");
        if (subnet.isEmpty()) subnet = Lifx.subnet(ctx);
        if (subnet.isEmpty()) return out; // not on Wi-Fi: nothing to say
        for (String ip : LanNet.sweep(subnet).keySet()) {
            try {
                out.put(ip, new JSONObject().put("ip", ip));
            } catch (JSONException ignored) {}
        }
        return out;
    }

    private static List<JSONObject> routerClients(Context ctx, JSONObject c) throws Exception {
        JSONObject list = Asus.clients(ctx);
        List<JSONObject> out = new ArrayList<>();
        for (Iterator<String> it = list.keys(); it.hasNext(); ) {
            String mac = it.next();
            JSONObject d = list.optJSONObject(mac);
            if (d == null || !mac.matches("(?i)[0-9a-f]{2}(:[0-9a-f]{2}){5}")) continue;
            String name = d.optString("nickName");
            if (name.isEmpty()) name = d.optString("name");
            out.add(new JSONObject().put("mac", mac).put("ip", d.optString("ip")).put("name", name)
                .put("vendor", d.optString("vendor")).put("online", "1".equals(d.optString("isOnline"))).put("live", d.optBoolean("live")));
        }
        return out;
    }

    /** One check: alerts for new devices, then who's home and the arrive/leave scenes. Blocking. */
    static void check(Context ctx) {
        if (!wanted(ctx)) return;
        // Only the home Wi-Fi shows who's there. Away (or on mobile data), this phone's own
        // presence comes from Presence; the others can't be seen, so leave them as they were.
        if (!Presence.atHome(ctx)) return;
        Map<String, JSONObject> now = online(ctx);
        if (now.isEmpty()) return;
        JSONObject s = settings(ctx);
        newDevices(ctx, s, now);
        if (s.optBoolean("history")) WifiLog.devices(ctx, now);
        presence(ctx, s, now);
        Widgets.redrawWifi(ctx);
    }

    // A scan can miss a sleepy device, so: learn quietly for the first hour (4 checks), and only
    // call a device new once it has shown up in two checks in a row.
    private static final int LEARN_CHECKS = 4;

    private static void newDevices(Context ctx, JSONObject s, Map<String, JSONObject> now) {
        Set<String> known = new HashSet<>(prefs(ctx).getStringSet("knownDevices", new HashSet<>()));
        Set<String> pending = new HashSet<>(prefs(ctx).getStringSet("pendingDevices", new HashSet<>()));
        int learned = prefs(ctx).getInt("learnChecks", 0);
        boolean learning = learned < LEARN_CHECKS;
        List<String> fresh = new ArrayList<>();
        String freshKey = null, freshName = null;
        Set<String> nextPending = new HashSet<>();
        for (Map.Entry<String, JSONObject> e : now.entrySet()) {
            String key = e.getKey();
            if (known.contains(key)) continue;
            if (learning) { known.add(key); continue; }
            if (!pending.contains(key)) { nextPending.add(key); continue; } // first sighting: wait for the next check
            known.add(key);
            JSONObject d = e.getValue();
            String name = d.optString("name");
            if (name.isEmpty()) name = d.optString("vendor");
            fresh.add((name.isEmpty() ? "Unknown device" : name) + (d.optString("ip").isEmpty() ? "" : " (" + d.optString("ip") + ")"));
            freshKey = key;
            freshName = name.isEmpty() ? "Unknown device" : name;
        }
        prefs(ctx).edit().putStringSet("knownDevices", known).putStringSet("pendingDevices", nextPending)
            .putInt("learnChecks", Math.min(LEARN_CHECKS, learned + 1)).apply();
        if (s.optBoolean("alerts") && !fresh.isEmpty()) {
            // One new device, known by its MAC through the router: offer to block it right from the alert.
            boolean canBlock = fresh.size() == 1 && freshKey.matches("(?i)[0-9a-f]{2}(:[0-9a-f]{2}){5}") && Asus.signedIn(ctx);
            notify(ctx, 20, fresh.size() == 1 ? "New device on your Wi-Fi" : fresh.size() + " new devices on your Wi-Fi", String.join(", ", fresh),
                canBlock ? freshKey : null, freshName);
        }
        if (!fresh.isEmpty() && s.optBoolean("flashNew")) WifiFlash.flash(ctx);
    }

    private static void presence(Context ctx, JSONObject s, Map<String, JSONObject> now) {
        JSONArray people = s.optJSONArray("people");
        if (people == null || people.length() == 0) return;
        JSONObject state = presence(ctx);
        boolean someoneArrived = false, someoneLeft = false;
        try {
            for (int i = 0; i < people.length(); i++) {
                JSONObject p = people.getJSONObject(i);
                String key = p.optString("key").toLowerCase();
                if (Presence.KEY.equals(key)) continue; // this phone: told right away by Android (Presence)
                JSONObject st = state.optJSONObject(key);
                if (st == null) st = new JSONObject().put("home", false).put("misses", 0);
                // The address this phone itself has: that entry is this phone again, handled by Presence.
                if (key.equals(Presence.ownIp(ctx))) continue;
                boolean seen = now.containsKey(key);
                if (!seen) for (JSONObject d : now.values()) if (key.equals(d.optString("ip"))) seen = true;
                boolean wasHome = st.optBoolean("home");
                if (seen) {
                    st.put("misses", 0).put("seenAt", System.currentTimeMillis());
                    if (!wasHome) { st.put("home", true).put("since", System.currentTimeMillis()); someoneArrived = true; }
                } else {
                    int misses = st.optInt("misses") + 1;
                    st.put("misses", misses);
                    if (wasHome && misses >= (liveCheck ? 1 : 2)) { st.put("home", false).put("since", System.currentTimeMillis()); someoneLeft = true; }
                }
                state.put(key, st);
            }
        } catch (JSONException ignored) {}
        prefs(ctx).edit().putString("presence", state.toString()).apply();
        if (someoneArrived) arrived(ctx);
        if (someoneLeft) left(ctx);
    }

    /**
     * Is anyone else still home? This phone's state is live; another phone only counts if it was
     * actually seen in the last 30 minutes (once this phone is away it can't check them any more,
     * so an old "home" mustn't keep the leave scene from ever running).
     */
    private static boolean anyoneHome(Context ctx) {
        JSONObject state = presence(ctx);
        JSONArray people = settings(ctx).optJSONArray("people");
        long now = System.currentTimeMillis();
        for (int i = 0; people != null && i < people.length(); i++) {
            String key = people.optJSONObject(i).optString("key").toLowerCase();
            JSONObject st = state.optJSONObject(key);
            if (st == null || !st.optBoolean("home")) continue;
            if (Presence.KEY.equals(key) || now - st.optLong("seenAt", st.optLong("since")) < 30 * 60_000L) return true;
        }
        return false;
    }

    /** Someone got home: run the arrive scene. */
    static void arrived(Context ctx) {
        String arrive = settings(ctx).optString("arrive");
        if (arrive.isEmpty()) return;
        List<String> failed = runFor(ctx, arrive);
        if (!failed.isEmpty()) notify(ctx, 22, "Welcome home", "Couldn't reach: " + String.join(", ", failed));
    }

    /** Someone left: when no one is home any more, run the leave scene. */
    static void left(Context ctx) {
        String leave = settings(ctx).optString("leave");
        if (leave.isEmpty() || anyoneHome(ctx)) return;
        List<String> failed = runFor(ctx, leave);
        boolean noCloud = HouseActions.creds(ctx).optString("lifxToken").isEmpty();
        if (failed.contains("Lights") && noCloud && !Presence.atHome(ctx)) {
            notify(ctx, 23, "Everyone left, but the lights didn't change",
                "Your phone isn't on the home Wi-Fi, so it can't reach the bulbs. Add a LIFX cloud token in Lights → Settings so this works when you're away.");
        } else if (!failed.isEmpty()) {
            notify(ctx, 23, "Everyone left", "Couldn't reach: " + String.join(", ", failed));
        } else {
            notify(ctx, 23, "Everyone left", "Ran your leave scene.");
        }
    }

    private static List<String> runFor(Context ctx, String which) {
        String id = which.startsWith("custom:") ? which.substring(7) : which;
        JSONObject scene = null;
        JSONArray all = SceneTimers.scenes(ctx);
        for (int i = 0; i < all.length(); i++) if (id.equals(all.optJSONObject(i).optString("id"))) scene = all.optJSONObject(i);
        if (scene == null) return new ArrayList<>();
        if (Presence.atHome(ctx)) Lifx.scan(ctx, 1500, null); // fresh bulb addresses first
        return SceneTimers.runScene(ctx, scene, 0);
    }

    /** The Block button on a new device alert. Blocking. */
    static void blockFromAlert(Context ctx, String mac, String name) {
        try {
            JSONObject names = new JSONObject().put(mac.toUpperCase(java.util.Locale.ROOT), name == null ? "Blocked device" : name);
            RouterControl.block(ctx, java.util.Collections.singletonList(mac), names, true);
            notify(ctx, 20, "Blocked " + (name == null ? "the device" : name), "It can't use the internet now. Unblock it in House → Wi-Fi.");
        } catch (Exception e) {
            notify(ctx, 20, "Couldn't block it", e.getMessage() == null ? "The router didn't answer" : e.getMessage());
        }
    }

    private static void notify(Context ctx, int id, String title, String text) {
        notify(ctx, id, title, text, null, null);
    }

    private static void notify(Context ctx, int id, String title, String text, String blockMac, String blockName) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Wi-Fi alerts", NotificationManager.IMPORTANCE_DEFAULT));
        }
        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        android.app.Notification.Builder nb = new android.app.Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_wifi)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new android.app.Notification.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(PendingIntent.getActivity(ctx, 21, open, PendingIntent.FLAG_IMMUTABLE));
        if (blockMac != null) {
            Intent block = new Intent(ctx, ActionReceiver.class).setAction(RouterControl.ACTION_BLOCK).putExtra("mac", blockMac).putExtra("name", blockName);
            PendingIntent pi = PendingIntent.getBroadcast(ctx, 24, block, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            nb.addAction(new android.app.Notification.Action.Builder(null, "Block", pi).build());
        }
        android.app.Notification n = nb.build();
        try {
            nm.notify(id, n);
        } catch (SecurityException ignored) {} // notifications turned off for the app
    }
}
