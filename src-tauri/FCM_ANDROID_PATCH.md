# FCM Android patch (re-apply after `tauri android init`)

`src-tauri/gen/` is gitignored — `tauri android init` generates the Android project on demand, and these
native-side Firebase modifications are NOT recovered from a fresh checkout. This file is the source of
truth. Re-apply all changes below after regenerating the Android project (or when bumping the Tauri
version). The browser/backend builds are unaffected.

The edits live in four persistent (non-`generated/`) files plus two new Kotlin files. **Never** edit
anything under `gen/android/app/src/main/java/com/soms/app/generated/` or any `tauri.*.gradle.kts`
— they carry `AUTO-GENERATED` headers and are overwritten.

## Prerequisites (one Firebase project)

1. Create a Firebase project. Add an **Android app** with package name `com.soms.app` (matches
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

### 4. `gen/android/app/src/main/java/com/soms/app/MainActivity.kt`

Replace the stock 11-line `MainActivity` with the version that:
- captures the cold-start deep-link `EXTRA_THREAD_ID` into `DeepLinkState` in `onCreate`,
- flips `SomsMessagingService.appInForeground` in `onResume`/`onStop`,
- injects the pending deep link via `evaluateJavascript` in `onResume`,
- routes `onNewIntent` (warm-start) deep links to the live webview,
- attaches the `@JavascriptInterface` named `SomsFcm` (token + permission) in `onResume`.

See the current on-disk `MainActivity.kt` for the canonical text.

### 5. New Kotlin files in `com.soms.app`

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
- `res/values-zh-rCN/strings.xml` — 简体中文 variants. Android picks per device locale automatically;
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

## Release signing (optional — needed only to install a *release* APK)

`make apk` produces `app-universal-release-unsigned.apk` by default; Android won't install an
unsigned build. For a quick installable test build, build debug instead (`--debug`, auto-signed by
the Android debug keystore — no setup). For a signed *release* build, wire a signing config:

1. Generate a keystore (do this once; keep the file + passwords safe — it is your signing identity):
   ```
   keytool -genkeypair -keystore src-tauri/gen/android/app/soms-release.keystore \
     -alias soms -keyalg RSA -keysize 2048 -validity 10000 \
     -storepass <STOREPASS> -keypass <KEYPASS> -dname "CN=SOMS, O=SOMS"
   ```
2. `src-tauri/gen/android/keystore.properties` (gitignored — secrets):
   ```
   storeFile=app/soms-release.keystore
   storePassword=<STOREPASS>
   keyAlias=soms
   keyPassword=<KEYPASS>
   ```
3. In `gen/android/app/build.gradle.kts`, load `keystore.properties` and add a `signingConfigs.release`
   pointed at it, then set `buildTypes.release.signingConfig = signingConfigs.release`. Load guards on
   the file's presence so unsigned builds still work when it's absent.

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
