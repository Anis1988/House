package com.claude.house;

import android.content.Context;

/** Priority (1x1): pick a device when adding it; each tap gives it priority, or ends it. */
public class PriorityWidget extends BaseWidget {
    @Override
    public void onDeleted(Context ctx, int[] ids) {
        android.content.SharedPreferences.Editor e = ctx.getSharedPreferences(Lifx.PREFS, Context.MODE_PRIVATE).edit();
        for (int id : ids) e.remove("wprio_" + id);
        e.apply();
    }
}
