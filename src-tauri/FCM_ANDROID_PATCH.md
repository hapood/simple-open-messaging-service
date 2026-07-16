# FCM Android native side (reference)

> **Status (2026-07):** `gen/android/` is now **version-controlled** (Tauri's default — only
> `gen/schemas` is gitignored). All patches below are committed in-tree, so they survive a fresh clone
> and **no longer need re-applying** after `tauri android init`. This file is now a *reference* for what
> the native side contains and the invariants that must hold — not a re-apply runbook. The "re-apply"
> guidance below applies only if you deliberately regenerate `gen/android` (e.g. a Tauri major bump).

Historically `gen/` was fully gitignored and `tauri android init` regenerated the Android project on
demand, losing these native-side modifications — hence the original "re-apply" framing. The
browser/backend builds are unaffected by all of the below.

The edits live in four persistent (non-`generated/`) files plus two new Kotlin files. **Never** edit
anything under `gen/android/app/src/main/java/com/soms/client/generated/` or any `tauri.*.gradle.kts`
— they carry `AUTO-GENERATED` headers and are overwritten.

## Prerequisites (one Firebase project)

1. Create a Firebase project. Add an **Android app** with package name `com.soms.client` (matches
   `app/build.gradle.kts` `applicationId` and `src-tauri/tauri.conf.json` `identifier`).
2. Download `google-services.json` → drop at `gen/android/app/google-services.json` (gitignored).
3. Register the debug **and** release signing-key SHA-1 in the console app's "SHA certificate
   fingerprint" — without it, FCM token retrieval silently fails.
4. Backend: Project Settings → Service Accounts → "Generate new private key" → set
   `GOOGLE_APPLICATION_CREDENTIALS=/abs/path/to/sa.json` in the backend `.env`.

## Patches

### 1. `gen/android/build.gradle.kts` (root)

Add the google-services plugin classpath to `buildscript.dependencies`:

```kotlin
classpath("com.google.gms:google-services:4.4.2")
```

### 2. `gen/android/app/build.gradle.kts`

In `plugins {}`, apply the plugin:

```kotlin
id("com.google.gms.google-services")
```

In `dependencies {}`, add the Firebase BOM + messaging:

```kotlin
implementation(platform("com.google.firebase:firebase-bom:33.4.0"))
implementation("com.google.firebase:firebase-messaging")
```

### 3. `gen/android/app/src/main/AndroidManifest.xml`

- Add the permission: `<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />`
- Inside `<application>`, register the service:

```xml
<service
    android:name=".SomsMessagingService"
    android:exported="false">
    <intent-filter>
        <action android:name="com.google.firebase.MESSAGING_EVENT" />
    </intent-filter>
</service>
```

### 4. `gen/android/app/src/main/java/com/soms/client/MainActivity.kt`

Replace the stock 11-line `MainActivity` with the version that:
- captures the cold-start deep-link `EXTRA_THREAD_ID` into `DeepLinkState` in `onCreate`,
- flips `SomsMessagingService.appInForeground` in `onResume`/`onStop`,
- injects the pending deep link via `evaluateJavascript` in `onResume`,
- routes `onNewIntent` (warm-start) deep links to the live webview,
- attaches the `@JavascriptInterface` named `SomsFcm` (token + permission) in `onResume`.

See the current on-disk `MainActivity.kt` for the canonical text.

### 5. New Kotlin files in `com.soms.client`

- `SomsBridge.kt` — process-global bridge: the live webview reference (set by
  `MainActivity.onWebViewCreate`), a UI-thread `eval()` helper, a `jsonStr()` escaper, and two nested
  holders: `SomsBridge.FcmToken.current` and `SomsBridge.DeepLink.pendingThreadId`.
- `SomsMessagingService.kt` — `FirebaseMessagingService` subclass. `onMessageReceived` posts a per-thread
  `NotificationCompat` (channel `messages`, grouped by thread) unless `appInForeground`, then advances
  the shared dedup cursor (`SomsSecureStore.advanceCursor`) so the worker doesn't re-notify; `onNewToken`
  stashes the token in `SomsBridge.FcmToken` and emits `window.__SOMS_FCM_TOKEN__(token)` to the webview.
  Also exposes `notifyMissed` / `notifyMissedSummary` for the WorkManager poller path (localized strings).
