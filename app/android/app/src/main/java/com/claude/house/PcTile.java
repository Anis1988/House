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

/** Quick Settings tile for the paired PC: on → sleep it, off → turn it on (Wake-on-LAN). */
public class PcTile extends TileService {
    @Override
    public void onStartListening() {
        paint(PcLink.state(this));
        Context app = getApplicationContext();
        new Thread(() -> {
            PcLink.refresh(app);
            requestListeningState(app, new ComponentName(app, PcTile.class));
        }).start();
    }

    @Override
    public void onClick() {
        boolean on = PcLink.state(this).optBoolean("online");
        Context app = getApplicationContext();
        new Thread(() -> {
            String msg;
            try {
                if (on) { PcLink.cmd(app, "sleep"); msg = "Putting the PC to sleep"; }
                else { PcLink.wake(app); msg = "Waking the PC… give it a minute"; }
            } catch (Exception e) {
                msg = e.getMessage() == null ? "The PC didn't answer" : e.getMessage();
            }
            String m = msg;
            new Handler(Looper.getMainLooper()).post(() -> Toast.makeText(app, m, Toast.LENGTH_SHORT).show());
            requestListeningState(app, new ComponentName(app, PcTile.class));
        }).start();
    }

    private void paint(JSONObject s) {
        Tile t = getQsTile();
        if (t == null) return;
        JSONObject pc = PcLink.pc(this);
        boolean on = s.optBoolean("online");
        t.setState(pc == null ? Tile.STATE_UNAVAILABLE : on ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        t.setLabel(pc == null ? "PC" : pc.optString("name", "PC"));
        t.setIcon(Icon.createWithResource(this, R.drawable.wl_pc));
        if (android.os.Build.VERSION.SDK_INT >= 29) t.setSubtitle(pc == null ? "Pair in the app" : on ? "On · tap to sleep" : "Off · tap to turn on");
        t.updateTile();
    }
}
