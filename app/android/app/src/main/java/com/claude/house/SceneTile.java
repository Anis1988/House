package com.claude.house;

import android.content.ComponentName;
import android.content.Context;
import android.graphics.drawable.Icon;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;
import org.json.JSONArray;
import org.json.JSONObject;

/** Quick Settings tile: runs the scene picked in Lights → Settings (the first scene until then). */
public class SceneTile extends TileService {
    static JSONObject scene(Context ctx) {
        String id = HomeAuto.settings(ctx).optString("qsScene");
        JSONArray all = SceneTimers.scenes(ctx);
        for (int i = 0; i < all.length(); i++) if (id.equals(all.optJSONObject(i).optString("id"))) return all.optJSONObject(i);
        return all.length() > 0 ? all.optJSONObject(0) : null;
    }

    @Override
    public void onStartListening() {
        Tile t = getQsTile();
        if (t == null) return;
        JSONObject s = scene(this);
        t.setState(s == null ? Tile.STATE_UNAVAILABLE : Tile.STATE_INACTIVE);
        t.setLabel(s == null ? "Scene" : s.optString("name"));
        t.setIcon(Icon.createWithResource(this, Widgets.icon(s == null ? "star" : s.optString("icon"))));
        if (android.os.Build.VERSION.SDK_INT >= 29) t.setSubtitle("Scene");
        t.updateTile();
    }

    @Override
    public void onClick() {
        JSONObject s = scene(this);
        if (s == null) return;
        Tile t = getQsTile();
        if (t != null) { t.setState(Tile.STATE_ACTIVE); t.updateTile(); }
        Context app = getApplicationContext();
        ActionReceiver.worker.execute(() -> {
            SceneTimers.runScene(app, s, 0);
            Widgets.redrawAll(app);
            requestListeningState(app, new ComponentName(app, SceneTile.class));
        });
    }
}
