package com.claude.house;

import android.content.res.Configuration;
import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LightsPlugin.class);
        registerPlugin(NetPlugin.class);
        super.onCreate(savedInstanceState);
        applySystemBars();

        // Back: let the page close a panel first; only leave when it says so.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                getBridge().getWebView().evaluateJavascript("window.appBack ? window.appBack() : false", handled -> {
                    if ("true".equals(handled)) return;
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    setEnabled(true);
                });
            }
        });
    }

    // The activity handles uiMode changes itself, so re-color the system bars when light/dark flips.
    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applySystemBars();
    }

    // Set by the page's theme switch; null means follow the phone.
    private Boolean themeDark = null;

    void setThemeDark(boolean dark) {
        themeDark = dark;
        applySystemBars();
    }

    private void applySystemBars() {
        boolean dark = themeDark != null ? themeDark
            : (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        int bg = ContextCompat.getColor(this, dark ? R.color.app_bg_dark : R.color.app_bg_light);
        getWindow().getDecorView().setBackgroundColor(bg);
        getWindow().setStatusBarColor(bg);
        getWindow().setNavigationBarColor(bg);
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(!dark);
        bars.setAppearanceLightNavigationBars(!dark);
    }
}
