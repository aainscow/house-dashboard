package uk.demodrive.house;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.text.TextUtils;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Switch;
import android.widget.TextView;

/**
 * 32 Demo Drive: the house dashboard (served by the Pi) full screen, in its own app.
 * Settings (the Pi's address, real or demo, keep the screen on) open from the gear on the dashboard,
 * or from the "can't reach the house" screen.
 */
public class MainActivity extends Activity {
    private static final String DEFAULT_HOST = "192.168.1.10";
    private WebView web;
    private SharedPreferences prefs;

    private String host() { return prefs.getString("host", DEFAULT_HOST).trim(); }
    private boolean demo() { return prefs.getBoolean("demo", false); }
    private String url() { return "http://" + host() + ":" + (demo() ? 8081 : 8080) + "/"; }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        prefs = getSharedPreferences("house", MODE_PRIVATE);

        web = new WebView(this);
        web.setBackgroundColor(0xFF0B0E12);
        setContentView(web);
        // keep the page clear of the status and navigation bars (Android 15 draws apps edge to edge)
        web.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets b = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                v.setPadding(b.left, b.top, b.right, b.bottom);
            } else {
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setUserAgentString(s.getUserAgentString() + " DemoDriveApp/1.0");  // the dashboard shows its gear when it sees this
        web.addJavascriptInterface(new Bridge(), "HouseApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (host().equalsIgnoreCase(u.getHost())) return false;     // the house: stay in the app
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;                                                 // anything else: the browser
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) showOffline(String.valueOf(e.getDescription()));
            }
        });

        keepScreenOn();
        if (saved != null) web.restoreState(saved);
        else web.loadUrl(url());
    }

    /** What the dashboard (and the offline screen) can ask the app to do. */
    private class Bridge {
        @JavascriptInterface public void settings() { runOnUiThread(MainActivity.this::showSettings); }
        @JavascriptInterface public void retry() { runOnUiThread(() -> web.loadUrl(url())); }
    }

    private void showOffline(String reason) {
        String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<body style='margin:0;background:#0b0e12;color:#eef1f5;font-family:sans-serif;display:flex;"
                + "align-items:center;justify-content:center;min-height:100vh;text-align:center'><div style='padding:24px'>"
                + "<div style='font-size:44px;color:#ffb547'>⌂</div>"
                + "<h2 style='font-weight:600;margin:8px 0'>Can't reach the house</h2>"
                + "<p style='color:#a8b1bd;margin:0 0 4px'>" + TextUtils.htmlEncode(url()) + "</p>"
                + "<p style='color:#6b7684;font-size:13px;margin:0 0 22px'>" + TextUtils.htmlEncode(reason)
                + "<br>Is the phone on the home Wi-Fi?</p>"
                + "<button onclick='HouseApp.retry()' style='" + BTN + "background:#ffb547;color:#111'>Try again</button> "
                + "<button onclick='HouseApp.settings()' style='" + BTN + "background:#1c2229;color:#eef1f5'>Settings</button>"
                + "</div></body>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private static final String BTN = "border:0;border-radius:12px;padding:12px 20px;font-size:15px;margin:4px;";

    private void showSettings() {
        int pad = (int) (20 * getResources().getDisplayMetrics().density);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(pad, pad / 2, pad, 0);

        TextView label = new TextView(this);
        label.setText("The Pi's address");
        EditText hostIn = new EditText(this);
        hostIn.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        hostIn.setText(host());
        hostIn.setHint(DEFAULT_HOST);
        Switch demoIn = new Switch(this);
        demoIn.setText("Demo (a simulated house: nothing real is touched)");
        demoIn.setChecked(demo());
        CheckBox awakeIn = new CheckBox(this);
        awakeIn.setText("Keep the screen on");
        awakeIn.setChecked(prefs.getBoolean("awake", false));
        box.addView(label);
        box.addView(hostIn);
        box.addView(demoIn);
        box.addView(awakeIn);

        new AlertDialog.Builder(this)
                .setTitle("Demo Drive")
                .setView(box)
                .setPositiveButton("Save", (d, w) -> {
                    String h = hostIn.getText().toString().trim();
                    prefs.edit().putString("host", h.isEmpty() ? DEFAULT_HOST : h)
                            .putBoolean("demo", demoIn.isChecked())
                            .putBoolean("awake", awakeIn.isChecked()).apply();
                    keepScreenOn();
                    web.loadUrl(url());
                })
                .setNeutralButton("Reload", (d, w) -> web.loadUrl(url()))
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void keepScreenOn() {
        if (prefs.getBoolean("awake", false)) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }
    @Override protected void onPause() { super.onPause(); web.onPause(); }
    @Override protected void onResume() { super.onResume(); web.onResume(); }
}
