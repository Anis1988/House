package com.claude.house;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Wi-Fi controls through the ASUS router (Asus): pause/block a device, Focus time, pause
 * everyone, Internet bedtime, device priority, guest Wi-Fi, Wi-Fi password, router health,
 * restart, and data use per device.
 *
 * Where the router can keep the schedule itself it does (bedtime, guest Wi-Fi expiry, weekly
 * restart), so those work with this phone away. Timed actions the router can't end by itself
 * (Focus time, pause everyone for a while, priority for a while) are ended by this phone: an
 * exact alarm, retried every 5 minutes until the phone is back on the home Wi-Fi.
 *
 * Pausing uses the router's parental controls: per MAC, MULTIFILTER_ENABLE is 0 (off),
 * 1 (time schedule = bedtime) or 2 (block). The schedule string is rules joined by "<", each
 * "W" + enable digit + 2-hex-digit day mask (bit 0 = Sunday) + start HHMM + end HHMM, offline in
 * between. Lists of devices are ">"-separated.
 */
final class RouterControl {
    static final String ACTION_TIMER = "com.claude.house.ROUTER_TIMER";
    static final String ACTION_BLOCK = "com.claude.house.ROUTER_BLOCK";
    private static final String DEFAULT_TIME = "W03E21000700<W04122000800"; // the router's own default (rules off)

