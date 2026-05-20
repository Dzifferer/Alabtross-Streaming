package com.albatross.firetv;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.text.TextUtils;
import android.widget.Button;
import android.widget.EditText;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

/**
 * Two-field server picker: a Tailscale URL and a LAN URL. Whichever button
 * is pressed becomes the active address and is loaded by WebViewActivity.
 * Both fields are persisted so the user can swap between them with a single
 * click on subsequent visits (Menu button on the Fire TV remote re-opens
 * this screen).
 */
public class ConfigActivity extends AppCompatActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_config);

        SharedPreferences prefs =
            getSharedPreferences(WebViewActivity.PREFS, MODE_PRIVATE);

        EditText tailscaleField = findViewById(R.id.tailscale_url);
        EditText lanField = findViewById(R.id.lan_url);
        Button tailscaleBtn = findViewById(R.id.connect_tailscale);
        Button lanBtn = findViewById(R.id.connect_lan);

        tailscaleField.setText(prefs.getString(
            WebViewActivity.KEY_TAILSCALE, "https://albatross"));
        lanField.setText(prefs.getString(
            WebViewActivity.KEY_LAN, ""));

        tailscaleBtn.setOnClickListener(v ->
            connect(prefs, tailscaleField, WebViewActivity.KEY_TAILSCALE));
        lanBtn.setOnClickListener(v ->
            connect(prefs, lanField, WebViewActivity.KEY_LAN));
    }

    private void connect(SharedPreferences prefs, EditText field, String key) {
        String raw = field.getText().toString().trim();
        if (TextUtils.isEmpty(raw)) {
            Toast.makeText(this, R.string.enter_url_first, Toast.LENGTH_SHORT).show();
            return;
        }
        if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
            // Default to http:// — LAN URLs are the common case where the
            // user forgets a scheme; Tailscale URLs are already typed with
            // https:// in the placeholder.
            raw = "http://" + raw;
        }

        prefs.edit()
            .putString(key, raw)              // remember per-channel for next time
            .putString(WebViewActivity.KEY_URL, raw)  // active URL
            .apply();

        Intent result = new Intent();
        result.putExtra("url", raw);
        setResult(RESULT_OK, result);
        finish();
    }
}
