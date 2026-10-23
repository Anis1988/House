package com.claude.house;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.wifi.WifiManager;
import android.util.Log;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.SocketTimeoutException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * LIFX LAN protocol over UDP 56700: find bulbs, read their state and set power/color.
 * No cloud account. Known bulbs (address, name, last state) are kept in prefs so the
 * widget and the bedtime alarm can reach them without a fresh scan.
 */
final class Lifx {
    private static final String TAG = "Lifx";
    static final String PREFS = "house";
    private static final int PORT = 56700;

    // Message types
    private static final int GET_SERVICE = 2, STATE_SERVICE = 3;
    private static final int GET_VERSION = 32, STATE_VERSION = 33;
    private static final int ACK = 45;
    private static final int GET_GROUP = 51, STATE_GROUP = 53;
    private static final int GET = 101, SET_COLOR = 102, LIGHT_STATE = 107;
    private static final int SET_LIGHT_POWER = 117;

    // Product ids from LIFX's products list: bulbs with a fixed white, and white bulbs that tune warm-cool.
    private static final Set<Integer> FIXED_WHITE = new HashSet<>(Arrays.asList(51, 61, 66, 82, 85, 87, 88, 100, 101));
    private static final Set<Integer> TUNABLE_WHITE = new HashSet<>(Arrays.asList(10, 11, 18, 19, 50, 60, 81, 96, 113, 114, 125, 126));

    private static final int SOURCE = new Random().nextInt() | 1;
    private static int sequence = 0;

    private Lifx() {}

    static final class Light {
        String id;     // MAC as hex, e.g. d073d56acb0b
        String ip;
        String label = "";
        String group = ""; // the room set in the LIFX app
        int hue, sat, bri, kelvin = 3500; // raw protocol values (0-65535, Kelvin)
        boolean on;
        int product;
        boolean online;

        boolean color() { return product != 0 && !FIXED_WHITE.contains(product) && !TUNABLE_WHITE.contains(product); }
        boolean tunable() { return !FIXED_WHITE.contains(product); }
        int kMin() { return product == 50 || product == 60 ? 1500 : color() ? 1500 : FIXED_WHITE.contains(product) ? kelvin : 2200; }
        int kMax() { return product == 50 || product == 60 ? 4000 : color() ? 9000 : FIXED_WHITE.contains(product) ? kelvin : 6500; }

        JSONObject toJson() throws JSONException {
            return new JSONObject()
                .put("id", id).put("ip", ip).put("label", label).put("group", group)
                .put("hue", hue).put("sat", sat).put("bri", bri).put("kelvin", kelvin)
                .put("on", on).put("product", product).put("online", online)
                .put("color", color()).put("tunable", tunable() && kMin() < kMax())
                .put("kMin", kMin()).put("kMax", kMax());
        }

        static Light fromJson(JSONObject o) {
            Light l = new Light();
            l.id = o.optString("id");
            l.ip = o.optString("ip");
            l.label = o.optString("label");
            l.group = o.optString("group");
            l.hue = o.optInt("hue");
            l.sat = o.optInt("sat");
            l.bri = o.optInt("bri");
            l.kelvin = o.optInt("kelvin", 3500);
            l.on = o.optBoolean("on");
            l.product = o.optInt("product");
            return l;
        }
    }

    // ---- Packets ----

    private static synchronized int nextSeq() {
        sequence = (sequence + 1) & 0xff;
        return sequence;
    }

