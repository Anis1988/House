package com.claude.house;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.PermissionState;
import java.net.ConnectException;
import java.net.DatagramPacket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MulticastSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Home-network tools for the web page: WebSockets to the TVs (self-signed TLS), a sweep that
 * finds every device that's on, SSDP and mDNS names, Wake-on-LAN, and LAN-only image fetches.
 */
@CapacitorPlugin(
    name = "Net",
    permissions = { @Permission(alias = "notifications", strings = { android.Manifest.permission.POST_NOTIFICATIONS }) }
)
public class NetPlugin extends Plugin {
    private final Map<String, WebSocket> sockets = new ConcurrentHashMap<>();
    private final ExecutorService pool = Executors.newCachedThreadPool();

    // ---- WebSockets ----

    @PluginMethod
    public void open(PluginCall call) {
        String id = call.getString("id");
        String url = call.getString("url");
        if (id == null || url == null || !LanNet.isLanUrl(url)) {
            call.reject("Only devices on your home network are allowed");
            return;
        }
        WebSocket old = sockets.remove(id);
        if (old != null) old.cancel();

        LanNet.client().newWebSocket(new Request.Builder().url(url).build(), new WebSocketListener() {
            private boolean opened = false;

            @Override
            public void onOpen(WebSocket ws, Response response) {
                opened = true;
                sockets.put(id, ws);
                call.resolve();
            }

            @Override
            public void onMessage(WebSocket ws, String text) {
                if (sockets.get(id) != ws) return;
                JSObject data = new JSObject();
                data.put("id", id);
                data.put("data", text);
                notifyListeners("message", data);
            }

            @Override
            public void onClosing(WebSocket ws, int code, String reason) {
                ws.close(1000, null);
                closed(ws);
            }

            @Override
            public void onFailure(WebSocket ws, Throwable t, Response response) {
                if (!opened) call.reject("Couldn't reach it");
                else closed(ws);
            }

            // Only report sockets that are still current, not ones we replaced.
            private void closed(WebSocket ws) {
                if (!sockets.remove(id, ws)) return;
                JSObject data = new JSObject();
                data.put("id", id);
                notifyListeners("closed", data);
            }
        });
    }

    @PluginMethod
    public void send(PluginCall call) {
        WebSocket ws = sockets.get(call.getString("id", ""));
        if (ws == null || !ws.send(call.getString("data", ""))) {
            call.reject("Not connected");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        WebSocket ws = sockets.remove(call.getString("id", ""));
        if (ws != null) ws.close(1000, null);
        call.resolve();
    }

    /** App icons from the TV, as data URLs (the TV's server has a self-signed cert). */
    @PluginMethod
    public void fetchImage(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !LanNet.isLanUrl(url)) {
            call.reject("Only images from your home network are allowed");
            return;
        }
        pool.execute(() -> {
            try (Response res = LanNet.client().newCall(new Request.Builder().url(url).build()).execute()) {
                if (!res.isSuccessful() || res.body() == null) throw new Exception("HTTP " + res.code());
                String type = res.header("Content-Type", "image/png");
                String b64 = Base64.encodeToString(res.body().bytes(), Base64.NO_WRAP);
                JSObject out = new JSObject();
                out.put("dataUrl", "data:" + type + ";base64," + b64);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("Image failed: " + e.getMessage());
            }
        });
    }

