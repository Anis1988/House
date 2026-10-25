package com.claude.house;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;
import java.util.Map;
import java.util.UUID;

/** Home-screen widget: All on / All off, and how many lights are on. */
public class LightsWidget extends AppWidgetProvider {
    static final String ACTION = "com.claude.house.WIDGET_CMD";

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] widgetIds) {
        for (int id : widgetIds) mgr.updateAppWidget(id, build(ctx, null));
        // Placed, or the 30-minute refresh: re-check the bulbs.
        Context app = ctx.getApplicationContext();
        PendingResult result = goAsync();
        ActionReceiver.worker.execute(() -> {
            try {
                Lifx.scan(app, 1500, null);
                redraw(app);
            } finally {
                result.finish();
            }
        });
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        super.onReceive(ctx, intent);
        if (!ACTION.equals(intent.getAction())) return;
        // The receiver is exported for the launcher; only our own buttons carry the token.
        if (!token(ctx).equals(intent.getStringExtra("token"))) return;
        boolean on = "ON".equals(intent.getStringExtra("cmd"));
        Context app = ctx.getApplicationContext();
        redraw(app, on ? "Turning on…" : "Turning off…");
        PendingResult result = goAsync();
        ActionReceiver.worker.execute(() -> {
            try {
                Lifx.setPower(app, null, on, on ? 400 : 800);
                redraw(app);
            } finally {
                result.finish();
            }
        });
    }

    private static String token(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(Lifx.PREFS, Context.MODE_PRIVATE);
        String t = p.getString("widgetToken", null);
        if (t == null) {
            t = UUID.randomUUID().toString();
            p.edit().putString("widgetToken", t).apply();
        }
        return t;
    }

    private static String status(Context ctx) {
        Map<String, Lifx.Light> lights = Lifx.cached(ctx);
        if (lights.isEmpty()) return "Open the app to find lights";
        int on = 0;
        for (Lifx.Light l : lights.values()) if (l.on) on++;
        if (on == 0) return "All " + lights.size() + " off";
        if (on == lights.size()) return "All " + on + " on";
        return on + " of " + lights.size() + " on";
    }

    private static RemoteViews build(Context ctx, String text) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_lights);
        String token = token(ctx);
        int[] ids = {R.id.w_on, R.id.w_off};
        String[] cmds = {"ON", "OFF"};
        for (int i = 0; i < ids.length; i++) {
            Intent intent = new Intent(ctx, LightsWidget.class).setAction(ACTION).putExtra("cmd", cmds[i]).putExtra("token", token);
            v.setOnClickPendingIntent(ids[i], PendingIntent.getBroadcast(ctx, i, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        }
        Intent open = new Intent(ctx, MainActivity.class);
        v.setOnClickPendingIntent(R.id.w_title, PendingIntent.getActivity(ctx, 100, open, PendingIntent.FLAG_IMMUTABLE));
        v.setTextViewText(R.id.w_status, text != null ? text : status(ctx));
        return v;
    }

    /** Redraws this widget and all the other Lights widgets. */
    static void redraw(Context ctx) {
        Widgets.redrawAll(ctx);
    }

    static void redrawOnly(Context ctx) {
        redraw(ctx, null);
    }

    static void redraw(Context ctx, String text) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, LightsWidget.class));
        if (ids.length > 0) mgr.updateAppWidget(ids, build(ctx, text));
    }
}
