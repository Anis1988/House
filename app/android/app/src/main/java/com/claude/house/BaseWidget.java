package com.claude.house;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.os.Bundle;

/** Shared by the Lights widgets: draw on add, on the 30-minute refresh, and when resized. */
abstract class BaseWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) Widgets.draw(ctx, mgr, getClass(), id);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context ctx, AppWidgetManager mgr, int id, Bundle options) {
        Widgets.draw(ctx, mgr, getClass(), id);
    }
}
