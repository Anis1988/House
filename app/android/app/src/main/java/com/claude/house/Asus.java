package com.claude.house;

import android.content.Context;
import android.util.Base64;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import okhttp3.FormBody;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The ASUS router's own web API (what the ASUS Router app uses): sign in once, then read with
 * appGet.cgi hooks or its .asp pages, and change settings with applyapp.cgi. Home Wi-Fi only.
 * The sign-in comes from the app (Wi-Fi → Settings), typed by you and kept on this phone.
 */
final class Asus {
    private static final String UA = "asusrouter-Android-DUTUtil-1.0.0.245";
    private static String base, token;

    private Asus() {}

    private static final OkHttpClient http = LanNet.client().newBuilder()
        .connectTimeout(5, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build();

    static boolean signedIn(Context ctx) {
        return !HouseActions.creds(ctx).optString("routerPass").isEmpty();
    }

    private static String baseUrl(Context ctx) {
        String addr = HouseActions.creds(ctx).optString("routerAddr");
        if (addr.isEmpty()) {
            String subnet = Lifx.subnet(ctx);
            addr = subnet.isEmpty() ? "192.168.50.1" : subnet + ".1";
        }
        addr = addr.replaceAll("/+$", "");
        return addr.startsWith("http") ? addr : "http://" + addr;
    }

    private static synchronized String login(Context ctx) throws Exception {
        JSONObject c = HouseActions.creds(ctx);
        if (c.optString("routerPass").isEmpty()) throw new Exception("Sign in to the router in Wi-Fi → Settings first");
        base = baseUrl(ctx);
        String auth = Base64.encodeToString((c.optString("routerUser", "admin") + ":" + c.optString("routerPass")).getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        try (Response r = http.newCall(new Request.Builder().url(base + "/login.cgi").header("User-Agent", UA)
            .post(RequestBody.create("login_authorization=" + URLEncoder.encode(auth, "UTF-8"), MediaType.get("application/x-www-form-urlencoded"))).build()).execute()) {
            JSONObject j = new JSONObject(r.body().string());
            token = j.optString("asus_token");
            if (token.isEmpty()) {
                int why = j.optInt("error_status");
                throw new Exception(why == 3 ? "Wrong router username or password"
                    : why == 7 ? "The router paused sign-ins after too many tries. Wait a few minutes."
                    : why == 10 ? "The router wants a captcha. Sign in once in its web page, then try again."
                    : "The router didn't accept the sign-in");
            }
        } catch (java.io.IOException e) {
            throw new Exception("Can't reach the router. Are you on the home Wi-Fi?");
        }
        return token;
    }

    private static Request.Builder req(String path) {
        return new Request.Builder().url(base + path).header("User-Agent", UA)
            .header("Cookie", "asus_token=" + token).header("Referer", base + "/index.asp");
    }

    private static boolean loggedOut(String body) {
        return body.contains("Main_Login") || body.contains("login.cgi") || body.contains("\"error_status\"");
    }

    /** GET a router page (signing in again if the session ran out). Blocking. */
    static synchronized String get(Context ctx, String path) throws Exception {
        if (token == null || !baseUrl(ctx).equals(base)) login(ctx);
        for (int attempt = 0; ; attempt++) {
            String body;
            try (Response r = http.newCall(req(path).build()).execute()) {
                body = r.body().string();
            } catch (java.io.IOException e) {
                throw new Exception("Can't reach the router. Are you on the home Wi-Fi?");
            }
            if (!loggedOut(body) || attempt > 0) return body;
            login(ctx);
        }
    }

    /** appGet.cgi hooks, e.g. "get_clientlist()" or "nvram_get(productid)". → their JSON. */
    static JSONObject hook(Context ctx, String hooks) throws Exception {
        String body = get(ctx, "/appGet.cgi?hook=" + URLEncoder.encode(hooks, "UTF-8"));
        try {
            return new JSONObject(body);
        } catch (Exception e) {
            throw new Exception("The router gave an answer the app doesn't understand");
        }
    }

    /** Several router settings at once. Missing ones come back as "". */
    static JSONObject nvram(Context ctx, String... keys) throws Exception {
        StringBuilder h = new StringBuilder();
        for (String k : keys) h.append("nvram_get(").append(k).append(");");
        return hook(ctx, h.toString());
    }

    /** Changes settings and runs the given router service(s), e.g. "restart_firewall". Blocking. */
    static synchronized void apply(Context ctx, Map<String, String> values, String service) throws Exception {
        if (token == null || !baseUrl(ctx).equals(base)) login(ctx);
        FormBody.Builder f = new FormBody.Builder().add("action_mode", "apply").add("rc_service", service);
        for (Map.Entry<String, String> e : values.entrySet()) f.add(e.getKey(), e.getValue());
        FormBody form = f.build();
        for (int attempt = 0; ; attempt++) {
            String body;
            int code;
            try (Response r = http.newCall(req("/applyapp.cgi").post(form).build()).execute()) {
                body = r.body().string();
                code = r.code();
            } catch (java.io.IOException e) {
                // Rebooting or restarting Wi-Fi can drop the answer: that's fine.
                if (service.contains("reboot") || service.contains("wireless")) return;
                throw new Exception("Can't reach the router. Are you on the home Wi-Fi?");
            }
            if (loggedOut(body) && attempt == 0) { login(ctx); continue; }
            if (code >= 400) throw new Exception("The router said no (" + code + ")");
            return;
        }
    }

    static Map<String, String> map(String... kv) {
        Map<String, String> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put(kv[i], kv[i + 1]);
        return m;
    }

    private static final Pattern VAR = Pattern.compile("(\\w+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|(-?[\\d.]+))\\s*;");

    /** The simple `name = "value";` lines of a router .asp page. */
    static Map<String, String> jsVars(String page) {
        Map<String, String> out = new LinkedHashMap<>();
        Matcher m = VAR.matcher(page);
        while (m.find()) out.put(m.group(1), m.group(2) != null ? m.group(2) : m.group(3) != null ? m.group(3) : m.group(4));
        return out;
    }

    /** A `name = [[...],[...]];` array from a router .asp page (empty if it isn't there). */
    static JSONArray jsArray(String page, String name) {
        Matcher m = Pattern.compile("\\b" + name + "\\s*=\\s*\\[").matcher(page);
        String found = null;
        while (m.find()) { // the last assignment wins (pages set it to new Array() first)
            int start = m.end() - 1, depth = 0;
            for (int i = start; i < page.length(); i++) {
                char ch = page.charAt(i);
                if (ch == '[') depth++;
                else if (ch == ']' && --depth == 0) { found = page.substring(start, i + 1); break; }
            }
        }
        if (found == null) return new JSONArray();
        try {
            return new JSONArray(found.replace('\'', '"'));
        } catch (Exception e) {
            return new JSONArray();
        }
    }
}
