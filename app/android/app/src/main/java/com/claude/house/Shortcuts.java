package com.claude.house;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Shader;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.Icon;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Long-press the House icon: your first four scenes, each with its icon and colour. A tap runs
 * the scene in the background (ShortcutActivity) without opening the app. Updated whenever the
 * scenes change.
 */
final class Shortcuts {
    static final String ACTION = "com.claude.house.RUN_SCENE";

    private Shortcuts() {}

    // Same colours as the app and the Scenes widget.
    private static final String[][] COLORS = {
        {"amber", "#fbbf24", "#f97316"}, {"coral", "#fb7185", "#e11d48"}, {"pink", "#f472b6", "#c026d3"}, {"violet", "#a78bfa", "#6d28d9"},
        {"blue", "#60a5fa", "#2563eb"}, {"teal", "#2dd4bf", "#0d9488"}, {"green", "#4ade80", "#16a34a"}, {"grey", "#94a3b8", "#475569"},
    };

    static String colorOf(JSONObject scene) {
        String c = scene.optString("color");
        if (!c.isEmpty()) return c;
        switch (scene.optString("id")) {
            case "bright": return "amber";
            case "movie": return "violet";
            case "night": return "coral";
            case "off": return "grey";
            default: return "amber";
        }
    }

    /** A round icon: the scene's colour with its symbol in white. */
    static Bitmap icon(Context ctx, JSONObject scene, int px) {
        String[] c = COLORS[0];
        for (String[] k : COLORS) if (k[0].equals(colorOf(scene))) c = k;
        Bitmap b = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(b);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setShader(new LinearGradient(0, 0, px, px, Color.parseColor(c[1]), Color.parseColor(c[2]), Shader.TileMode.CLAMP));
        cv.drawCircle(px / 2f, px / 2f, px / 2f, p);
        Drawable d = ctx.getDrawable(Widgets.icon(scene.optString("icon")));
        if (d != null) {
            int pad = px * 27 / 100;
            d.setBounds(pad, pad, px - pad, px - pad);
            d.draw(cv);
        }
        return b;
    }

    static void update(Context ctx) {
        try {
            ShortcutManager sm = ctx.getSystemService(ShortcutManager.class);
            if (sm == null) return;
            JSONArray all = SceneTimers.scenes(ctx);
            List<ShortcutInfo> list = new ArrayList<>();
            int max = Math.min(4, sm.getMaxShortcutCountPerActivity());
            for (int i = 0; i < all.length() && list.size() < max; i++) {
                JSONObject s = all.getJSONObject(i);
                String name = s.optString("name", "Scene");
                Intent run = new Intent(ctx, ShortcutActivity.class).setAction(ACTION).putExtra("id", s.optString("id"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                list.add(new ShortcutInfo.Builder(ctx, "scene_" + s.optString("id"))
                    .setShortLabel(name.length() > 10 ? name.substring(0, 10) : name).setLongLabel(name)
                    .setIcon(Icon.createWithBitmap(icon(ctx, s, 192))).setIntent(run).setRank(i).build());
            }
            sm.setDynamicShortcuts(list);
        } catch (Exception ignored) {}
    }
}
