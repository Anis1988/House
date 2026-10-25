package com.claude.house;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;

/** Invisible: runs the scene from an app-icon shortcut in the background, then closes. */
public class ShortcutActivity extends Activity {
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        String id = getIntent().getStringExtra("id");
        if (id != null) {
            String name = "Scene";
            JSONArray all = SceneTimers.scenes(this);
            for (int i = 0; i < all.length(); i++) {
                JSONObject s = all.optJSONObject(i);
                if (s != null && id.equals(s.optString("id"))) name = s.optString("name", name);
            }
            sendBroadcast(new Intent(this, ActionReceiver.class).setAction(Widgets.ACTION).putExtra("op", "scene").putExtra("arg", id));
            Toast.makeText(this, name, Toast.LENGTH_SHORT).show();
        }
        finish();
    }
}
