package com.claude.house;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.Set;

/** Just enough DNS to ask for mDNS services and read the instance names that come back. */
final class Mdns {
    private Mdns() {}

    /** One query packet asking for PTR records of each service type. */
    static byte[] query(String[] types) {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        b.write(0); b.write(0); b.write(0); b.write(0);
        b.write(types.length >> 8); b.write(types.length & 0xff);
        for (int i = 0; i < 6; i++) b.write(0);
        for (String t : types) {
            for (String part : t.split("\\.")) {
                byte[] p = part.getBytes(StandardCharsets.UTF_8);
                b.write(p.length);
                b.write(p, 0, p.length);
            }
            b.write(0);
            b.write(0); b.write(12); // PTR
            b.write(0); b.write(1);  // IN
        }
        return b.toByteArray();
    }

    /** Instance names from PTR answers, e.g. "[LG] webOS TV OLED65C3AUA", plus "model=" style TXT values. */
    static Set<String> names(byte[] d, int len) {
        Set<String> out = new LinkedHashSet<>();
        try {
            int qd = u16(d, 4), n = u16(d, 6) + u16(d, 8) + u16(d, 10);
            int o = 12;
            for (int i = 0; i < qd; i++) o = skipName(d, o) + 4;
            for (int i = 0; i < n && o < len; i++) {
                int after = skipName(d, o);
                int type = u16(d, after), rdlen = u16(d, after + 8), rd = after + 10;
                if (type == 12) {
                    String full = readName(d, rd);
                    // "Name._service._tcp.local" → "Name"; skip the bare service list.
                    int cut = full.indexOf("._");
                    if (cut > 0) out.add(full.substring(0, cut));
                } else if (type == 16) {
                    int p = rd;
                    while (p < rd + rdlen) {
                        int l = d[p] & 0xff;
                        String t = new String(d, p + 1, l, StandardCharsets.UTF_8);
                        if (t.startsWith("md=") || t.startsWith("model=") || t.startsWith("fn=")) out.add(t);
                        p += l + 1;
                    }
                }
                o = rd + rdlen;
            }
        } catch (Exception ignored) {}
        return out;
    }

    private static int u16(byte[] d, int o) {
        return ((d[o] & 0xff) << 8) | (d[o + 1] & 0xff);
    }

    private static int skipName(byte[] d, int o) {
        while (true) {
            int l = d[o] & 0xff;
            if (l == 0) return o + 1;
            if ((l & 0xc0) == 0xc0) return o + 2;
            o += l + 1;
        }
    }

    private static String readName(byte[] d, int o) {
        StringBuilder s = new StringBuilder();
        for (int hops = 0; hops < 20; ) {
            int l = d[o] & 0xff;
            if (l == 0) break;
            if ((l & 0xc0) == 0xc0) { o = ((l & 0x3f) << 8) | (d[o + 1] & 0xff); hops++; continue; }
            if (s.length() > 0) s.append('.');
            s.append(new String(d, o + 1, l, StandardCharsets.UTF_8));
            o += l + 1;
        }
        return s.toString();
    }
}
