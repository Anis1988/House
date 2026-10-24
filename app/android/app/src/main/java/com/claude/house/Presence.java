package com.claude.house;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.RouteInfo;
import java.net.Inet4Address;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Who's home for the phone running this app: Android tells us right away when it joins or
 * leaves a Wi-Fi network (even with the app closed), so there's no waiting for a scan.
 * "Home" is the Wi-Fi whose router address was saved when this phone was added at home.
 * Away counts after 2 minutes off the home Wi-Fi, so a short drop doesn't trigger anything.
 */
final class Presence {
    static final String KEY = "this-phone";
    static final String ACTION_NET = "com.claude.house.NET_CHANGED";
    static final String ACTION_CHECK = "com.claude.house.PRESENCE_CHECK";
    private static final long AWAY_AFTER = 2 * 60_000L;

    private Presence() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(Lifx.PREFS, Context.MODE_PRIVATE);
    }

    /** The router address and network of the Wi-Fi this phone is on now, or null when not on Wi-Fi. */
    static String[] currentWifi(Context ctx) {
        ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        for (Network n : cm.getAllNetworks()) {
            NetworkCapabilities caps = cm.getNetworkCapabilities(n);
            if (caps == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) continue;
            LinkProperties lp = cm.getLinkProperties(n);
            if (lp == null) continue;
            String gateway = null, subnet = null;
            for (RouteInfo r : lp.getRoutes()) {
                if (r.isDefaultRoute() && r.getGateway() instanceof Inet4Address) gateway = r.getGateway().getHostAddress();
            }
            for (LinkAddress la : lp.getLinkAddresses()) {
                if (la.getAddress() instanceof Inet4Address) {
                    String ip = la.getAddress().getHostAddress();
                    subnet = ip.substring(0, ip.lastIndexOf('.'));
                }
            }
            if (gateway != null && subnet != null) return new String[] {gateway, subnet};
        }
        return null;
    }

    /** True when this phone is on the home Wi-Fi right now. */
    static boolean atHome(Context ctx) {
        String gw = prefs(ctx).getString("homeGateway", "");
        if (gw.isEmpty()) return !Lifx.subnet(ctx).isEmpty() && currentWifi(ctx) != null; // not set up: any Wi-Fi
        String[] now = currentWifi(ctx);
        return now != null && now[0].equals(gw) && now[1].equals(prefs(ctx).getString("homeSubnet", ""));
    }

    /** "Add this phone" at home: remembers this Wi-Fi as home. Returns false if not on Wi-Fi. */
    static boolean rememberHome(Context ctx) {
        String[] now = currentWifi(ctx);
        if (now == null) return false;
        prefs(ctx).edit().putString("homeGateway", now[0]).putString("homeSubnet", now[1]).putLong("lostAt", 0).apply();
        setState(ctx, true);
        return true;
    }

    static boolean tracked(Context ctx) {
        JSONArray people = WifiWatch.settings(ctx).optJSONArray("people");
        for (int i = 0; people != null && i < people.length(); i++) {
            if (KEY.equals(people.optJSONObject(i).optString("key"))) return true;
        }
        return false;
    }

    private static PendingIntent netIntent(Context ctx) {
        Intent i = new Intent(ctx, ActionReceiver.class).setAction(ACTION_NET);
        // Mutable: Android adds the network details to it.
        return PendingIntent.getBroadcast(ctx, 5, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
    }

    private static PendingIntent checkIntent(Context ctx) {
        Intent i = new Intent(ctx, ActionReceiver.class).setAction(ACTION_CHECK);
        return PendingIntent.getBroadcast(ctx, 6, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // Live listener while the app's process is around: hears Wi-Fi dropping right away.
    private static ConnectivityManager.NetworkCallback live;

    /**
     * Listen for Wi-Fi changes while this phone is in Who's home. Called on change, app start and boot.
     * Android only wakes a closed app when a network connects (arriving), never when one drops, so
     * leaving is caught by the live listener while the app is around, and otherwise by a quick
     * check every few minutes (just asks Android which Wi-Fi it's on; no scan).
     */
    static synchronized void register(Context ctx) {
        Context app = ctx.getApplicationContext();
        ConnectivityManager cm = (ConnectivityManager) app.getSystemService(Context.CONNECTIVITY_SERVICE);
        try {
            cm.unregisterNetworkCallback(netIntent(app));
        } catch (Exception ignored) {}
        if (live != null) {
            try {
                cm.unregisterNetworkCallback(live);
            } catch (Exception ignored) {}
            live = null;
        }
        AlarmManager am = (AlarmManager) app.getSystemService(Context.ALARM_SERVICE);
        if (!tracked(app)) {
            am.cancel(checkIntent(app));
            return;
        }
        NetworkRequest req = new NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build();
        cm.registerNetworkCallback(req, netIntent(app));
        live = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onLost(Network n) { later(app); }

            @Override
            public void onAvailable(Network n) { later(app); }
        };
        cm.registerNetworkCallback(req, live);
        checkAt(app, System.currentTimeMillis() + TICK);
    }

    private static final long TICK = 3 * 60_000L;

    private static void later(Context app) {
        new Thread(() -> {
            try {
                Thread.sleep(1500); // let the network settle
                evaluate(app);
            } catch (Exception ignored) {}
        }).start();
    }

    private static void checkAt(Context ctx, long at) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (android.os.Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, checkIntent(ctx));
        } else {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, checkIntent(ctx));
        }
    }

    /**
     * A Wi-Fi change or a follow-up check. Home → home now (arrive scene if that's new).
     * Not home → start the 2-minute clock, then away (leave scene if no one else is home).
     * Blocking.
     */
    static synchronized void evaluate(Context ctx) {
        if (!tracked(ctx)) return;
        long now = System.currentTimeMillis();
        if (atHome(ctx)) {
            prefs(ctx).edit().putLong("lostAt", 0).apply();
            checkAt(ctx, now + TICK);
            if (!isHome(ctx)) {
                setState(ctx, true);
                WifiWatch.arrived(ctx);
            }
            return;
        }
        long lostAt = prefs(ctx).getLong("lostAt", 0);
        if (lostAt == 0) {
            lostAt = now;
            prefs(ctx).edit().putLong("lostAt", lostAt).apply();
        }
        if (now - lostAt >= AWAY_AFTER) {
            checkAt(ctx, now + TICK);
            if (isHome(ctx)) {
                setState(ctx, false);
                WifiWatch.left(ctx);
            }
        } else {
            // Wi-Fi may come back (or still be connecting): look again soon, and at the 2-minute mark.
            checkAt(ctx, Math.min(now + 20_000, lostAt + AWAY_AFTER));
        }
    }

    static boolean isHome(Context ctx) {
        JSONObject st = WifiWatch.presence(ctx).optJSONObject(KEY);
        return st != null && st.optBoolean("home");
    }

    static void setState(Context ctx, boolean home) {
        JSONObject all = WifiWatch.presence(ctx);
        try {
            all.put(KEY, new JSONObject().put("home", home).put("misses", 0).put("since", System.currentTimeMillis()));
        } catch (JSONException ignored) {}
        prefs(ctx).edit().putString("presence", all.toString()).apply();
    }
}
