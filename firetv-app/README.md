# Albatross Fire TV App

A minimal Android WebView wrapper that turns the Albatross streaming UI into
a real Fire TV app — a tile on the Fire TV home row that launches the
streaming UI full-screen, with the Fire TV remote driving everything through
the D-pad / OK / Back / media-key handling already built into the web UI
(`mobile-ui/public/js/tv-nav.js`).

The app stores **two** server addresses — a Tailscale URL and a LAN URL —
so you can swap between remote and on-network playback with a single click
from the Menu button on the remote.

---

## Build

Prereqs: **Android Studio Koala (or newer)** with bundled JDK 17. Nothing
else needs to be installed globally.

1. Open Android Studio → **Open** → select the `firetv-app/` directory.
2. Let the Gradle sync finish (Android Studio will download the Gradle
   wrapper and the AGP / AndroidX dependencies on first sync).
3. **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
4. The signed-with-debug-key APK lands at:
   `firetv-app/app/build/outputs/apk/debug/app-debug.apk`

Command-line build (same result):

```bash
cd firetv-app
./gradlew assembleDebug
```

### Or grab a pre-built APK from CI

If you don't want to install Android Studio at all, the
[Fire TV APK workflow](../.github/workflows/firetv-apk.yml) builds the same
APK on every push to `main` that touches `firetv-app/`. To download it:

1. Open the repo on GitHub → **Actions** tab → pick the latest **Fire TV
   APK** run.
2. Scroll to **Artifacts** at the bottom → download
   **`albatross-firetv-debug-apk`** (a zip containing `app-debug.apk`).
3. Unzip and continue with the sideload steps below.

You can also rebuild on demand from the same Actions page via the **Run
workflow** button — useful for the first install before any changes have
landed.

---

## Install on Fire TV

### 1. Enable developer options on the Fire TV

- **Settings → My Fire TV → About** — click on the device name (Fire TV
  Stick / Cube / etc.) **7 times** until "No developer options needed" or a
  "Developer options" entry appears.
- **Settings → My Fire TV → Developer options** → set:
  - **ADB debugging** → ON
  - **Apps from Unknown Sources** → ON (and confirm the warning)

### 2. Find the Fire TV's IP address

**Settings → My Fire TV → About → Network**. Note the IP (e.g.
`192.168.1.42`).

### 3. Install the APK over ADB

From a computer on the same network:

```bash
adb connect 192.168.1.42:5555
adb install firetv-app/app/build/outputs/apk/debug/app-debug.apk
```

The first `adb connect` may pop a prompt **on the Fire TV** asking to allow
the computer — accept it.

### 4. Launch

On the Fire TV home screen → **Your Apps & Channels → See All** → scroll to
**Albatross** (or look on the main home row a moment later — Fire OS picks
up apps with the leanback launcher intent automatically).

---

## First-run config

On first launch the app shows a two-field picker:

- **Tailscale (recommended)** — pre-filled with `https://albatross`, which
  is the default magicDNS hostname provisioned when you set up Tailscale
  Serve. Requires the Tailscale app to be installed and signed in on the
  Fire TV.
- **LAN address** — e.g. `http://192.168.1.50:8080` (the Jetson's LAN IP on
  the streaming UI port). No Tailscale needed; both devices just need to be
  on the same Wi-Fi.

Press the button next to the field you want to use. Both URLs are saved
between launches.

To switch the active URL later, press the **Menu** button on the Fire TV
remote (the three-line "hamburger" button) — the picker reopens.

---

## What the wrapper does for the web app

| Concern              | How it's handled                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| D-pad / OK / Back    | Forwarded to the WebView as standard `keydown` events; `tv-nav.js` already understands them.    |
| Hardware Back button | `webView.goBack()` → triggers `popstate` → `tv-nav.js`'s history-sentinel back-stack.           |
| `<video>` fullscreen | `WebChromeClient.onShowCustomView` swaps the WebView for a full-screen container.               |
| Mixed / cleartext    | `usesCleartextTraffic="true"` + network security config allow plain-HTTP LAN URLs.              |
| Autoplay             | `setMediaPlaybackRequiresUserGesture(false)` — the curtain / loading flow can start playback.   |
| `localStorage`       | `setDomStorageEnabled(true)` — required for resume-position, TV-mode flag, settings, etc.       |
| Immersive            | System bars hidden via `WindowInsetsController` (API 30+) or `SYSTEM_UI_FLAG_*` fallbacks.      |
| Keep screen on       | `FLAG_KEEP_SCREEN_ON` so a long movie does not trigger the Fire TV screensaver.                 |
| Auto-detect TV mode  | The WebView UA contains the Fire TV model code (`AFT…`); `tv-nav.js` matches it and turns on.   |

---

## Not included

- **Release signing.** The build above produces a debug-signed APK, which
  is fine for sideloading on your own Fire TV. Submitting to the Amazon
  Appstore (which is not required for personal use) needs a release
  keystore and a separate signing config.
- **Auto-update.** The APK has no in-app updater. Rebuild and re-install
  when the wrapper itself changes; the web UI updates whenever your Jetson
  server updates, no APK rebuild needed.
- **Tailscale.** The Tailscale Android client is a separate APK from the
  Amazon Appstore (or sideload). Install it once and sign in before
  selecting "Connect via Tailscale".