    /** A 36-byte header + payload. target null = all bulbs (tagged). */
    private static byte[] packet(int type, byte[] target, byte[] payload, boolean ackRequired, boolean resRequired, int seq) {
        ByteBuffer b = ByteBuffer.allocate(36 + payload.length).order(ByteOrder.LITTLE_ENDIAN);
        b.putShort((short) (36 + payload.length));
        b.putShort((short) (1024 | 0x1000 | (target == null ? 0x2000 : 0)));
        b.putInt(SOURCE);
        byte[] t = new byte[8];
        if (target != null) System.arraycopy(target, 0, t, 0, Math.min(6, target.length));
        b.put(t);
        b.put(new byte[6]);
        b.put((byte) ((resRequired ? 1 : 0) | (ackRequired ? 2 : 0)));
        b.put((byte) seq);
        b.put(new byte[8]);
        b.putShort((short) type);
        b.putShort((short) 0);
        b.put(payload);
        return b.array();
    }

    private static byte[] mac(String id) {
        byte[] m = new byte[6];
        for (int i = 0; i < 6; i++) m[i] = (byte) Integer.parseInt(id.substring(i * 2, i * 2 + 2), 16);
        return m;
    }

    private static String hex(byte[] d, int off, int len) {
        StringBuilder s = new StringBuilder();
        for (int i = 0; i < len; i++) s.append(String.format("%02x", d[off + i] & 0xff));
        return s.toString();
    }

    /** A 32-byte, zero-padded UTF-8 name. */
    private static String text(byte[] d, int off) {
        String t = new String(d, off, 32, StandardCharsets.UTF_8);
        int z = t.indexOf('\0');
        return (z >= 0 ? t.substring(0, z) : t).trim();
    }

    private static byte[] colorPayload(int hue, int sat, int bri, int kelvin, int durationMs) {
        return ByteBuffer.allocate(13).order(ByteOrder.LITTLE_ENDIAN)
            .put((byte) 0).putShort((short) hue).putShort((short) sat).putShort((short) bri).putShort((short) kelvin)
            .putInt(durationMs).array();
    }

    private static byte[] powerPayload(boolean on, int durationMs) {
        return ByteBuffer.allocate(6).order(ByteOrder.LITTLE_ENDIAN).putShort((short) (on ? 0xffff : 0)).putInt(durationMs).array();
    }

    // ---- Cache ----

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static synchronized Map<String, Light> cached(Context ctx) {
        Map<String, Light> out = new LinkedHashMap<>();
        try {
            JSONArray a = new JSONArray(prefs(ctx).getString("lights", "[]"));
            for (int i = 0; i < a.length(); i++) {
                Light l = Light.fromJson(a.getJSONObject(i));
                out.put(l.id, l);
            }
        } catch (JSONException ignored) {}
        return out;
    }

    static synchronized void save(Context ctx, Map<String, Light> lights) {
        JSONArray a = new JSONArray();
        try {
            for (Light l : lights.values()) a.put(l.toJson());
        } catch (JSONException ignored) {}
        prefs(ctx).edit().putString("lights", a.toString()).apply();
    }

    static synchronized void forget(Context ctx) {
        prefs(ctx).edit().remove("lights").apply();
    }

    static JSONArray toJson(Map<String, Light> lights) throws JSONException {
        List<Light> list = new ArrayList<>(lights.values());
        list.sort((x, y) -> x.label.compareToIgnoreCase(y.label));
        JSONArray a = new JSONArray();
        for (Light l : list) a.put(l.toJson());
        return a;
    }

    // ---- Network helpers ----

    /** The phone's own IPv4 address and prefix length on the current network, or null. */
    static LinkAddress localAddress(Context ctx) {
        ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        Network n = cm.getActiveNetwork();
        LinkProperties lp = n == null ? null : cm.getLinkProperties(n);
        if (lp == null) return null;
        for (LinkAddress la : lp.getLinkAddresses()) if (la.getAddress() instanceof Inet4Address) return la;
        return null;
    }

    /** First three parts of the phone's address, e.g. "192.168.50", for the address-range scan. */
    static String subnet(Context ctx) {
        LinkAddress la = localAddress(ctx);
        if (la == null) return "";
        String ip = la.getAddress().getHostAddress();
        return ip.substring(0, ip.lastIndexOf('.'));
    }

