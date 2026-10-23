package com.claude.house;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Runs the bedtime alarm in the background, with the app closed. */
public class ActionReceiver extends BroadcastReceiver {
    // One worker so widget taps and the alarm run in order.
    static final ExecutorService worker = Executors.newSingleThreadExecutor();

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!Bedtime.ACTION.equals(intent.getAction())) return;
        Context app = ctx.getApplicationContext();
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
