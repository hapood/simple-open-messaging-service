# Android Lab Testing Notes

Reusable, device-independent lessons from Android lab testing sessions. Each
section states what to do and why. Device-specific run records live beside this
file (for example `android-device-3MFBB22103207361.md`).

## Configure the app to a reachable LAN IP, not the advertised domain

- Lab nodes are reached over the host LAN IP (for example
  `http://192.168.88.208:3101` for node alpha). `/client/compat` must return
  HTTP 200 for the address before configuring the app.
- `/client/compat` also advertises the deployment's canonical public origin
  (commonly `http://<domain>:7667`). That domain usually does not resolve on
  the test LAN, so accepting the advertised pair leaves the app unable to
  connect. Always decline the "发现第二服务器" pair modal with
  "仅保存主地址": despite the wording, it keeps only the just-probed reachable
  address (see `singleOriginAfterDecliningPair` in
  `web/src/app/pages/server-config-page/server-config-page.component.ts`) and
  discards the unresolvable domain.
- Verify the persisted origin has exactly one entry:
  `adb -s <serial> shell run-as com.soms.client cat api_origin`.
- A device configured for `http://localhost:3101` only works while an
  `adb reverse tcp:3101 tcp:3101` exists. Stale configs of this shape survive
  `install -r` updates and look like a logged-in app stuck on
  "连接中断——正在重新连接…". Reconfigure through the in-SPA route
  `tauri.localhost/config` or clear app data before the first run of a new
  session.

## WebView tooling conventions

- Set `ANDROID_SERIAL=<serial>` and a per-thread
  `ANDROID_WEBVIEW_DEVTOOLS_PORT` (use 9223 when another thread owns 9222).
  The device endpoint appears as `webview_devtools_remote_<pid>` in
  `/proc/net/unix`; forward it with
  `adb -s <serial> forward tcp:<port> localabstract:<socket>`.
- `scripts/android-webview-flow.mjs` snapshots page state and runs the OTP
  login flow; `scripts/android-lab-otp-login.mjs --node alpha --create` creates
  an account and pipes the code on stdin (never pass OTP codes as arguments or
  write them to logs/files).
- CDP `Runtime.evaluate`-based clicks are not user gestures: file-chooser
  inputs (`button.avatar-edit` → system picker) will not open from synthesized
  clicks. Use real `adb shell input tap` for gesture-gated flows and
  CDP clicks for app-internal ones.
- `input tap` takes physical pixels. Multiply WebView CSS coordinates by
  `devicePixelRatio` (Huawei DBY-W09: 640×1024 CSS × 2.5 → 1600×2560).
  Automating the system picker: `uiautomator dump` to
  `/sdcard/ui.xml`, find the item `content-desc`/bounds, tap its center. Tap
  the grid item, not its preview entry, otherwise the gallery photo viewer
  opens instead of returning the file.
- In-page `fetch()` to the backend origin fails from the `tauri.localhost`
  WebView origin (cross-origin; app traffic rides the native HTTP bridge), so
  server-side assertions should be verified read-only against the lab database
  or via the native log (`run-as com.soms.client files/soms-native.log`).

## Session-restore test semantics

- Background (`KEYCODE_HOME`), lock/unlock (`KEYCODE_SLEEP`/`KEYCODE_WAKEUP`
  plus shade dismissal), and force stop (`am force-stop`) each prove different
  things. Only force stop is a cold start; a successful force-stop restore
  says nothing about background push delivery — never use it as push evidence.
- The native log distinguishes the states: `onStop → appInForeground=false`,
  foreground-service promotion (`action=…BACKGROUND`), stream reuse
  (`openStream no-op`), and reconnect with fresh `startId` after force stop.
