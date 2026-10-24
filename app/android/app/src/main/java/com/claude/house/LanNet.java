package com.claude.house;

import java.net.ConnectException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import okhttp3.OkHttpClient;

/**
 * Network helpers for devices on the home network. TVs use self-signed certificates,
 * so the client accepts any cert, but only for private LAN addresses.
 */
final class LanNet {
    private static final Pattern PRIVATE_IP =
        Pattern.compile("^(10\\.\\d+|192\\.168|172\\.(1[6-9]|2\\d|3[01]))\\.\\d+\\.\\d+$");

    private static OkHttpClient client;

    private LanNet() {}

    static synchronized OkHttpClient client() {
        if (client != null) return client;
        try {
            X509TrustManager trustAll = new X509TrustManager() {
                public void checkClientTrusted(X509Certificate[] chain, String authType) {}
                public void checkServerTrusted(X509Certificate[] chain, String authType) {}
                public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            };
            SSLContext ssl = SSLContext.getInstance("TLS");
            ssl.init(null, new TrustManager[] { trustAll }, new SecureRandom());
            client = new OkHttpClient.Builder()
                .sslSocketFactory(ssl.getSocketFactory(), trustAll)
                .hostnameVerifier((host, session) -> isPrivate(host))
                .connectTimeout(5, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .pingInterval(20, TimeUnit.SECONDS)
                .build();
            return client;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    static boolean isPrivate(String host) {
        return host != null && PRIVATE_IP.matcher(host).matches();
    }

    static boolean isLanUrl(String url) {
        try {
            return isPrivate(new URI(url).getHost());
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Which addresses in prefix.1-254 have a device that's on, with the ports that answered.
     * Apps can't ping, so this knocks on a few common ports: an answer or a refusal both mean
     * something is there. Blocking, about 15 seconds.
     */
    static Map<String, Set<Integer>> sweep(String prefix) {
        int[] ports = {80, 443, 8080, 554, 62078, 7000, 8009, 3001, 8001, 6668, 9999, 1400};
        ExecutorService probes = Executors.newFixedThreadPool(224);
        Map<String, Set<Integer>> alive = new ConcurrentHashMap<>();
        for (int i = 1; i < 255; i++) {
            String host = prefix + "." + i;
            for (int port : ports) {
                probes.execute(() -> {
                    try (Socket s = new Socket()) {
                        s.connect(new InetSocketAddress(host, port), 900);
                        alive.computeIfAbsent(host, k -> Collections.synchronizedSet(new LinkedHashSet<>())).add(port);
                    } catch (ConnectException e) {
                        // Refused = a device is there, it just doesn't use this port.
                        if (String.valueOf(e.getMessage()).contains("ECONNREFUSED")) alive.computeIfAbsent(host, k -> Collections.synchronizedSet(new LinkedHashSet<>()));
                    } catch (Exception ignored) {}
                });
            }
            // Also ask the OS: works for devices that answer ping when the app may (some phones allow it).
            probes.execute(() -> {
                try {
                    if (InetAddress.getByName(host).isReachable(900)) alive.computeIfAbsent(host, k -> Collections.synchronizedSet(new LinkedHashSet<>()));
                } catch (Exception ignored) {}
            });
        }
        probes.shutdown();
        try {
            probes.awaitTermination(25, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {}
        return alive;
    }

    /** Sends a Wake-on-LAN magic packet. Blocking. */
    static void wake(String mac, String broadcast) throws Exception {
        String hex = mac == null ? "" : mac.replaceAll("[^0-9a-fA-F]", "");
        if (hex.length() != 12) throw new Exception("Connect once while it's on first");
        byte[] packet = new byte[102];
        for (int i = 0; i < 6; i++) packet[i] = (byte) 0xff;
        for (int r = 0; r < 16; r++) {
            for (int i = 0; i < 6; i++) {
                packet[6 + r * 6 + i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
            }
        }
        try (DatagramSocket sock = new DatagramSocket()) {
            sock.setBroadcast(true);
            for (String target : new String[] { broadcast, "255.255.255.255" }) {
                for (int n = 0; n < 3; n++) {
                    sock.send(new DatagramPacket(packet, packet.length, InetAddress.getByName(target), 9));
                }
            }
        }
    }
}
