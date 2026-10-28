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
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Sets up a Priority widget: which device, then for how long each tap gives it priority.
 * Devices come from the Wi-Fi side's last list (with your own names). Saved as "wprio_<id>".
 */
public class PriorityConfig extends Activity {
    private int widgetId;
    private int bg, fg, muted;
    private LinearLayout list;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        widgetId = getIntent().getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        setResult(RESULT_CANCELED, new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId));
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) { finish(); return; }

        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        bg = ContextCompat.getColor(this, dark ? R.color.app_bg_dark : R.color.app_bg_light);
        fg = dark ? 0xFFF2F5FF : 0xFF121626;
        muted = dark ? 0xFF9AA3BD : 0xFF535C74;
        getWindow().setStatusBarColor(bg);
        getWindow().setNavigationBarColor(bg);

        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        list.setPadding(pad, dp(36), pad, pad);
        list.setBackgroundColor(bg);
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(bg);
        scroll.addView(list);
        setContentView(scroll);
        devices();
    }

    private void devices() {
        list.removeAllViews();
        list.addView(text("Which device?", 22, fg, true));
        list.addView(text("Each tap on the widget gives it priority (bandwidth first), or ends it.", 14, muted, false));
        JSONArray all = HouseActions.creds(this).optJSONArray("wifiDevices");
        List<JSONObject> sorted = new ArrayList<>();
        for (int i = 0; all != null && i < all.length(); i++) sorted.add(all.optJSONObject(i));
        // Phones and computers first, then online ones, then by name.
        sorted.sort((a, b) -> {
            int ka = rank(a), kb = rank(b);
            if (ka != kb) return ka - kb;
            if (a.optBoolean("online") != b.optBoolean("online")) return a.optBoolean("online") ? -1 : 1;
            return a.optString("label").compareToIgnoreCase(b.optString("label"));
        });
        if (sorted.isEmpty()) list.addView(text("No devices yet. Sign in to your router in House (Wi-Fi → Settings), open the Devices tab once, then add the widget again.", 15, fg, false));
        for (JSONObject d : sorted) {
            TextView row = row(d.optString("label", d.optString("mac")) + (d.optBoolean("online") ? "" : "   ·   offline"));
            row.setOnClickListener((view) -> durations(d));
            list.addView(row);
        }
    }

    private static int rank(JSONObject d) {
        String k = d.optString("kind");
        return "laptop".equals(k) ? 0 : "phone".equals(k) ? 1 : "tv".equals(k) || "screen".equals(k) ? 2 : 3;
    }

    private void durations(JSONObject d) {
        list.removeAllViews();
        list.addView(text(d.optString("label"), 22, fg, true));
        list.addView(text("For how long does each tap give it priority?", 14, muted, false));
        int[] mins = {60, 120, 240, 0};
        String[] labels = {"1 hour", "2 hours", "4 hours", "Until I tap again"};
        for (int i = 0; i < mins.length; i++) {
            int m = mins[i];
            TextView row = row(labels[i]);
            row.setOnClickListener((view) -> {
                try {
                    JSONObject cfg = new JSONObject().put("mac", d.optString("mac")).put("name", d.optString("label")).put("minutes", m);
                    getSharedPreferences(Lifx.PREFS, MODE_PRIVATE).edit().putString("wprio_" + widgetId, cfg.toString()).apply();
                } catch (Exception ignored) {}
                Widgets.draw(this, AppWidgetManager.getInstance(this), PriorityWidget.class, widgetId);
                setResult(RESULT_OK, new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId));
                finish();
            });
            list.addView(row);
        }
        TextView back = text("‹ Pick another device", 15, muted, true);
        back.setPadding(0, dp(18), 0, dp(6));
        back.setOnClickListener((view) -> devices());
        list.addView(back);
    }

    private TextView row(String s) {
        TextView row = text(s, 17, fg, true);
        row.setPadding(dp(16), dp(16), dp(16), dp(16));
        row.setBackgroundResource(R.drawable.wl_tile);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(10);
        row.setLayoutParams(lp);
        return row;
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
