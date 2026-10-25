package com.claude.house;

import android.content.ComponentName;
import android.content.Context;
import android.graphics.drawable.Icon;
import android.os.Handler;
import android.os.Looper;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;
import android.widget.Toast;
import org.json.JSONObject;

/** Quick Settings tile: Nest away (Eco) / home. */
public class NestTile extends TileService {
    @Override
    public void onStartListening() {
        paint();
    }

    @Override
    public void onClick() {
        boolean away = "MANUAL_ECO".equals(NestWatch.state(this).optString("eco"));
        Tile t = getQsTile();
        if (t != null) { t.setState(away ? Tile.STATE_INACTIVE : Tile.STATE_ACTIVE); t.updateTile(); }
        Context app = getApplicationContext();
        new Thread(() -> {
            try {
                NestWatch.eco(app, !away);
            } catch (Exception e) {
                String why = e.getMessage() == null ? "didn't answer" : e.getMessage();
                new Handler(Looper.getMainLooper()).post(() -> Toast.makeText(app, "Nest: " + why, Toast.LENGTH_SHORT).show());
            }
            requestListeningState(app, new ComponentName(app, NestTile.class));
        }).start();
    }

    private void paint() {
        Tile t = getQsTile();
        if (t == null) return;
        JSONObject s = NestWatch.state(this);
        boolean signed = !HouseActions.creds(this).optString("nestRefresh").isEmpty();
        boolean away = "MANUAL_ECO".equals(s.optString("eco"));
        t.setState(!signed ? Tile.STATE_UNAVAILABLE : away ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        t.setLabel(away ? "Nest away" : "Nest home");
        t.setIcon(Icon.createWithResource(this, R.drawable.wl_thermo));
        if (android.os.Build.VERSION.SDK_INT >= 29) t.setSubtitle(!signed ? "Set up Nest" : away ? "Eco on" : s.has("temp") ? NestText.temp(s, s.optDouble("temp")) + " inside" : "");
        t.updateTile();
    }
}