    private static List<InetAddress> broadcastAddresses(Context ctx) {
        List<InetAddress> out = new ArrayList<>();
        try {
            out.add(InetAddress.getByName("255.255.255.255"));
            LinkAddress la = localAddress(ctx);
            if (la != null && la.getPrefixLength() < 31) {
                byte[] a = la.getAddress().getAddress();
                int ip = ((a[0] & 0xff) << 24) | ((a[1] & 0xff) << 16) | ((a[2] & 0xff) << 8) | (a[3] & 0xff);
                int bc = ip | (int) ((1L << (32 - la.getPrefixLength())) - 1);
                out.add(InetAddress.getByAddress(new byte[] {(byte) (bc >>> 24), (byte) (bc >>> 16), (byte) (bc >>> 8), (byte) bc}));
            }
        } catch (Exception ignored) {}
        return out;
    }

    private interface Body { void run(DatagramSocket s) throws Exception; }

    /** Opens a broadcast-capable socket while holding the multicast lock (Wi-Fi drops broadcasts without it). */
    private static void withSocket(Context ctx, Body body) {
        WifiManager wifi = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        WifiManager.MulticastLock lock = wifi == null ? null : wifi.createMulticastLock("house-lifx");
        try (DatagramSocket s = new DatagramSocket()) {
            if (lock != null) { lock.setReferenceCounted(false); lock.acquire(); }
            s.setBroadcast(true);
            body.run(s);
        } catch (Exception e) {
            Log.w(TAG, "socket", e);
        } finally {
            if (lock != null && lock.isHeld()) lock.release();
        }
    }

    private static void send(DatagramSocket s, byte[] data, InetAddress to) {
        try {
            s.send(new DatagramPacket(data, data.length, to, PORT));
        } catch (Exception e) {
            Log.w(TAG, "send " + to, e);
        }
    }

    // ---- Discovery ----

