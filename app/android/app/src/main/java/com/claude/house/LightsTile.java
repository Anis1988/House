package com.claude.house;

import android.content.ComponentName;
import android.content.Context;
import android.graphics.drawable.Icon;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;
import java.util.Map;

/** Quick Settings tile: all lights on/off. */
public class LightsTile extends TileService {
    @Override
    public void onStartListening() {
        paint();
    }

    @Override
    public void onClick() {
        Tile t = getQsTile();
        if (t != null) { t.setState(t.getState() == Tile.STATE_ACTIVE ? Tile.STATE_INACTIVE : Tile.STATE_ACTIVE); t.updateTile(); }
        Context app = getApplicationContext();
        ActionReceiver.worker.execute(() -> {
            Widgets.handle(app, "all", "");
            requestListeningState(app, new ComponentName(app, LightsTile.class));
        });
    }

    private void paint() {
        Tile t = getQsTile();
        if (t == null) return;
        Map<String, Lifx.Light> ls = Lifx.cached(this);
        int on = 0;
        for (Lifx.Light l : ls.values()) if (l.on) on++;
        t.setState(on > 0 ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        t.setIcon(Icon.createWithResource(this, R.drawable.wl_bulb));
        t.setLabel("Lights");
        if (android.os.Build.VERSION.SDK_INT >= 29) t.setSubtitle(on > 0 ? on + " on" : "All off");
        t.updateTile();
    }
}
