package com.claude.house;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Runs the bedtime alarm and scene timers in the background, with the app closed. */
public class ActionReceiver extends BroadcastReceiver {
    // One worker so widget taps and the alarms run in order.
    static final ExecutorService worker = Executors.newSingleThreadExecutor();

    @Override
    public void onReceive(Context ctx, Intent intent) {
        Context app = ctx.getApplicationContext();
        if (WifiWatch.ACTION.equals(intent.getAction())) {
            PendingResult result = goAsync();
            // Own thread: a sweep takes ~15 s and shouldn't hold up widget taps.
            new Thread(() -> {
                try {
                    WifiWatch.check(app);
                } catch (Exception ignored) {
                } finally {
                    result.finish();
                }
            }).start();
            return;
        }
        if (SceneTimers.ACTION.equals(intent.getAction())) {
            PendingResult result = goAsync();
            worker.execute(() -> {
                try {
                    SceneTimers.fire(app);
                    LightsWidget.redraw(app);
                } finally {
                    result.finish();
                }
            });
            return;
        }
        if (!Bedtime.ACTION.equals(intent.getAction())) return;
        PendingResult result = goAsync();
        worker.execute(() -> {
            try {
                Lifx.setPower(app, null, false, 3000);
                LightsWidget.redraw(app);
            } finally {
                Bedtime.schedule(app);
                result.finish();
            }
        });
    }
}