- `SomsSecureStore.kt` — EncryptedSharedPreferences wrapper holding the notification token, api origin,
  and the per-thread dedup cursor (JSON map threadId → latestMessageId). Read by the worker; written by
  the JS bridge (token + origin) and both push paths (cursor).
- `NotificationSyncWorker.kt` — `CoroutineWorker`, ~6h periodic. Skips when foreground/logged-out/no
  origin; OkHttp-POSTs `/notifications/missed` with the notification token; posts a localized local
  notification per fresh thread (or an aggregated summary when many), advancing the shared cursor.

The webview reference is obtained from `WryActivity.onWebViewCreate` (the idiomatic Tauri v2 hook), not
a view-tree walk. `MainActivity` adds a `@JavascriptInterface` named `SomsFcm` (`getToken()`,
`requestToken()`, `requestNotificationPermission()`, `setNotificationToken(token)`,
`setApiOrigin(origin)`) in `onWebViewCreate`, flips `SomsMessagingService.appInForeground` in
`onResume`/`onStop`, captures cold-start deep links in `onCreate`, routes warm-start links in
`onNewIntent`, and enqueues the periodic `NotificationSyncWorker` (unique work `soms-notif-sync`, KEEP)
in `onCreate`.

### 6. New gradle deps (app/build.gradle.kts)

```kotlin
implementation("androidx.work:work-runtime-ktx:2.10.0")        // NotificationSyncWorker
implementation("androidx.security:security-crypto:1.1.0-alpha06") // EncryptedSharedPreferences
implementation("com.squareup.okhttp3:okhttp:4.12.0")            // worker HTTP POST
```

### 7. New i18n resources

- `res/values/strings.xml` — `notif_missed_one` / `notif_missed_many` (English).
- `res/values-zh-rCN/strings.xml` — Simplified Chinese variants. Android picks per device locale automatically;
  `ctx.getString(R.string.notif_*)` resolves to the right one with no explicit branching. Wording
  mirrors `web/src/app/i18n/{en,zh-CN}.json notif.*` for cross-surface consistency.

## Compile invariants (these broke a release build — keep them on re-apply)

`tauri android init` regenerates `gen/android`, so any hand-written Kotlin there is lost. The two
files below currently have fixes that are NOT obvious from the surrounding code; re-create them this
way (the on-disk files are canonical, these are the rules that must hold):

- **`MessageSyncService.kt`** extends `android.app.Service` → it MUST override `onBind` (the base
  member is abstract), or `compileUniversalReleaseKotlin` fails with "does not implement abstract
  base class member onBind". Add:
  ```kotlin
  override fun onBind(intent: Intent?): IBinder? = null   // bound mode unused (started FGS)
  ```
  (and `import android.os.IBinder`). This file is the domestic `dataSync` foreground service
  (native SSE to `/notifications/stream`, the mainland-China real-time path with no FCM); it is NOT
  in the original §5 list — add it when re-applying.
- **`SomsMessagingService.parseSnapshotArray`** — the per-item `JSONObject` loop local MUST NOT be
  named `it`. Inside `mid.takeIf { … }` the implicit `it` is `mid` (a String), so `it.has(...)` /
  `it.isNull(...)` fail with "Unresolved reference". Name it `obj` (or anything but `it`):
  ```kotlin
  val obj = arr.optJSONObject(i) ?: continue
  …
  latestMessageId = mid.takeIf { obj.has("latestMessageId") && !obj.isNull("latestMessageId") && mid.isNotEmpty() },
  ```

- **`MainActivity.fetchFcmToken` MUST guard the Firebase call** when the `google-services` plugin is off
  (the "TEMPORARILY OFF" build). Without the plugin + `google-services.json`, the default `FirebaseApp` is
  never auto-initialized, so the bare `FirebaseMessaging.getInstance()` call throws
  `IllegalStateException: Default FirebaseApp is not initialized` from `onCreate → maybeFetchFcmToken →
  fetchFcmToken` and the app crashes instantly on launch (verified via `adb logcat` on the x86_64
  emulator). The guard is the single line below; it makes the build push-optional (runs without FCM) and
  is a no-op once Firebase is enabled. `SomsMessagingService` needs no guard — the system only invokes it
  on a real FCM event, which can't fire without an initialized FirebaseApp.
  ```kotlin
  private fun fetchFcmToken() {
      if (com.google.firebase.FirebaseApp.getApps(this).isEmpty()) return  // push-optional guard
      FirebaseMessaging.getInstance().token.addOnCompleteListener { … }
  }
  ```

