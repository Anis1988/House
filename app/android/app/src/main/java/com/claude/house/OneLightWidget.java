package com.claude.house;

import android.content.Context;

/** One light (1x1): pick the bulb when adding it; tap to turn it on or off. */
public class OneLightWidget extends BaseWidget {
    @Override
    public void onDeleted(Context ctx, int[] ids) {
        android.content.SharedPreferences.Editor e = ctx.getSharedPreferences(Lifx.PREFS, Context.MODE_PRIVATE).edit();
        for (int id : ids) e.remove("wone_" + id);
        e.apply();
    }
}
