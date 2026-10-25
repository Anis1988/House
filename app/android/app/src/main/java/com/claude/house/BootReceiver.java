package com.claude.house;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Alarms are cleared by a phone restart or an app update; set them up again. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) return;
        Bedtime.schedule(ctx);
        SceneTimers.schedule(ctx);
        SceneOffs.schedule(ctx);
        WifiWatch.schedule(ctx);
        Presence.register(ctx);
        NestWatch.schedule(ctx);
        WifiLog.schedule(ctx);
        VacationMode.schedule(ctx);
    }
}