    /** GET a JSON/text page from a home-network device (e.g. the Samsung screen's info). */
    @PluginMethod
    public void lanGet(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !LanNet.isLanUrl(url)) {
            call.reject("Only your home network is allowed");
            return;
        }
        pool.execute(() -> {
            try (Response res = LanNet.client().newBuilder().readTimeout(4, TimeUnit.SECONDS).build()
                .newCall(new Request.Builder().url(url).build()).execute()) {
                JSObject out = new JSObject();
                out.put("status", res.code());
                out.put("body", res.body() == null ? "" : res.body().string());
                call.resolve(out);
            } catch (Exception e) {
                call.reject("Couldn't reach it");
            }
        });
    }

    @PluginMethod
    public void wake(PluginCall call) {
        String mac = call.getString("mac", "");
        String broadcast = call.getString("broadcast", "255.255.255.255");
        pool.execute(() -> {
            try {
                LanNet.wake(mac, broadcast);
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    /** First three parts of this phone's address, e.g. "192.168.50", and the router (gateway) address. */
    @PluginMethod
    public void localPrefix(PluginCall call) {
        String subnet = Lifx.subnet(getContext());
        if (subnet.isEmpty()) {
            call.reject("Not on Wi-Fi");
            return;
        }
        JSObject out = new JSObject();
        out.put("prefix", subnet);
        out.put("gateway", gateway(subnet));
        call.resolve(out);
    }

    @SuppressWarnings("deprecation")
    private String gateway(String subnet) {
        try {
            WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            int g = wifi.getDhcpInfo().gateway;
            if (g != 0) return (g & 0xff) + "." + ((g >> 8) & 0xff) + "." + ((g >> 16) & 0xff) + "." + ((g >> 24) & 0xff);
        } catch (Exception ignored) {}
        return subnet + ".1";
    }

    // ---- Finding devices ----

    /** Hosts in prefix.1-254 with one of the given TCP ports open. { prefix, ports: [..] } → { hosts: [{ip, port}] } */
    @PluginMethod
    public void scan(PluginCall call) {
        String prefix = call.getString("prefix", "");
        JSArray portList = call.getArray("ports", new JSArray());
        if (!LanNet.isPrivate(prefix + ".1")) {
            call.reject("Not on a home network");
            return;
        }
        List<Integer> ports = new ArrayList<>();
        for (int i = 0; i < portList.length(); i++) ports.add(portList.optInt(i));
        pool.execute(() -> {
            ExecutorService probes = Executors.newFixedThreadPool(64);
            List<JSObject> hosts = Collections.synchronizedList(new ArrayList<>());
            for (int i = 1; i < 255; i++) {
                String host = prefix + "." + i;
                for (int port : ports) {
                    probes.execute(() -> {
                        try (Socket s = new Socket()) {
                            s.connect(new InetSocketAddress(host, port), 800);
                            JSObject h = new JSObject();
                            h.put("ip", host);
                            h.put("port", port);
                            hosts.add(h);
                        } catch (Exception ignored) {}
                    });
                }
            }
            probes.shutdown();
            try {
                probes.awaitTermination(20, TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {}
            JSObject out = new JSObject();
            out.put("hosts", new JSArray(new ArrayList<>(hosts)));
            call.resolve(out);
        });
    }

    /**
     * Which addresses have a device that's on. Apps can't ping, so this knocks on a few common
     * ports: an answer or a refusal both mean something is there. The open ports also hint at what
     * it is (3001 LG TV, 8001 Samsung, 554 camera, 62078 Apple, 8009 Google Cast, 6668 Tuya).
     * { prefix } → { alive: [{ip, ports: [..]}] }
     */
    @PluginMethod
    public void sweep(PluginCall call) {
        String prefix = call.getString("prefix", "");
        if (!LanNet.isPrivate(prefix + ".1")) {
            call.reject("Not on a home network");
            return;
        }
        pool.execute(() -> {
            Map<String, Set<Integer>> alive = LanNet.sweep(prefix);
            JSArray list = new JSArray();
            for (Map.Entry<String, Set<Integer>> e : alive.entrySet()) {
                JSObject d = new JSObject();
                d.put("ip", e.getKey());
                synchronized (e.getValue()) { d.put("ports", new JSArray(new ArrayList<>(e.getValue()))); }
                list.put(d);
            }
            JSObject out = new JSObject();
            out.put("alive", list);
            call.resolve(out);
        });
    }

    /** UPnP/SSDP: devices that announce themselves (TVs, routers, speakers). → { devices: [{ip, server, st, location}] } */
    @PluginMethod
    public void ssdp(PluginCall call) {
        pool.execute(() -> {
            Map<String, JSObject> found = new LinkedHashMap<>();
            withMulticast(() -> {
                try (MulticastSocket s = new MulticastSocket()) {
                    s.setSoTimeout(200);
                    byte[] q = ("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n")
                        .getBytes(StandardCharsets.US_ASCII);
                    InetAddress group = InetAddress.getByName("239.255.255.250");
                    long end = System.currentTimeMillis() + 3000;
                    int sent = 0;
                    byte[] buf = new byte[2048];
                    while (System.currentTimeMillis() < end) {
                        if (sent < 3) { s.send(new DatagramPacket(q, q.length, group, 1900)); sent++; }
                        DatagramPacket p = new DatagramPacket(buf, buf.length);
                        try {
                            s.receive(p);
                        } catch (SocketTimeoutException e) {
                            continue;
                        }
                        String ip = p.getAddress().getHostAddress();
                        String text = new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8);
                        JSObject d = found.containsKey(ip) ? found.get(ip) : new JSObject();
                        d.put("ip", ip);
                        String server = header(text, "SERVER");
                        if (server != null && !d.has("server")) d.put("server", server);
                        String st = header(text, "ST");
                        if (st != null && st.startsWith("urn:") && (!d.has("st") || st.contains(":device:"))) d.put("st", st);
                        found.put(ip, d);
                    }
                }
            });
            JSObject out = new JSObject();
            out.put("devices", new JSArray(new ArrayList<>(found.values())));
            call.resolve(out);
        });
    }

    private static String header(String text, String name) {
        for (String line : text.split("\r\n")) {
            int c = line.indexOf(':');
            if (c > 0 && line.substring(0, c).trim().equalsIgnoreCase(name)) return line.substring(c + 1).trim();
        }
        return null;
    }

    /** mDNS: the names devices give themselves (TVs, speakers, Echo, Chromecast...). → { devices: [{ip, names: [..]}] } */
    @PluginMethod
    public void mdns(PluginCall call) {
        pool.execute(() -> {
            Map<String, Set<String>> found = new LinkedHashMap<>();
            withMulticast(() -> {
                try (MulticastSocket s = new MulticastSocket()) {
                    s.setSoTimeout(200);
                    String[] types = {"_services._dns-sd._udp.local", "_googlecast._tcp.local", "_airplay._tcp.local",
                        "_spotify-connect._tcp.local", "_matter._tcp.local", "_hap._tcp.local", "_ipp._tcp.local",
                        "_amzn-wplay._tcp.local", "_raop._tcp.local", "_companion-link._tcp.local"};
                    byte[] q = Mdns.query(types);
                    InetAddress group = InetAddress.getByName("224.0.0.251");
                    long end = System.currentTimeMillis() + 3000;
                    int sent = 0;
                    byte[] buf = new byte[9000];
                    while (System.currentTimeMillis() < end) {
                        if (sent < 3 && System.currentTimeMillis() > end - 3000 + sent * 700L) {
                            s.send(new DatagramPacket(q, q.length, group, 5353));
                            sent++;
                        }
                        DatagramPacket p = new DatagramPacket(buf, buf.length);
                        try {
                            s.receive(p);
                        } catch (SocketTimeoutException e) {
                            continue;
                        }
                        String ip = p.getAddress().getHostAddress();
                        Set<String> names = found.containsKey(ip) ? found.get(ip) : new LinkedHashSet<>();
                        names.addAll(Mdns.names(p.getData(), p.getLength()));
                        found.put(ip, names);
                    }
                }
            });
            JSArray list = new JSArray();
            for (Map.Entry<String, Set<String>> e : found.entrySet()) {
                JSObject d = new JSObject();
                d.put("ip", e.getKey());
                d.put("names", new JSArray(new ArrayList<>(e.getValue())));
                list.put(d);
            }
            JSObject out = new JSObject();
            out.put("devices", list);
            call.resolve(out);
        });
    }

    private interface Job { void run() throws Exception; }

    /** Wi-Fi drops multicast replies unless the app holds a multicast lock. */
    private void withMulticast(Job job) {
        WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        WifiManager.MulticastLock lock = wifi == null ? null : wifi.createMulticastLock("house-discovery");
        try {
            if (lock != null) { lock.setReferenceCounted(false); lock.acquire(); }
            job.run();
        } catch (Exception ignored) {
        } finally {
            if (lock != null && lock.isHeld()) lock.release();
        }
    }

    /** Wyze wants the password as an MD5 hash, three times over. */
    @PluginMethod
    public void md5(PluginCall call) {
        String text = call.getString("text", "");
        int times = call.getInt("times", 1);
        try {
            for (int i = 0; i < times; i++) {
                byte[] d = MessageDigest.getInstance("MD5").digest(text.getBytes(StandardCharsets.UTF_8));
                StringBuilder hex = new StringBuilder();
                for (byte b : d) hex.append(String.format("%02x", b & 0xff));
                text = hex.toString();
            }
            JSObject out = new JSObject();
            out.put("hash", text);
            call.resolve(out);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    // ---- Wi-Fi watch: new device alerts and who's home ----

    @PluginMethod
    public void getWatch(PluginCall call) {
        try {
            JSObject r = new JSObject();
            r.put("settings", new JSObject(WifiWatch.settings(getContext()).toString()));
            r.put("presence", new JSObject(WifiWatch.presence(getContext()).toString()));
            r.put("atHome", Presence.atHome(getContext()));
            r.put("notifications", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** { settings: { alerts, people: [{key, name}], arrive, leave } } */
    @PluginMethod
    public void setWatch(PluginCall call) {
        JSObject s = call.getObject("settings", new JSObject());
        WifiWatch.save(getContext(), s);
        // Alerts need permission to notify (Android 13+); ask once, right when they're turned on.
        if (s.optBoolean("alerts") && Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "watchPermission");
            return;
        }
        getWatch(call);
    }

    @PermissionCallback
    private void watchPermission(PluginCall call) {
        getWatch(call);
    }

    /**
     * { name } adds the phone running the app to Who's home. Must be on the home Wi-Fi: that Wi-Fi
     * is remembered as home, and Android then reports leaving and arriving right away.
     */
    @PluginMethod
    public void addThisPhone(PluginCall call) {
        String name = call.getString("name", "Me");
        if (!Presence.rememberHome(getContext())) {
            call.reject("Connect this phone to your home Wi-Fi first");
            return;
        }
        try {
            org.json.JSONObject s = WifiWatch.settings(getContext());
            org.json.JSONArray people = s.optJSONArray("people");
            org.json.JSONArray next = new org.json.JSONArray();
            String own = Presence.ownIp(getContext());
            for (int i = 0; people != null && i < people.length(); i++) {
                String key = people.getJSONObject(i).optString("key");
                // Drop an older entry for this same phone (added by its address), or it would stay "home".
                if (!Presence.KEY.equals(key) && !key.equals(own)) next.put(people.getJSONObject(i));
            }
            next.put(new org.json.JSONObject().put("key", Presence.KEY).put("name", name));
            s.put("people", next);
            WifiWatch.save(getContext(), s);
        } catch (Exception e) {
            call.reject(e.getMessage());
            return;
        }
        getWatch(call);
    }

    // ---- Widget check: draws a Lights widget at a size into a picture (for testing the layouts) ----

    /** { kind: toggle|one|scenes|rooms|bright|away, w, h (dp) } → { dataUrl } */
    @PluginMethod
    public void widgetSnapshot(PluginCall call) {
        String kind = call.getString("kind", "toggle");
        int w = call.getInt("w", 250), h = call.getInt("h", 110);
        getActivity().runOnUiThread(() -> {
            try {
                android.widget.RemoteViews rv = Widgets.preview(getContext(), kind, w, h);
                Context plain = getContext().getApplicationContext(); // like a launcher: no app theme swaps
                android.widget.FrameLayout parent = new android.widget.FrameLayout(plain);
                android.view.View v = rv.apply(plain, parent);
                float d = getContext().getResources().getDisplayMetrics().density;
                int pw = Math.round(w * d), ph = Math.round(h * d);
                v.measure(android.view.View.MeasureSpec.makeMeasureSpec(pw, android.view.View.MeasureSpec.EXACTLY),
                    android.view.View.MeasureSpec.makeMeasureSpec(ph, android.view.View.MeasureSpec.EXACTLY));
                v.layout(0, 0, pw, ph);
                android.graphics.Bitmap bmp = android.graphics.Bitmap.createBitmap(pw, ph, android.graphics.Bitmap.Config.ARGB_8888);
                v.draw(new android.graphics.Canvas(bmp));
                java.io.ByteArrayOutputStream png = new java.io.ByteArrayOutputStream();
                bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, png);
                JSObject out = new JSObject();
                out.put("dataUrl", "data:image/png;base64," + Base64.encodeToString(png.toByteArray(), Base64.NO_WRAP));
                call.resolve(out);
            } catch (Exception e) {
                call.reject(e.toString());
            }
        });
    }

    // ---- Wi-Fi logs: device history and internet outages ----

    @PluginMethod
    public void getWifiLog(PluginCall call) {
        try {
            JSObject r = new JSObject();
            r.put("devices", new JSArray(WifiLog.deviceLog(getContext()).toString()));
            r.put("outages", new JSArray(WifiLog.outages(getContext()).toString()));
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void clearWifiLog(PluginCall call) {
        WifiLog.clear(getContext());
        getWifiLog(call);
    }

    /** Checks the internet now (and logs an outage if it's down). */
    @PluginMethod
    public void checkInternet(PluginCall call) {
        pool.execute(() -> {
            WifiLog.checkInternet(getContext());
            JSObject r = new JSObject();
            r.put("up", WifiLog.internetUp());
            call.resolve(r);
        });
    }

    // ---- Nest in the background: history, humidity alert, doorbell alerts ----

    @PluginMethod
    public void getNestWatch(PluginCall call) {
        try {
            JSObject r = new JSObject();
            r.put("settings", new JSObject(NestWatch.settings(getContext()).toString()));
            r.put("history", new JSArray(NestWatch.history(getContext()).toString()));
            r.put("notifications", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** { settings: { ring, motion, humOn, humLow, humHigh } } */
    @PluginMethod
    public void setNestWatch(PluginCall call) {
        JSObject s = call.getObject("settings", new JSObject());
        NestWatch.save(getContext(), s);
        boolean alerts = s.optBoolean("ring") || s.optBoolean("motion") || s.optBoolean("humOn");
        if (alerts && Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "nestPermission");
            return;
        }
        getNestWatch(call);
    }

    @PermissionCallback
    private void nestPermission(PluginCall call) {
        getNestWatch(call);
    }

    /** Saves a reading now (when the Nest side opens) and returns the history. */
    @PluginMethod
    public void nestTick(PluginCall call) {
        pool.execute(() -> {
            NestWatch.tick(getContext());
            getNestWatch(call);
        });
    }

    /** Checks the Pub/Sub subscription works: { events } or an error message. */
    @PluginMethod
    public void nestTestEvents(PluginCall call) {
        pool.execute(() -> {
            try {
                JSObject r = new JSObject();
                r.put("events", NestWatch.pullOnce(getContext()));
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Couldn't read the events" : e.getMessage());
            }
        });
    }

    /** Checks this phone's home/away right now (cheap, no scan) and returns the Who's home state. */
    @PluginMethod
    public void checkPresence(PluginCall call) {
        pool.execute(() -> {
            Presence.evaluate(getContext());
            getWatch(call);
        });
    }

    /** Runs one check now (who's home, new devices) and returns the result. */
    @PluginMethod
    public void checkWatch(PluginCall call) {
        pool.execute(() -> {
            WifiWatch.check(getContext());
            getWatch(call);
        });
    }

    // ---- Speed test (Cloudflare's speed test servers) ----

    /** → { down, up (Mbit/s), ping (ms) }. Takes about 20 seconds. */
    @PluginMethod
    public void speedTest(PluginCall call) {
        pool.execute(() -> {
            okhttp3.OkHttpClient http = new okhttp3.OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).writeTimeout(20, TimeUnit.SECONDS).build();
            try {
                // Ping: the fastest of a few tiny requests (the first one also sets up the connection).
                long best = Long.MAX_VALUE;
                for (int i = 0; i < 6; i++) {
                    long t = System.nanoTime();
                    try (Response r = http.newCall(new Request.Builder().url("https://speed.cloudflare.com/__down?bytes=0").build()).execute()) {
                        r.body().bytes();
                    }
                    if (i > 0) best = Math.min(best, System.nanoTime() - t);
                }
                // Download: read for up to 8 seconds.
                long bytes = 0, start = System.nanoTime(), limit = 8_000_000_000L;
                while (System.nanoTime() - start < limit) {
                    try (Response r = http.newCall(new Request.Builder().url("https://speed.cloudflare.com/__down?bytes=25000000").build()).execute()) {
                        java.io.InputStream in = r.body().byteStream();
                        byte[] buf = new byte[65536];
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            bytes += n;
                            if (System.nanoTime() - start > limit) break;
                        }
                    }
                }
                double down = bytes * 8 / ((System.nanoTime() - start) / 1e9) / 1e6;
                // Upload: send 5 MB chunks for up to 8 seconds.
                byte[] chunk = new byte[5_000_000];
                long sent = 0;
                start = System.nanoTime();
                while (System.nanoTime() - start < limit) {
                    try (Response r = http.newCall(new Request.Builder().url("https://speed.cloudflare.com/__up")
                        .post(okhttp3.RequestBody.create(chunk, okhttp3.MediaType.get("application/octet-stream"))).build()).execute()) {
                        r.body().bytes();
                    }
                    sent += chunk.length;
                }
                double up = sent * 8 / ((System.nanoTime() - start) / 1e9) / 1e6;
                JSObject out = new JSObject();
                out.put("down", Math.round(down * 10) / 10.0);
                out.put("up", Math.round(up * 10) / 10.0);
                out.put("ping", Math.round(best / 1e6));
                out.put("at", System.currentTimeMillis());
                // Kept for the Wi-Fi widget.
                getContext().getSharedPreferences(Lifx.PREFS, android.content.Context.MODE_PRIVATE).edit().putString("lastSpeed", out.toString()).apply();
                Widgets.redrawWifi(getContext());
                call.resolve(out);
            } catch (Exception e) {
                call.reject("The speed test couldn't reach the internet");
            }
        });
    }

    // ---- Automations (doorbell lights, TV movie mode, Quick Settings scene) ----

    /** → { settings, dark } */
    @PluginMethod
    public void getAuto(PluginCall call) {
        try {
            JSObject r = new JSObject();
            r.put("settings", new JSObject(HomeAuto.settings(getContext()).toString()));
            r.put("dark", HomeAuto.isDark(getContext()));
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** { settings } replaces them. */
    @PluginMethod
    public void setAuto(PluginCall call) {
        try {
            HomeAuto.save(getContext(), new org.json.JSONObject(call.getObject("settings", new JSObject()).toString()));
            getAuto(call);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** Is the LG TV on right now? → { on } */
    @PluginMethod
    public void tvState(PluginCall call) {
        pool.execute(() -> {
            JSObject r = new JSObject();
            r.put("on", HouseActions.lgIsOn(getContext()));
            call.resolve(r);
        });
    }

    // ---- PC: turn on at a set time ----

    /** → { on, minutes, days, mac, broadcast, name, next } */
    @PluginMethod
    public void getPcWake(PluginCall call) {
        try {
            JSObject r = new JSObject(PcLink.wakeSettings(getContext()).toString());
            r.put("next", PcLink.next(getContext()));
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void setPcWake(PluginCall call) {
        try {
            org.json.JSONObject s = new org.json.JSONObject(call.getData().toString());
            PcLink.saveWake(getContext(), s);
            getPcWake(call);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    // ---- Home overview ----

    /**
     * { refresh? } → { people: [{ key, name, home, since, seenAt }], atHome, netUp (null = not watched),
     *   lastSpeed, nest (state, fresh with refresh), ring: { at, kind, device, image (data URL) } }
     */
    @PluginMethod
    public void homeStatus(PluginCall call) {
        boolean refresh = call.getBoolean("refresh", false);
        pool.execute(() -> {
            try {
                android.content.Context ctx = getContext();
                android.content.SharedPreferences p = ctx.getSharedPreferences(Lifx.PREFS, android.content.Context.MODE_PRIVATE);
                JSObject r = new JSObject();
                org.json.JSONArray people = WifiWatch.settings(ctx).optJSONArray("people");
                org.json.JSONObject pres = WifiWatch.presence(ctx);
                JSArray ps = new JSArray();
                for (int i = 0; people != null && i < people.length(); i++) {
                    org.json.JSONObject person = people.getJSONObject(i);
                    String key = person.optString("key").toLowerCase(java.util.Locale.ROOT);
                    org.json.JSONObject st = pres.optJSONObject(key);
                    JSObject o = new JSObject();
                    o.put("key", key);
                    o.put("name", person.optString("name"));
                    o.put("home", st != null && st.optBoolean("home"));
                    o.put("since", st == null ? 0 : st.optLong("since"));
                    o.put("seenAt", st == null ? 0 : st.optLong("seenAt", st.optLong("since")));
                    ps.put(o);
                }
                r.put("people", ps);
                r.put("atHome", Presence.atHome(ctx));
                r.put("netUp", WifiLog.outageWatchOn(ctx) && p.contains("netUp") ? p.getBoolean("netUp", true) : null);
                r.put("lastSpeed", new JSObject(p.getString("lastSpeed", "{}")));
                boolean nestOn = !HouseActions.creds(ctx).optString("nestRefresh").isEmpty();
                r.put("nest", nestOn ? new JSObject((refresh ? NestWatch.refresh(ctx) : NestWatch.state(ctx)).toString()) : null);
                org.json.JSONObject ring = NestWatch.lastRing(ctx);
                JSObject rg = new JSObject(ring.toString());
                java.io.File f = new java.io.File(ctx.getFilesDir(), "doorbell.jpg");
                if (ring.optBoolean("image") && f.exists()) {
                    byte[] bytes = java.nio.file.Files.readAllBytes(f.toPath());
                    rg.put("image", "data:image/jpeg;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP));
                } else {
                    rg.put("image", null);
                }
                r.put("ring", ring.has("at") ? rg : null);
                call.resolve(r);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    /** Nest warmer (+1) or cooler (-1), or Eco on/off: { dir } or { eco } → state */
    @PluginMethod
    public void nestQuick(PluginCall call) {
        pool.execute(() -> {
            try {
                org.json.JSONObject s;
                if (call.getData().has("eco")) { NestWatch.eco(getContext(), call.getBoolean("eco", false)); s = NestWatch.state(getContext()); }
                else s = NestWatch.adjust(getContext(), call.getInt("dir", 1));
                call.resolve(new JSObject(s.toString()));
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Nest didn't answer" : e.getMessage());
            }
        });
    }

    // ---- ASUS router controls ----

    /** { op, ... } → see RouterControl.op. */
    @PluginMethod
    public void router(PluginCall call) {
        JSObject a = call.getData();
        pool.execute(() -> {
            try {
                call.resolve(new JSObject(RouterControl.op(getContext(), a).toString()));
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "The router didn't answer" : e.getMessage());
            }
        });
    }

    /** Blinks the "Lights react" light once, to try it. */
    @PluginMethod
    public void flashTest(PluginCall call) {
        pool.execute(() -> {
            WifiFlash.flash(getContext());
            call.resolve();
        });
    }

    // ---- QR code (guest Wi-Fi) ----

    /** { text } → { dataUrl } a PNG QR code. */
    @PluginMethod
    public void qr(PluginCall call) {
        try {
            com.google.zxing.common.BitMatrix m = new com.google.zxing.qrcode.QRCodeWriter()
                .encode(call.getString("text", ""), com.google.zxing.BarcodeFormat.QR_CODE, 600, 600);
            android.graphics.Bitmap bmp = android.graphics.Bitmap.createBitmap(m.getWidth(), m.getHeight(), android.graphics.Bitmap.Config.RGB_565);
            for (int x = 0; x < m.getWidth(); x++) for (int y = 0; y < m.getHeight(); y++) bmp.setPixel(x, y, m.get(x, y) ? 0xFF000000 : 0xFFFFFFFF);
            java.io.ByteArrayOutputStream png = new java.io.ByteArrayOutputStream();
            bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, png);
            JSObject out = new JSObject();
            out.put("dataUrl", "data:image/png;base64," + Base64.encodeToString(png.toByteArray(), Base64.NO_WRAP));
            call.resolve(out);
        } catch (Exception e) {
            call.reject("Couldn't make the QR code");
        }
    }
}