    /**
     * Finds bulbs: broadcast GetService, unicast to the bulbs we already know, and, when range is
     * given (e.g. "192.168.50"), to every address .1-.254 in it, for networks that block broadcasts.
     * Then asks each bulb for its state and model. Returns every known bulb, marked online or not.
     */
    static Map<String, Light> scan(Context ctx, int timeoutMs, String range) {
        Map<String, Light> known = cached(ctx);
        Map<String, Light> found = new HashMap<>();
        Set<String> gotState = new HashSet<>(), gotVersion = new HashSet<>(), gotGroup = new HashSet<>();
        withSocket(ctx, s -> {
            List<InetAddress> targets = broadcastAddresses(ctx);
            for (Light l : known.values()) if (!l.ip.isEmpty()) targets.add(InetAddress.getByName(l.ip));
            if (range != null && range.matches("\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}")) {
                for (int i = 1; i < 255; i++) targets.add(InetAddress.getByName(range + "." + i));
            }
            byte[] getService = packet(GET_SERVICE, null, new byte[0], false, true, nextSeq());
            long start = System.currentTimeMillis(), end = start + timeoutMs;
            int round = 0;
            byte[] buf = new byte[256];
            s.setSoTimeout(100);
            while (System.currentTimeMillis() < end) {
                long t = System.currentTimeMillis() - start;
                // Three rounds of GetService early on, then re-ask quiet bulbs for their state.
                if (round < 3 && t >= round * 300L) {
                    for (InetAddress a : targets) send(s, getService, a);
                    if (round > 0) {
                        for (Light l : found.values()) {
                            InetAddress a = InetAddress.getByName(l.ip);
                            if (!gotState.contains(l.id)) send(s, packet(GET, mac(l.id), new byte[0], false, true, nextSeq()), a);
                            if (!gotVersion.contains(l.id)) send(s, packet(GET_VERSION, mac(l.id), new byte[0], false, true, nextSeq()), a);
                            if (!gotGroup.contains(l.id)) send(s, packet(GET_GROUP, mac(l.id), new byte[0], false, true, nextSeq()), a);
                        }
                    }
                    round++;
                }
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                try {
                    s.receive(p);
                } catch (SocketTimeoutException e) {
                    if (!found.isEmpty() && gotState.size() == found.size() && gotVersion.size() == found.size()
                        && gotGroup.size() == found.size()
                        && t > 900 && known.keySet().stream().allMatch(found::containsKey)) break;
                    continue;
                }
                byte[] d = p.getData();
                if (p.getLength() < 36) continue;
                ByteBuffer b = ByteBuffer.wrap(d, 0, p.getLength()).order(ByteOrder.LITTLE_ENDIAN);
                int type = b.getShort(32) & 0xffff;
                String id = hex(d, 8, 6);
                if (type == STATE_SERVICE) {
                    if (p.getLength() < 41 || d[36] != 1) continue; // service 1 = UDP
                    Light l = found.get(id);
                    if (l == null) {
                        l = known.containsKey(id) ? known.get(id) : new Light();
                        l.id = id;
                        found.put(id, l);
                        InetAddress a = p.getAddress();
                        send(s, packet(GET, mac(id), new byte[0], false, true, nextSeq()), a);
                        send(s, packet(GET_VERSION, mac(id), new byte[0], false, true, nextSeq()), a);
                        send(s, packet(GET_GROUP, mac(id), new byte[0], false, true, nextSeq()), a);
                    }
                    l.ip = p.getAddress().getHostAddress();
                } else if (type == LIGHT_STATE && p.getLength() >= 36 + 52) {
                    Light l = found.get(id);
                    if (l == null) continue;
                    l.hue = b.getShort(36) & 0xffff;
                    l.sat = b.getShort(38) & 0xffff;
                    l.bri = b.getShort(40) & 0xffff;
                    l.kelvin = b.getShort(42) & 0xffff;
                    l.on = (b.getShort(46) & 0xffff) != 0;
                    l.label = text(d, 48);
                    gotState.add(id);
                } else if (type == STATE_VERSION && p.getLength() >= 44) {
                    Light l = found.get(id);
                    if (l == null) continue;
                    l.product = b.getInt(40);
                    gotVersion.add(id);
                } else if (type == STATE_GROUP && p.getLength() >= 36 + 56) {
                    Light l = found.get(id);
                    if (l == null) continue;
                    l.group = text(d, 52);
                    gotGroup.add(id);
                }
            }
        });
        // Only keep things that answered as a light (LIFX switches answer GetService too).
        Map<String, Light> all = new LinkedHashMap<>(known);
        for (Light l : all.values()) l.online = false;
        for (Light l : found.values()) {
            if (!gotState.contains(l.id) && !known.containsKey(l.id)) continue;
            l.online = gotState.contains(l.id);
            if (l.label.isEmpty()) l.label = "Light " + l.id.substring(8);
            all.put(l.id, l);
        }
        save(ctx, all);
        return all;
    }

    // ---- Commands ----

    private static final class Cmd {
        final String ip;
        final byte[] target;
        final int type;
        final byte[] payload;

        Cmd(Light l, int type, byte[] payload) {
            this.ip = l.ip;
            this.target = mac(l.id);
            this.type = type;
            this.payload = payload;
        }
    }