    private RouterControl() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(Lifx.PREFS, Context.MODE_PRIVATE);
    }

    /** From the page: { op, ... } → result. Blocking. */
    static JSONObject op(Context ctx, JSONObject a) throws Exception {
        switch (a.optString("op")) {
            case "clients": return new JSONObject().put("get_clientlist", Asus.hook(ctx, "get_clientlist()").optJSONObject("get_clientlist"));
            case "filters": return filtersJson(ctx);
            case "block": block(ctx, macs(a), a.optJSONObject("names"), a.optBoolean("on")); return filtersJson(ctx);
            case "focus": focus(ctx, macs(a), a.optJSONObject("names"), a.optInt("minutes", 30), a.optString("label")); return status(ctx);
            case "pauseAll": pauseAll(ctx, macs(a), a.optInt("minutes")); return status(ctx);
            case "resumeAll": resumeAll(ctx); return status(ctx);
            case "endTimer": endTimer(ctx, a.optString("id")); return status(ctx);
            case "status": return status(ctx);
            case "bedtime": bedtime(ctx, macs(a), a.optJSONObject("names"), a.optBoolean("on"), a.optInt("days", 127), a.optString("start", "2200"), a.optString("end", "0700")); return filtersJson(ctx);
            case "priority": priority(ctx, a.optString("mac"), a.optString("name"), a.optBoolean("on"), a.optInt("minutes")); return status(ctx);
            case "guest": return a.has("on") ? setGuest(ctx, a) : guest(ctx);
            case "password": setPassword(ctx, a.optString("pass")); return new JSONObject();
            case "health": return health(ctx);
            case "checkUpdate": return checkUpdate(ctx);
            case "reboot": Asus.apply(ctx, Asus.map(), "reboot"); return new JSONObject();
            case "rebootSchedule": return a.has("on") ? setRebootSchedule(ctx, a) : rebootSchedule(ctx);
            case "usage": return usage(ctx, a.optInt("dura", 24));
            case "enableUsage": Asus.apply(ctx, Asus.map("bwdpi_db_enable", "1"), "restart_wrs;restart_firewall"); return new JSONObject();
            case "live": return live(ctx);
            default: throw new Exception("Unknown router action");
        }
    }

    private static List<String> macs(JSONObject a) {
        List<String> out = new ArrayList<>();
        JSONArray m = a.optJSONArray("macs");
        for (int i = 0; m != null && i < m.length(); i++) out.add(m.optString(i).toUpperCase(Locale.ROOT));
        if (a.has("mac")) out.add(a.optString("mac").toUpperCase(Locale.ROOT));
        return out;
    }

    // ---- Parental controls list ----

    private static final class Filter {
        String mac, name, enable = "0", time = DEFAULT_TIME;
    }

    private static List<Filter> filters(Context ctx) throws Exception {
        JSONObject j = Asus.nvram(ctx, "MULTIFILTER_ENABLE", "MULTIFILTER_MAC", "MULTIFILTER_DEVICENAME", "MULTIFILTER_MACFILTER_DAYTIME_V2");
        String[] macs = split(j.optString("MULTIFILTER_MAC")), names = split(j.optString("MULTIFILTER_DEVICENAME")),
            en = split(j.optString("MULTIFILTER_ENABLE")), times = split(j.optString("MULTIFILTER_MACFILTER_DAYTIME_V2"));
        List<Filter> out = new ArrayList<>();
        for (int i = 0; i < macs.length; i++) {
            if (macs[i].isEmpty()) continue;
            Filter f = new Filter();
            f.mac = macs[i].toUpperCase(Locale.ROOT);
            f.name = i < names.length && !names[i].isEmpty() ? names[i] : "Device";
            if (i < en.length && !en[i].isEmpty()) f.enable = en[i];
            if (i < times.length && !times[i].isEmpty()) f.time = times[i];
            out.add(f);
        }
        return out;
    }

    private static String[] split(String s) {
        s = s.replace("&#62", ">").replace("&#60", "<").replace("&gt;", ">").replace("&lt;", "<");
        return s.isEmpty() ? new String[0] : s.split(">", -1);
    }

    private static void saveFilters(Context ctx, List<Filter> list) throws Exception {
        StringBuilder en = new StringBuilder(), mac = new StringBuilder(), name = new StringBuilder(), time = new StringBuilder();
        for (int i = 0; i < list.size(); i++) {
            Filter f = list.get(i);
            String sep = i == 0 ? "" : ">";
            en.append(sep).append(f.enable);
            mac.append(sep).append(f.mac);
            name.append(sep).append(f.name.replaceAll("[<>]", ""));
            time.append(sep).append(f.time);
        }
        Asus.apply(ctx, Asus.map("MULTIFILTER_ALL", "1", "MULTIFILTER_ENABLE", en.toString(), "MULTIFILTER_MAC", mac.toString(),
            "MULTIFILTER_DEVICENAME", name.toString(), "MULTIFILTER_MACFILTER_DAYTIME_V2", time.toString()), "restart_firewall");
    }

    private static Filter find(List<Filter> list, String mac, JSONObject names) {
        for (Filter f : list) if (f.mac.equalsIgnoreCase(mac)) return f;
        Filter f = new Filter();
        f.mac = mac.toUpperCase(Locale.ROOT);
        f.name = names != null ? names.optString(mac, names.optString(mac.toLowerCase(Locale.ROOT), "Device")) : "Device";
        list.add(f);
        return f;
    }

    /** Does this device have a bedtime rule turned on? (Then "not blocked" means back to its schedule.) */
    private static boolean hasSchedule(Filter f) {
        for (String rule : f.time.split("<")) if (rule.length() >= 12 && rule.charAt(1) == '1') return true;
        return false;
    }

    /** { MAC: { paused, bedtime: { on, days, start, end } } } */
    private static JSONObject filtersJson(Context ctx) throws Exception {
        JSONObject out = new JSONObject();
        for (Filter f : filters(ctx)) {
            JSONObject b = null;
            for (String rule : f.time.split("<")) {
                if (rule.length() < 12 || rule.charAt(0) != 'W') continue;
                b = new JSONObject().put("on", rule.charAt(1) == '1').put("days", Integer.parseInt(rule.substring(2, 4), 16))
                    .put("start", rule.substring(4, 8)).put("end", rule.substring(8, 12));
                if (rule.charAt(1) == '1') break;
            }
            out.put(f.mac.toLowerCase(Locale.ROOT), new JSONObject().put("paused", "2".equals(f.enable))
                .put("bedtime", b != null && b.optBoolean("on") && !"0".equals(f.enable) ? b : JSONObject.NULL));
        }
        return out;
    }

    /** Block (on) or let back on: to its bedtime schedule if it has one, else free. */
    static void block(Context ctx, List<String> macs, JSONObject names, boolean on) throws Exception {
        if (macs.isEmpty()) return;
        List<Filter> list = filters(ctx);
        for (String mac : macs) {
            Filter f = find(list, mac, names);
            f.enable = on ? "2" : hasSchedule(f) ? "1" : "0";
        }
        saveFilters(ctx, list);
    }

    static void bedtime(Context ctx, List<String> macs, JSONObject names, boolean on, int days, String start, String end) throws Exception {
        if (!start.matches("\\d{4}") || !end.matches("\\d{4}")) throw new Exception("Pick a start and end time");
        String rule = String.format(Locale.ROOT, "W%d%02X%s%s", on ? 1 : 0, days & 0x7F, start, end);
        List<Filter> list = filters(ctx);
        for (String mac : macs) {
            Filter f = find(list, mac, names);
            f.time = rule;
            if (!"2".equals(f.enable)) f.enable = on ? "1" : "0";
        }
        saveFilters(ctx, list);
    }

    // ---- Timed actions this phone ends ----

    /** Pending: [{ id, kind: "unblock"|"prio", at, macs, label }]; pausedAll: { macs, at? } */
    private static JSONArray timers(Context ctx) {
        try {
            return new JSONArray(prefs(ctx).getString("routerTimers", "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    private static void saveTimers(Context ctx, JSONArray t) {
        prefs(ctx).edit().putString("routerTimers", t.toString()).apply();
        schedule(ctx);
    }

    private static void addTimer(Context ctx, String id, String kind, long at, List<String> macs, String label) throws JSONException {
        JSONArray t = new JSONArray(), old = timers(ctx);
        for (int i = 0; i < old.length(); i++) if (!id.equals(old.getJSONObject(i).optString("id"))) t.put(old.get(i));
        t.put(new JSONObject().put("id", id).put("kind", kind).put("at", at).put("macs", new JSONArray(macs)).put("label", label));
        saveTimers(ctx, t);
    }

    /** Blocks these and returns the ones that weren't blocked already (only those get let back on later). */
    private static List<String> blockNew(Context ctx, List<String> macs, JSONObject names) throws Exception {
        List<Filter> list = filters(ctx);
        List<String> fresh = new ArrayList<>();
        for (String mac : macs) {
            Filter f = find(list, mac, names);
            if (!"2".equals(f.enable)) fresh.add(f.mac);
            f.enable = "2";
        }
        saveFilters(ctx, list);
        return fresh;
    }

    static void focus(Context ctx, List<String> macs, JSONObject names, int minutes, String label) throws Exception {
        macs = blockNew(ctx, macs, names);
        if (macs.isEmpty()) throw new Exception("Already paused");
        addTimer(ctx, "focus:" + String.join(",", macs), "unblock", System.currentTimeMillis() + minutes * 60_000L, macs, label);
    }

    /** Pauses every online device except the ones kept (and the router itself). 0 minutes = until resumed. */
    static void pauseAll(Context ctx, List<String> keep, int minutes) throws Exception {
        Set<String> skip = new HashSet<>();
        for (String k : keep) skip.add(k.toUpperCase(Locale.ROOT));
        JSONObject list = Asus.hook(ctx, "get_clientlist()").optJSONObject("get_clientlist");
        String gw = Asus.nvram(ctx, "lan_hwaddr").optString("lan_hwaddr").toUpperCase(Locale.ROOT);
        List<String> macs = new ArrayList<>();
        JSONObject names = new JSONObject();
        for (Iterator<String> it = list == null ? new ArrayList<String>().iterator() : list.keys(); it.hasNext(); ) {
            String mac = it.next();
            JSONObject d = list.optJSONObject(mac);
            if (d == null || !mac.matches("(?i)[0-9a-f]{2}(:[0-9a-f]{2}){5}") || !"1".equals(d.optString("isOnline"))) continue;
            String up = mac.toUpperCase(Locale.ROOT);
            if (skip.contains(up) || up.equals(gw)) continue;
            macs.add(up);
            names.put(up, d.optString("nickName").isEmpty() ? d.optString("name") : d.optString("nickName"));
        }
        if (macs.isEmpty()) throw new Exception("Nothing to pause: every online device is kept on");
        macs = blockNew(ctx, macs, names);
        prefs(ctx).edit().putString("pausedAll", new JSONObject().put("macs", new JSONArray(macs)).put("at", minutes > 0 ? System.currentTimeMillis() + minutes * 60_000L : 0).toString()).apply();
        if (minutes > 0) addTimer(ctx, "pauseAll", "unblock", System.currentTimeMillis() + minutes * 60_000L, macs, "Everyone");
    }

    static void resumeAll(Context ctx) throws Exception {
        JSONObject p = new JSONObject(prefs(ctx).getString("pausedAll", "{}"));
        List<String> macs = new ArrayList<>();
        JSONArray m = p.optJSONArray("macs");
        for (int i = 0; m != null && i < m.length(); i++) macs.add(m.getString(i));
        block(ctx, macs, null, false);
        prefs(ctx).edit().remove("pausedAll").apply();
        endTimerQuietly(ctx, "pauseAll");
    }

    private static void endTimerQuietly(Context ctx, String id) throws JSONException {
        JSONArray t = new JSONArray(), old = timers(ctx);
        for (int i = 0; i < old.length(); i++) if (!id.equals(old.getJSONObject(i).optString("id"))) t.put(old.get(i));
        saveTimers(ctx, t);
    }

    /** Ends a timed action now (Focus time over early, priority off). */
    static void endTimer(Context ctx, String id) throws Exception {
        JSONArray old = timers(ctx);
        for (int i = 0; i < old.length(); i++) {
            JSONObject t = old.getJSONObject(i);
            if (id.equals(t.optString("id"))) { finish(ctx, t); break; }
        }
        if ("pauseAll".equals(id)) prefs(ctx).edit().remove("pausedAll").apply();
        endTimerQuietly(ctx, id);
    }

    private static void finish(Context ctx, JSONObject t) throws Exception {
        List<String> macs = new ArrayList<>();
        JSONArray m = t.optJSONArray("macs");
        for (int i = 0; m != null && i < m.length(); i++) macs.add(m.getString(i));
        if ("prio".equals(t.optString("kind"))) { for (String mac : macs) setPriority(ctx, mac, null, -1); }
        else block(ctx, macs, null, false);
    }

    private static PendingIntent timerIntent(Context ctx) {
        Intent i = new Intent(ctx, ActionReceiver.class).setAction(ACTION_TIMER);
        return PendingIntent.getBroadcast(ctx, 12, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void schedule(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        am.cancel(timerIntent(ctx));
        long next = 0;
        JSONArray t = timers(ctx);
        for (int i = 0; i < t.length(); i++) {
            long at = t.optJSONObject(i).optLong("at");
            if (next == 0 || at < next) next = at;
        }
        if (next == 0) return;
        if (android.os.Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, timerIntent(ctx));
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, timerIntent(ctx));
    }

    /** The alarm: end what's due. Away from home it can't reach the router: try again in 5 minutes. */
    static void fire(Context ctx) {
        JSONArray old = timers(ctx), keep = new JSONArray();
        long now = System.currentTimeMillis();
        for (int i = 0; i < old.length(); i++) {
            JSONObject t = old.optJSONObject(i);
            if (t == null) continue;
            if (t.optLong("at") > now + 5_000) { keep.put(t); continue; }
            try {
                finish(ctx, t);
                if ("pauseAll".equals(t.optString("id"))) prefs(ctx).edit().remove("pausedAll").apply();
            } catch (Exception e) {
                try {
                    keep.put(t.put("at", now + 5 * 60_000L).put("retrying", true));
                } catch (JSONException ignored) {}
            }
        }
        saveTimers(ctx, keep);
        Widgets.redrawWifi(ctx);
    }

    /** { timers: [...], pausedAll: { macs, at } | null, prio: { MAC: until } } */
    private static JSONObject status(Context ctx) throws JSONException {
        JSONObject p = new JSONObject(prefs(ctx).getString("pausedAll", "{}"));
        return new JSONObject().put("timers", timers(ctx)).put("pausedAll", p.has("macs") ? p : JSONObject.NULL)
            .put("prio", new JSONObject(prefs(ctx).getString("prioOn", "{}")));
    }

    // ---- Device priority (QoS rules: "<name>MAC>port>proto>transferred>priority", 0 = highest) ----

    static void priority(Context ctx, String mac, String name, boolean on, int minutes) throws Exception {
        mac = mac.toUpperCase(Locale.ROOT);
        JSONObject q = Asus.nvram(ctx, "qos_enable");
        if (!"1".equals(q.optString("qos_enable"))) {
            throw new Exception("Turn on QoS in your router first (its web page → Adaptive QoS → QoS), then try again");
        }
        setPriority(ctx, mac, on ? name : null, on ? 0 : -1);
        JSONObject pr = new JSONObject(prefs(ctx).getString("prioOn", "{}"));
        if (on) pr.put(mac, minutes > 0 ? System.currentTimeMillis() + minutes * 60_000L : 0); else pr.remove(mac);
        prefs(ctx).edit().putString("prioOn", pr.toString()).apply();
        if (on && minutes > 0) addTimer(ctx, "prio:" + mac, "prio", System.currentTimeMillis() + minutes * 60_000L, java.util.Collections.singletonList(mac), name);
        else endTimerQuietly(ctx, "prio:" + mac);
    }

    /** Sets (level 0..4) or removes (-1) this device's rule; other rules stay as they were. */
    private static void setPriority(Context ctx, String mac, String name, int level) throws Exception {
        String list = Asus.nvram(ctx, "qos_rulelist").optString("qos_rulelist").replace("&#62", ">").replace("&#60", "<").replace("&gt;", ">").replace("&lt;", "<");
        StringBuilder out = new StringBuilder();
        for (String rule : list.split("<")) {
            if (rule.isEmpty()) continue;
            String[] f = rule.split(">", -1);
            if (f.length > 1 && f[1].equalsIgnoreCase(mac)) continue;
            out.append('<').append(rule);
        }
        if (level >= 0) out.append('<').append((name == null || name.isEmpty() ? "Device" : name).replaceAll("[<>]", "")).append('>').append(mac).append(">>any>>").append(level);
        Asus.apply(ctx, Asus.map("qos_rulelist", out.toString()), "restart_qos;restart_firewall");
        if (level < 0) {
            JSONObject pr = new JSONObject(prefs(ctx).getString("prioOn", "{}"));
            pr.remove(mac);
            prefs(ctx).edit().putString("prioOn", pr.toString()).apply();
        }
    }

    // ---- Guest Wi-Fi (the first guest network on each band; the router can end it by itself) ----

    private static final String[] GUEST = {"wl0.1_bss_enabled", "wl1.1_bss_enabled", "wl0.1_ssid", "wl0.1_wpa_psk", "wl0.1_auth_mode_x", "wl0.1_expire", "wl0.1_expire_tmp"};

    static JSONObject guest(Context ctx) throws Exception {
        JSONObject j = Asus.nvram(ctx, GUEST);
        boolean on = "1".equals(j.optString("wl0.1_bss_enabled")) || "1".equals(j.optString("wl1.1_bss_enabled"));
        return new JSONObject().put("on", on).put("ssid", j.optString("wl0.1_ssid")).put("pass", j.optString("wl0.1_wpa_psk"))
            .put("open", "open".equals(j.optString("wl0.1_auth_mode_x"))).put("left", on ? j.optLong("wl0.1_expire_tmp") : 0)
            .put("expire", j.optLong("wl0.1_expire"));
    }

    /** { on, hours (0 = until turned off), ssid?, pass? } */
    static JSONObject setGuest(Context ctx, JSONObject a) throws Exception {
        boolean on = a.optBoolean("on");
        String secs = String.valueOf(Math.max(0, a.optInt("hours")) * 3600);
        Map<String, String> v = Asus.map("wl0.1_bss_enabled", on ? "1" : "0", "wl1.1_bss_enabled", on ? "1" : "0");
        if (on) { v.put("wl0.1_expire", secs); v.put("wl1.1_expire", secs); }
        String ssid = a.optString("ssid").trim(), pass = a.optString("pass");
        if (on && !ssid.isEmpty()) {
            if (pass.length() < 8 || pass.length() > 63) throw new Exception("The guest password needs 8 to 63 characters");
            for (String band : new String[]{"wl0.1", "wl1.1"}) {
                v.put(band + "_ssid", ssid);
                v.put(band + "_auth_mode_x", "psk2");
                v.put(band + "_crypto", "aes");
                v.put(band + "_wpa_psk", pass);
            }
        } else if (on && guest(ctx).optBoolean("open")) {
            throw new Exception("Your guest network has no password. Give it a name and password here first.");
        }
        Asus.apply(ctx, v, "restart_wireless;restart_firewall");
        try { Thread.sleep(3000); } catch (InterruptedException ignored) {}
        try {
            return guest(ctx);
        } catch (Exception e) {
            return new JSONObject().put("on", on); // Wi-Fi is still restarting
        }
    }

    // ---- Wi-Fi password ----

    static void setPassword(Context ctx, String pass) throws Exception {
        if (pass.length() < 8 || pass.length() > 63) throw new Exception("The Wi-Fi password needs 8 to 63 characters");
        String ifs = Asus.nvram(ctx, "wl_ifnames").optString("wl_ifnames").trim();
        int bands = Math.max(1, ifs.isEmpty() ? 2 : ifs.split("\\s+").length);
        Map<String, String> v = new HashMap<>();
        for (int i = 0; i < bands; i++) v.put("wl" + i + "_wpa_psk", pass);
        Asus.apply(ctx, v, "restart_wireless");
    }

    // ---- Health ----

    private static final Pattern SECS = Pattern.compile("\\((\\d+) secs");

    static JSONObject health(Context ctx) throws Exception {
        JSONObject a = Asus.hook(ctx, "cpu_usage(appobj);memory_usage(appobj);uptime();nvram_get(productid);nvram_get(firmver);nvram_get(buildno);nvram_get(extendno);nvram_get(webs_state_flag);nvram_get(webs_state_info)");
        Thread.sleep(1000);
        JSONObject b = Asus.hook(ctx, "cpu_usage(appobj)");
        JSONObject out = new JSONObject();
        JSONObject c1 = a.optJSONObject("cpu_usage"), c2 = b.optJSONObject("cpu_usage");
        if (c1 != null && c2 != null) {
            double used = 0, total = 0;
            for (int i = 1; i <= 16; i++) {
                if (!c1.has("cpu" + i + "_total")) continue;
                total += c2.optDouble("cpu" + i + "_total") - c1.optDouble("cpu" + i + "_total");
                used += c2.optDouble("cpu" + i + "_usage") - c1.optDouble("cpu" + i + "_usage");
            }
            if (total > 0) out.put("cpu", Math.round(used / total * 100));
        }
        JSONObject mem = a.optJSONObject("memory_usage");
        if (mem != null && mem.optDouble("mem_total") > 0) out.put("mem", Math.round(mem.optDouble("mem_used") / mem.optDouble("mem_total") * 100));
        Matcher m = SECS.matcher(a.optString("uptime"));
        if (m.find()) out.put("uptime", Long.parseLong(m.group(1)));
        out.put("model", a.optString("productid"));
        String fw = a.optString("firmver") + "." + a.optString("buildno") + (a.optString("extendno").isEmpty() ? "" : "_" + a.optString("extendno"));
        out.put("firmware", fw);
        String flag = a.optString("webs_state_flag");
        out.put("update", "1".equals(flag) || "2".equals(flag) ? a.optString("webs_state_info").replace('_', '.') : "");
        try {
            Map<String, String> t = Asus.jsVars(Asus.get(ctx, "/ajax_coretmp.asp"));
            double cpu = num(t.get("curr_coreTmp_cpu")), cpu2 = num(t.get("curr_cpuTemp")), wifi = 0;
            for (Map.Entry<String, String> e : t.entrySet()) if (e.getKey().startsWith("curr_coreTmp_") && !e.getKey().endsWith("cpu")) wifi = Math.max(wifi, num(e.getValue()));
            if (cpu > 0 || cpu2 > 0) out.put("cpuTemp", Math.round(cpu > 0 ? cpu : cpu2));
            if (wifi > 0) out.put("wifiTemp", Math.round(wifi));
        } catch (Exception ignored) {}
        return out;
    }

    private static double num(String s) {
        if (s == null) return 0;
        Matcher m = Pattern.compile("-?\\d+(\\.\\d+)?").matcher(s);
        return m.find() ? Double.parseDouble(m.group()) : 0;
    }

    static JSONObject checkUpdate(Context ctx) throws Exception {
        Asus.apply(ctx, Asus.map(), "start_webs_update");
        for (int i = 0; i < 10; i++) {
            Thread.sleep(2000);
            JSONObject j = Asus.nvram(ctx, "webs_state_update", "webs_state_flag", "webs_state_info", "webs_state_error");
            if ("1".equals(j.optString("webs_state_update"))) {
                String flag = j.optString("webs_state_flag");
                if (!"0".equals(j.optString("webs_state_error", "0")) && !j.optString("webs_state_error").isEmpty()) throw new Exception("The router couldn't check for updates");
                return new JSONObject().put("update", "1".equals(flag) || "2".equals(flag) ? j.optString("webs_state_info").replace('_', '.') : "");
            }
        }
        throw new Exception("The router didn't finish checking. Try again in a minute.");
    }

    // ---- Weekly restart (the router's own scheduler: 7 day bits Sun..Sat + HHMM) ----

    static JSONObject rebootSchedule(Context ctx) throws Exception {
        JSONObject j = Asus.nvram(ctx, "reboot_schedule_enable", "reboot_schedule");
        String s = j.optString("reboot_schedule");
        if (!s.matches("[01]{7}\\d{4}")) s = "00000000300";
        return new JSONObject().put("on", "1".equals(j.optString("reboot_schedule_enable"))).put("days", s.substring(0, 7)).put("time", s.substring(7));
    }

    static JSONObject setRebootSchedule(Context ctx, JSONObject a) throws Exception {
        String days = a.optString("days", "1000000"), time = a.optString("time", "0300");
        if (!days.matches("[01]{7}") || !time.matches("\\d{4}")) throw new Exception("Pick a day and time");
        boolean on = a.optBoolean("on") && days.contains("1");
        Asus.apply(ctx, Asus.map("reboot_schedule_enable", on ? "1" : "0", "reboot_schedule", days + time), "restart_time");
        return rebootSchedule(ctx);
    }

    // ---- Data use (the router's Traffic Analyzer) ----

    /** { enabled, devices: [{ mac, up, down }] } in bytes, for the last 24 hours or 7 days. */
    static JSONObject usage(Context ctx, int dura) throws Exception {
        JSONObject n = Asus.nvram(ctx, "bwdpi_db_enable", "dns_dpi_trf_analysis");
        boolean on = "1".equals(n.optString("bwdpi_db_enable")) || "1".equals(n.optString("dns_dpi_trf_analysis"));
        JSONObject out = new JSONObject().put("enabled", on).put("devices", new JSONArray());
        if (!on) return out;
        long now = System.currentTimeMillis() / 1000;
        String q = "?client=all&mode=detail&dura=" + (dura == 7 ? 7 : 24) + "&date=" + now;
        JSONArray rows = Asus.jsArray(Asus.get(ctx, "/getAppTraffic.asp" + q), "array_statistics");
        if (rows.length() == 0 && "1".equals(n.optString("dns_dpi_trf_analysis"))) rows = Asus.jsArray(Asus.get(ctx, "/getAppTraffic_Dns.asp" + q), "array_statistics");
        JSONArray devs = new JSONArray();
        for (int i = 0; i < rows.length(); i++) {
            JSONArray r = rows.optJSONArray(i);
            if (r == null || r.length() < 3) continue;
            devs.put(new JSONObject().put("mac", r.optString(0).toLowerCase(Locale.ROOT)).put("up", r.optDouble(1)).put("down", r.optDouble(2)));
        }
        return out.put("devices", devs);
    }

    /** Live counters (bytes so far) per device; the page works out the speed from two readings. */
    static JSONObject live(Context ctx) throws Exception {
        String page = Asus.get(ctx, "/getTraffic.asp");
        JSONArray rows = Asus.jsArray(page, "array_traffic"), devs = new JSONArray();
        for (int i = 0; i < rows.length(); i++) {
            JSONArray r = rows.optJSONArray(i);
            if (r == null || r.length() < 3) continue;
            devs.put(new JSONObject().put("mac", r.optString(0).toLowerCase(Locale.ROOT)).put("up", r.optDouble(1)).put("down", r.optDouble(2)));
        }
        return new JSONObject().put("devices", devs).put("at", System.currentTimeMillis());
    }
}
