package com.claude.house;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Typeface;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.core.content.ContextCompat;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Picks the bulb for a One light widget (opens when the widget is added, or tapped before a pick). */
public class OneLightConfig extends Activity {
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        int widgetId = getIntent().getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        setResult(RESULT_CANCELED, new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId));
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) { finish(); return; }

        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        int bg = ContextCompat.getColor(this, dark ? R.color.app_bg_dark : R.color.app_bg_light);
        int fg = dark ? 0xFFF2F5FF : 0xFF121626, muted = dark ? 0xFF9AA3BD : 0xFF535C74;
        getWindow().setStatusBarColor(bg);
        getWindow().setNavigationBarColor(bg);

        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        list.setPadding(pad, dp(36), pad, pad);
        list.setBackgroundColor(bg);
        list.addView(text("Which light?", 22, fg, true));
        list.addView(text("Tap the light this widget turns on and off.", 14, muted, false));

        Map<String, Lifx.Light> lights = Lifx.cached(this);
        List<Lifx.Light> sorted = new ArrayList<>(lights.values());
        sorted.sort((a, b) -> (a.group + a.label).compareToIgnoreCase(b.group + b.label));
        if (sorted.isEmpty()) list.addView(text("No lights yet. Open House once on your home Wi-Fi to find them, then add the widget again.", 15, fg, false));
        for (Lifx.Light l : sorted) {
            TextView row = text(l.label + (l.group.isEmpty() ? "" : "   ·   " + l.group), 17, fg, true);
            row.setPadding(dp(16), dp(16), dp(16), dp(16));
            row.setBackgroundResource(R.drawable.wl_tile);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            lp.topMargin = dp(10);
            row.setLayoutParams(lp);
            row.setOnClickListener((view) -> {
                getSharedPreferences(Lifx.PREFS, MODE_PRIVATE).edit().putString("wone_" + widgetId, l.id).apply();
                Widgets.draw(this, AppWidgetManager.getInstance(this), OneLightWidget.class, widgetId);
                setResult(RESULT_OK, new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId));
                finish();
            });
            list.addView(row);
        }
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(bg);
        scroll.addView(list);
        setContentView(scroll);
    }

    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setGravity(Gravity.START);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(6), 0, dp(6));
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
