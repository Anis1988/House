package com.claude.house;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.URI;
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