    /** Sends each command with an ack request, resending up to 3 times to bulbs that don't answer. */
    private static int sendAll(Context ctx, List<Cmd> cmds, boolean alsoBroadcast, int bcType, byte[] bcPayload) {
        int[] acked = {0};
        withSocket(ctx, s -> {
            if (alsoBroadcast) {
                byte[] all = packet(bcType, null, bcPayload, false, false, nextSeq());
                for (InetAddress a : broadcastAddresses(ctx)) send(s, all, a);
            }
            Map<Integer, Cmd> pending = new HashMap<>();
            Map<Integer, InetAddress> addr = new HashMap<>();
            for (Cmd c : cmds) {
                int seq = nextSeq();
                pending.put(seq, c);
                addr.put(seq, InetAddress.getByName(c.ip));
            }
            byte[] buf = new byte[128];
            s.setSoTimeout(60);
            for (int attempt = 0; attempt < 4 && !pending.isEmpty(); attempt++) {
                for (Map.Entry<Integer, Cmd> e : pending.entrySet()) {
                    Cmd c = e.getValue();
                    send(s, packet(c.type, c.target, c.payload, true, false, e.getKey()), addr.get(e.getKey()));
                }
                long until = System.currentTimeMillis() + 250;
                while (System.currentTimeMillis() < until && !pending.isEmpty()) {
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    try {
                        s.receive(p);
                    } catch (SocketTimeoutException ex) {
                        continue;
                    }
                    if (p.getLength() < 36) continue;
                    ByteBuffer b = ByteBuffer.wrap(p.getData(), 0, p.getLength()).order(ByteOrder.LITTLE_ENDIAN);
                    if ((b.getShort(32) & 0xffff) == ACK && b.getInt(4) == SOURCE && pending.remove(p.getData()[23] & 0xff) != null) acked[0]++;
                }
            }
        });
        return acked[0];
    }

    /** Turns the given bulbs (or all, when ids is null) on or off. Returns how many confirmed. */
    static int setPower(Context ctx, List<String> ids, boolean on, int durationMs) {
        Map<String, Light> lights = cached(ctx);
        List<Cmd> cmds = new ArrayList<>();
        byte[] payload = powerPayload(on, durationMs);
        for (Light l : lights.values()) {
            if (ids != null && !ids.contains(l.id)) continue;
            l.on = on;
            cmds.add(new Cmd(l, SET_LIGHT_POWER, payload));
        }
        save(ctx, lights);
        // "All" also goes out as one broadcast, so a bulb with a new address still follows.
        return sendAll(ctx, cmds, ids == null, SET_LIGHT_POWER, payload);
    }

    /** hue 0-65535, sat 0-65535, bri 0-65535, kelvin in K; -1 keeps the bulb's current value. */
    static int setColor(Context ctx, List<String> ids, int hue, int sat, int bri, int kelvin, int durationMs) {
        Map<String, Light> lights = cached(ctx);
        List<Cmd> cmds = new ArrayList<>();
        for (Light l : lights.values()) {
            if (ids != null && !ids.contains(l.id)) continue;
            if (hue >= 0) l.hue = hue;
            if (sat >= 0) l.sat = l.color() ? sat : 0;
            if (bri >= 0) l.bri = Math.max(bri, 1);
            if (kelvin > 0) l.kelvin = Math.max(l.kMin(), Math.min(l.kMax(), kelvin));
            cmds.add(new Cmd(l, SET_COLOR, colorPayload(l.hue, l.sat, l.bri, l.kelvin, durationMs)));
        }
        save(ctx, lights);
        return sendAll(ctx, cmds, false, 0, null);
    }

    /** Built-in scenes. All bulbs. */
    static void scene(Context ctx, String name) {
        switch (name) {
            case "off":
                setPower(ctx, null, false, 800);
                return;
            case "on":
                setPower(ctx, null, true, 400);
                return;
            case "movie": // dim and warm
                setColor(ctx, null, 0, 0, pct(12), 2200, 1500);
                setPower(ctx, null, true, 1500);
                return;
            case "night": // barely on, warmest
                setColor(ctx, null, 0, 0, pct(3), 1500, 1500);
                setPower(ctx, null, true, 1500);
                return;
            case "bright":
                setColor(ctx, null, 0, 0, pct(100), 4000, 1500);
                setPower(ctx, null, true, 400);
                return;
            default:
                Log.w(TAG, "Unknown scene " + name);
        }
    }

    static int pct(int percent) {
        return Math.round(percent / 100f * 65535);
    }
}
