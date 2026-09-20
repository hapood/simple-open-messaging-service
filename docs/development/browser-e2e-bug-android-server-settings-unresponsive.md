# BUG: Android Server Settings Button Does Not Open Configuration

## Complete Server-Configuration Flow — 2026-09-20 13:06 UTC

**PASS for the tested flow; earlier failed-tap reports remain unexplained.**
This run used the already-active OTA frontend at the start, not the embedded
frontend. It does not establish that every previous failure was an OTA issue.

- Initial runtime: `main-TFPJDXR5.js`, active version
  `local-ui-20260812-0818`, with unreachable `qifa.io` / `192.168.88.208:3000`.
- Brought the device to the foreground and confirmed document visibility.
  Closed the existing modal and reopened server settings using actual ADB taps.
- Focused/selected the address field via CDP; entered
  `http://127.0.0.1:3101` using Android input, then tapped the submit button.
  No Angular handler or native configuration command was invoked directly.
- Compatibility validation succeeded. The second-server confirmation displayed
  primary `http://alpha.test:7667` and secondary `http://127.0.0.1:3101`.
  Tapped **Save both addresses**.
- The normal flow persisted both addresses, installed the server's OTA bundle,
  and navigated to `/auth/qr`, with a rendered login QR code and expiry timer.
- Final runtime: `main-GO3DQRLS.js`, active version `0.1.0-alpha.0`, SHA-256
  `8b6b1246dae73f6afa2fcb55886911c58dbc8bc362ee9fac3290f9e4baaf3ea3`.
- Force-stopped and relaunched the app; it again reached `/auth/qr` with a
  fresh QR code, confirming the configuration survives a cold start.
- Local screenshots: `.tmp/android-dialog/server-pair-confirm.png` and
  `.tmp/android-dialog/server-config-complete.png`.
- The device is intentionally left configured for the alpha lab. The secondary
  loopback address uses the existing ADB reverse mapping on port 3101.
  Account authentication and subsequent business flows were not performed.

## Earlier Failure Report

## Status

**Reproduced on 2026-09-20 with the APK embedded frontend.**
Testing stopped at this credible Android navigation defect. The retained-OTA
investigation is a separate deployment caveat and does not invalidate this
reproduction.

## Follow-up Findings

- The package data root had no `web/active.json` or active OTA bundle during the
  final run, so WebView used the embedded APK assets.
- The error page displayed an enabled `服务器设置` button and the configured
  primary and secondary origins.
- Tapping `(640, 1435)`, pressing Enter, and tapping again left the same error
  page in place. The UI tree still had no configuration fields.
- No JavaScript, WebView, or native navigation exception appeared in logs.
- Source contains the `/config` route and `RouteService.redirect` mapping, so
  this is a shipped Android navigation failure rather than a missing route.
- No origin, credential, or user data was cleared.

The earlier retained-OTA run is retained only as a deployment caveat: a
 different frontend behaved differently, so every Android run must record the
 actual asset source.

## Environment

- Device: Huawei RVL-AL09 tablet
- Android: 9 / SDK 28
- WebView: `com.google.android.webview 126.0.6478.188`
- Package: `com.soms.client`
- APK: `src-tauri/dist/android/soms-0.1.0-alpha.0-debug-arm64-v8a.apk`
- Reproduction APK SHA-256: `c45b6798dbd5d34e7a703a045911ecc33e6f1971366a02b6c5eb684731b52dfb`
- Test edge reverse mappings: `3101`, `3102`, `3103`
- App activity: `com.soms.client/.MainActivity`

## Reproduction Steps

1. Install and launch the current debug APK.
2. Wake and unlock the device. The device has no PIN or pattern.
3. Leave the retained server configuration pointing at an unreachable server.
4. On the SOMS connection error page, tap the visible `服务器设置` button.
5. Wait at least three seconds and inspect the WebView and UI hierarchy.
6. Repeat the tap once after the page remains visible.

## Expected Result

The application opens the server configuration page/dialog, allowing the user
to replace the primary and secondary origins and retry the connection.

## Actual Result

The button is visible and enabled, but tapping its center does not navigate or
open a dialog. The page remains on the connection error screen and still shows
the retained old origins:

- Primary: `qifa.io HTTPS`
- Secondary: `192.168.88.208:3000 HTTP`
- Error: `无法连接服务器，请检查地址或重新配置。`

The UI hierarchy continued to expose the same `服务器设置` button after two
separate taps and a three-second wait. The button was enabled and clickable at
`[456,1380][821,1491]`.

On the reproduced run, the new APK was installed, the device was explicitly
unlocked, and `com.soms.client/.MainActivity` was foreground. The SOMS WebView
rendered normally, but tapping the button did not change the route or UI
hierarchy: no configuration form fields or save control appeared.

## Historical Evidence and Exclusions (Superseded)

- Android was unlocked and the SOMS activity was foregrounded.
- The WebView rendered the application normally; there was no crash or fatal
  exception.
- The Android reverse mappings were present for ports `3101` through `3103`.
- The app-private origin files were separately verified to contain the lab
  addresses, so the initial stale URL came from retained runtime preference
  state, not an `adb` write failure.
- The browser entry smoke passed on all three lab edges, and the backend E2E
  regression suite passed 15/15 in the same run.
- This is therefore an Android UI/navigation defect, not a backend outage, a
  lock-screen issue, or an adb installation/reverse-mapping issue.

## Impact

When a native client retains an unreachable server address, the user cannot
reach the recovery configuration flow from the visible error screen. The app
cannot be redirected to a reachable server without external device-state
manipulation.

## Original Suggested Investigation Boundary

Inspect the error-page action binding and native WebView event/navigation bridge
for the `服务器设置` action. The current working-tree handler uses the existing
configuration route, but Android still shows no route change. Verify whether
the native WebView receives the click and whether `/config` is blocked while
the connection-error state is active.
