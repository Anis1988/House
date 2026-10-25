package com.claude.house;

import android.content.Context;
import java.util.Collections;
import java.util.List;
import org.json.JSONObject;

/**
 * Lights react to the Wi-Fi: the chosen light blinks three times when the internet goes down
 * or a new device joins, then goes back to how it was. Works without internet (LIFX over the LAN).
 *
 * Settings (in "watch"): { flashLight: bulb id, flashOutage, flashNew }
 */
final class WifiFlash {
    private WifiFlash() {}

    /** Blocking (about 4 seconds). Home Wi-Fi only. */
    static void flash(Context ctx) {
        JSONObject s = WifiWatch.settings(ctx);
        String id = s.optString("flashLight");
        if (id.isEmpty() || !Presence.atHome(ctx)) return;
        Lifx.Light l = Lifx.cached(ctx).get(id);
        if (l == null) return;
        List<String> one = Collections.singletonList(id);
        boolean wasOn = l.on;
        int bri = l.bri;
        try {
            if (!wasOn) Lifx.setColor(ctx, one, -1, -1, 65535, -1, 0);
            for (int i = 0; i < 3; i++) {
                Lifx.setPower(ctx, one, !wasOn, 0);
                Thread.sleep(600);
                Lifx.setPower(ctx, one, wasOn, 0);
                Thread.sleep(600);
            }
            if (!wasOn) Lifx.setColor(ctx, one, -1, -1, bri, -1, 0);
        } catch (InterruptedException ignored) {}
    }
}