## Release signing (optional — needed only to install a *release* APK)

The signing config is **already wired** in `gen/android/app/build.gradle.kts`: it loads
`keystore.properties` when present and applies a `signingConfigs.release` to the release build type
(absent file → unsigned release, which Android won't install). Debug builds auto-sign with the stable
debug keystore the Makefile generates (see README §Android build). To produce an installable **release**
APK, provide the two secret files (both gitignored):

1. Generate the release keystore once (keep it + the passwords safe — it is your signing identity):
   ```
   keytool -genkeypair -keystore src-tauri/gen/android/app/soms-release.keystore \
     -alias soms -keyalg RSA -keysize 2048 -validity 10000 \
     -storepass <STOREPASS> -keypass <KEYPASS> -dname "CN=SOMS, O=SOMS"
   ```
2. `src-tauri/gen/android/keystore.properties`:
   ```
   storeFile=app/soms-release.keystore
   storePassword=<STOREPASS>
   keyAlias=soms
   keyPassword=<KEYPASS>
   ```

Both files are secrets — back them up out-of-band; a fresh clone needs them restored before a signed
release build.

## IPC contract (webview ↔ Kotlin)

| Direction | Carrier | Mechanism |
|---|---|---|
| Kotlin → JS (token rotation, warm deep link) | `WebView.evaluateJavascript` calling a global hook (`window.__SOMS_FCM_TOKEN__`, `window.__SOMS_DEEP_LINK__`) | Mirrors the origin init-script pattern |
| JS → Kotlin (token read, permission request) | `@JavascriptInterface` named `SomsFcm`, attached in `onResume` | Mirrors `Ipc.kt`'s `@JavascriptInterface` pattern |
| JS → backend (register HTTP) | `POST /api/v1/devices/register` | standard |

No `@tauri-apps/api` dependency, no Tauri event permission, no custom Rust plugin — the bridge reuses
the codebase's existing global-injection + `@JavascriptInterface` style.

## Data-only payload contract

The backend (`PushService.dispatchForMessage`) sends data-only, `android.priority: high` messages:

```
{ threadId, messageId, contentType, ts[, preview] }
```

`preview` is included only for `PURE_TEXT` (truncated to 120 chars). No `notification` field — the
client builds the visible notification from this data so the canonical Message row stays the single
source of truth and `onMessageReceived` is always invoked (even when the OS has killed the app).

## Hardware-back bridge

Hardware-back is routed to the web nav state machine (`NavStateMachineService`), which peels one layer
(pane → aside → chat → home) and finishes the activity when the stack is empty. This replaces the default
(WryActivity's webview-history traversal, disabled via `TauriActivity.handleBackNavigation = false`).

| Direction | Carrier | Mechanism |
|---|---|---|
| Kotlin → JS (hardware-back press) | `OnBackPressedDispatcher` callback in `MainActivity.onCreate` → `SomsBridge.eval("window.__SOMS_BACK__ && window.__SOMS_BACK__();")` | Same `evaluateJavascript`-global-hook pattern as the token/deep-link emissions |
| JS → Kotlin (exit at home) | `@JavascriptInterface` named `SomsBack` (`exit()`), attached in `onWebViewCreate` | Same `@JavascriptInterface` pattern as `SomsFcm`; `exit()` finishes the activity on the UI thread |

JS registers `window.__SOMS_BACK__` at boot (`AppComponent`, gated `isTauri() && isAndroid()`): it calls
`nav.back()`; if that returns `false` (at home), it calls `window.SomsBack.exit()`. Desktop/browser have no
native back — history is flat, so browser-back exits there.

## Safe-area inset bridge (status bar / gesture bar)

Android WebView is drawn edge-to-edge (`enableEdgeToEdge()` in `MainActivity.onCreate`), so the system
status bar overlays the top of the web content. `env(safe-area-inset-top)` returns **0** in Android
WebView (it forwards cutout insets, not the status bar), so the web layer can't learn the inset from CSS
alone. The native shell measures it and injects it.

| Direction | Carrier | Mechanism |
|---|---|---|
| JS → Kotlin (read insets) | `@JavascriptInterface` named `SomsShell` (`getSafeInsets()`), attached in `onWebViewCreate` | Same `@JavascriptInterface` pattern as `SomsFcm`/`SomsBack` |
| Kotlin → JS (inset change, e.g. rotation) | `WebView.evaluateJavascript` setting `--soms-safe-top`/`--soms-safe-bottom` on `:root` | Same `evaluateJavascript` pattern as the token/deep-link emissions |

- `MainActivity.installInsetsListener()` (called from `onCreate`) registers a
  `ViewCompat.setOnApplyWindowInsetsListener` on `android.R.id.content`. It reads
  `WindowInsetsCompat.Type.statusBars().top` + `navigationBars().bottom` (device px), divides by
  `resources.displayMetrics.density` → integer CSS px, and stores them in `@Volatile` fields
  (`safeInsetTopCss` / `safeInsetBottomCss`). Per-device — never a hardcoded constant (Huawei =
  80dp ÷ 2.5 = 32px; other devices differ).
- The listener fires on the first layout pass (~1 frame after attach, well before the page finishes
  loading) and on every inset change (rotation).
- `SomsShell.getSafeInsets()` returns JSON `{"top":int,"bottom":int}`. The web app reads it in
  `main.ts` **before `bootstrapApplication()`** (`applySafeInsets()` in `services/runtime.ts`) and sets
  `--soms-safe-top`/`--soms-safe-bottom` on `:root` — so the first Angular paint already has the inset
  (FOUC-free). The listener's `evaluateJavascript` covers later changes (rotation) without a reload.
- CSS default (`web/src/app/assets/_tokens.scss`): `--soms-safe-top: env(safe-area-inset-top, 0px)` —
  correct for the browser/iOS-PWA build (which forward `env()`), so no native bridge is needed there.
  Consumed by the auth shell (`assets/utils.scss`) and the app shell to pad content below the status bar.

## 8. Dev-tools floating overlay (apk-dev only)

A draggable floating button + native dialog for the on-device frontend dev loop: load a frontend dev
server, refresh the page, revert to the bundled app. Not FCM-related, but it lives in the same
gitignored `gen/android` tree, so it is re-applied here. Dev-server-build-only — it ships solely in the
Makefile's `apk-dev` target. The dev-tool code is **physically excluded** from every other build at
packaging time (not runtime-gated): a build-time source-set swap compiles either a real implementation
(`src/dev-real`) or a no-op stub (`src/dev-stub`), so apk-debug and release contain zero dev-tool code,
classes, or resources — no `BuildConfig` flag, no R8 needed. This mirrors the web's
`dev-tools.ts` ↔ `dev-tools.prod.ts` fileReplacements.

### `src/dev-real/` — compiled ONLY by `apk-dev` (SOMS_DEV_TOOLS=1)

- `java/com/soms/client/DevTools.kt` — `object DevTools` with the real `attach(activity)` / `detach(activity)`.
  `attach` is the relocated ex-`MainActivity.attachDevToolsBubble`: it builds the bubble's `WindowManager`
  sub-window and adds it. `detach` removes it (`onDestroy` calls it). Holds the `bubbleView` field.
- `java/com/soms/client/DevToolsBubble.kt` — an `ImageView` in its OWN `WindowManager` window
  (`TYPE_APPLICATION_PANEL`), NOT in `android.R.id.content`. Tauri replaces the content container when it
  sets up the webview, which discarded a content-attached bubble a few seconds after launch (once the page
  rendered). A separate sub-window is independent of the content container (survives the swap) and draws
  above the activity's content (the webview). No `SYSTEM_ALERT_WINDOW` permission — it's a sub-window of
  our own activity. Drag repositions the window (`params.x/y` + `updateViewLayout`, clamped to the
  display); a tap opens `DevToolsDialog`.
- `java/com/soms/client/DevToolsDialog.kt` — a framework `AlertDialog` (no Material dep). Owns the persisted
  `dev_url` file (data-dir root `dev_url`) and drives the live webview via `SomsBridge.eval` (no Rust
  commands, no JS bridge):
    - Connect → validate http(s) → write `dev_url` → `location.replace(url)` (immediate; persists for
      next launch).
    - Reload → `location.reload()` (the dialog stays open — repeatable).
    - Revert → delete `dev_url` → `Process.killProcess` (relaunch → Rust re-resolves to the bundle).
- `res/drawable/dev_bubble_bg.xml` — translucent circular background for the bubble.
- `res/drawable/ic_dev_tools.xml` — Material "build" (wrench) glyph, white.

### `src/dev-stub/` — compiled by every build EXCEPT `apk-dev`

- `java/com/soms/client/DevTools.kt` — `object DevTools` with no-op `attach` / `detach`. This is the twin
  that lets `MainActivity`'s unconditional `DevTools.attach(this)` / `DevTools.detach(this)` calls compile
  in builds that contain no dev-tool code. Both files define the same `object DevTools`, so the
  build.gradle.kts source-set swap compiles EXACTLY ONE — never both (duplicate class), never neither
  (`MainActivity` wouldn't compile).

### `MainActivity.kt` wiring (in `src/main/` — always compiled)

- `onWebViewCreate` and `onResume` call `DevTools.attach(this)`; `onDestroy` calls `DevTools.detach(this)`.
  These calls are unconditional — no `BuildConfig` gate, no import of `WindowManager`/`Gravity`/`PixelFormat`
  (those moved into `src/dev-real/DevTools.kt`). In stub builds the calls resolve to the no-op object; in
  `apk-dev` to the real one. The attachment timing is unchanged (onWebViewCreate + onResume + onDestroy).
- `captureWebView()` / `firstWebView()` STAY in `MainActivity` (they're general — `onResume` calls
  `captureWebView()` unconditionally to catch the webview-registration race, independent of dev tools);
  `captureWebView` is `internal` so `src/dev-real/DevTools.kt`'s bubble-tap lambda can call
  `activity.captureWebView()`.

### Source-set swap (`app/build.gradle.kts`)

`sourceSets.main` adds `src/dev-real/{java,res}` when `System.getenv("SOMS_DEV_TOOLS") == "1"`, else
`src/dev-stub/java`. The Makefile's `apk-dev` is the only target that exports `SOMS_DEV_TOOLS=1`. Each
`make apk-*` runs in its own `--rm` container, so the env is fresh per build (no stale gradle-daemon
state). `isShrinkResources = true` stays on release as a general resource optimization; it needs no
dev-tool-specific handling because the dev-tool drawables are never compiled into a release.

### Rust contract (`src-tauri/src/lib.rs` — NOT gitignored, persists across `tauri android init`)

`const DEV_URL_FILENAME: &str = "dev_url"` (must match Kotlin's `DevToolsDialog.DEV_URL_FILENAME`). At
boot, in debug builds only, the webview URL resolves in this precedence: persisted `dev_url` file →
`SOMS_DEV_URL` env → `option_env!("SOMS_DEFAULT_DEV_URL")` (compiled-in default) → desktop `devUrl` →
bundled `index.html`. Release always bundles (the whole branch is `cfg!(debug_assertions)`-gated — a
runtime-remote frontend would be an arbitrary-code-execution surface). No Rust commands: the dialog
acts on the webview directly via `SomsBridge.eval`.

### Path invariant

The persisted file is the app's data-dir ROOT `dev_url` — Rust reads `app_data_dir()/dev_url`
(`src-tauri/src/lib.rs`), which on Android is `/data/data/com.soms.client/` (the root, where
`api_origin` also lives); Kotlin writes the same root via `Context.dataDir` (`DevToolsDialog.kt`).
(Earlier this used `filesDir` = `.../files/`, a different directory Rust never reads — a Connect'd URL
did not persist. `dataDir` == `app_data_dir()` root fixes it.) Verify on the device:
`adb shell run-as com.soms.client ls -l dev_url`.

### Makefile (`src-tauri/Makefile` — NOT gitignored)

`make apk-dev ABI=aarch64 DEV_URL=http://host:port` — a debug build that bakes the URL via
`docker -e SOMS_DEFAULT_DEV_URL=..` (Rust `option_env!` reads it at compile time) AND exports
`-e SOMS_DEV_TOOLS=1` (gradle's `sourceSets.main` reads it → compiles `src/dev-real` — the real bubble —
instead of the `src/dev-stub` no-op; see §8), output `soms-<ver>-dev-<abi>.apk`. The dev server must be
reachable from the device: `npm --prefix web run start -- --host 0.0.0.0`.
