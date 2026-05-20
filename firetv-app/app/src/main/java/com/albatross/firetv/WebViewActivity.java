package com.albatross.firetv;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

/**
 * Hosts the Albatross streaming UI inside a full-screen WebView on Fire TV.
 *
 * The web UI's tv-nav.js already implements D-pad / OK / Back / media-key
 * handling, so this Activity does just enough to:
 *
 *   - Show a server-address picker (ConfigActivity) the first time the app
 *     is launched, and again when the user presses Menu on the remote.
 *   - Configure the WebView for the things the streaming UI needs
 *     (JavaScript, DOM storage / localStorage, mixed content, autoplay,
 *     fullscreen video via WebChromeClient.onShowCustomView).
 *   - Route the hardware Back button through WebView history navigation so
 *     the web app's popstate-based back-stack drives the in-app flow.
 */
public class WebViewActivity extends AppCompatActivity {

    static final String PREFS = "albatross";
    static final String KEY_URL = "server_url";
    static final String KEY_TAILSCALE = "tailscale_url";
    static final String KEY_LAN = "lan_url";

    private static final int REQ_CONFIG = 1;

    private WebView webView;
    private FrameLayout customViewContainer;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private boolean configRequested = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_webview);

        applyImmersive();

        webView = findViewById(R.id.webview);
        customViewContainer = findViewById(R.id.customViewContainer);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                          // localStorage
        s.setMediaPlaybackRequiresUserGesture(false);          // autoplay
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setBackgroundColor(Color.parseColor("#0A0A0F"));

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                // Keep every link inside the WebView — no external browser
                // hop on Fire TV (there is no external browser to hop to).
                return false;
            }

            @Override
            public void onReceivedError(WebView view, int errorCode,
                                        String description, String failingUrl) {
                Toast.makeText(WebViewActivity.this,
                    getString(R.string.error_loading), Toast.LENGTH_LONG).show();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                customViewContainer.addView(view);
                customViewContainer.setVisibility(View.VISIBLE);
                webView.setVisibility(View.GONE);
                applyImmersive();
            }

            @Override
            public void onHideCustomView() {
                hideCustomView();
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Auto-grant any WebView permission the page asks for. The
                // streaming UI does not currently use mic/camera; this is
                // here so a future feature does not fail silently.
                request.grant(request.getResources());
            }
        });

        String url = getSharedPreferences(PREFS, MODE_PRIVATE)
            .getString(KEY_URL, null);
        if (TextUtils.isEmpty(url)) {
            openConfig();
        } else {
            webView.loadUrl(url);
        }
    }

    private void hideCustomView() {
        if (customView == null) return;
        customViewContainer.removeView(customView);
        customViewContainer.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        customView = null;
        if (customViewCallback != null) {
            customViewCallback.onCustomViewHidden();
            customViewCallback = null;
        }
        applyImmersive();
    }

    private void openConfig() {
        if (configRequested) return;
        configRequested = true;
        startActivityForResult(new Intent(this, ConfigActivity.class), REQ_CONFIG);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        configRequested = false;
        if (requestCode != REQ_CONFIG) return;

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (resultCode != RESULT_OK || data == null) {
            // No URL chosen on first launch → nothing useful to show, exit.
            if (TextUtils.isEmpty(prefs.getString(KEY_URL, null))) finish();
            return;
        }
        String url = data.getStringExtra("url");
        if (!TextUtils.isEmpty(url)) {
            webView.loadUrl(url);
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // Fire TV remote "Menu" / hamburger button reopens the server
        // picker so the user can swap between Tailscale and LAN.
        if (keyCode == KeyEvent.KEYCODE_MENU) {
            openConfig();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        // 1. Exit fullscreen video, if any
        if (customView != null) {
            hideCustomView();
            return;
        }
        // 2. Step back through WebView history. tv-nav.js pushes a sentinel
        //    history entry while TV mode is active, so each Back press
        //    triggers a popstate the web app turns into an in-app back step.
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        // 3. Truly at the root — leave the app.
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        applyImmersive();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    private void applyImmersive() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            View v = getWindow().getDecorView();
            v.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }
}
